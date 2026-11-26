#!/usr/bin/env node
/**
 * ALIO RAG MCP — HTTP 전송 (Streamable HTTP 하위집합)
 *
 * 왜 필요한가(2026-09-21): stdio 판은 클라이언트가 «DB 자격증명을 직접» 들고 있어야 해서
 * 남에게 줄 수 없었다. HTTP 로 올리면 자격증명이 서버에만 남고 이용자는 URL 만 받는다.
 * 참조 구현 = `korean-law`(게이트웨이가 토큰을 주입하고 MCP 서버는 127.0.0.1 로만 공개).
 *
 * 설계 원칙
 *   · 무의존성 — node 내장 http 만 쓴다(공개 저장소라 감사 가능해야 한다).
 *   · 프로토콜 처리는 `mcp_server.js` 의 `dispatch()` 하나만 쓴다 —
 *     전송을 늘려도 동작이 갈라지지 않는다.
 *   · 상태 없음 — 도구가 전부 요청/응답이라 세션이 필요 없다.
 *     그래서 `Mcp-Session-Id` 를 요구하지 않는다(스펙상 허용).
 *
 * 구현한 것 / 안 한 것
 *   ✅ POST /mcp   JSON-RPC 단건·배치 → application/json
 *   ✅ GET  /health
 *   ❌ GET  /mcp (서버→클라이언트 SSE) — 서버가 먼저 보낼 것이 없어 405.
 *      알림·샘플링·진행률을 넣을 때 추가한다.
 *
 * env
 *   MCP_HTTP_PORT   기본 3000
 *   MCP_HTTP_HOST   기본 0.0.0.0 (컨테이너 안. 호스트 공개는 127.0.0.1 바인딩으로)
 *   ALIO_MCP_TOKEN  설정하면 `Authorization: Bearer <값>` 을 요구한다.
 *                   비우면 «인증 없음» — 게이트웨이 뒤에서만 그렇게 쓸 것.
 *   MCP_MAX_BODY    요청 본문 상한(바이트, 기본 1MB)
 */
'use strict';

const http = require('http');
const { dispatch, pool } = require('./mcp_server.js');

const PORT = parseInt(process.env.MCP_HTTP_PORT || '3000', 10);
const HOST = process.env.MCP_HTTP_HOST || '0.0.0.0';
const TOKEN = (process.env.ALIO_MCP_TOKEN || '').trim();
const MAX_BODY = parseInt(process.env.MCP_MAX_BODY || String(1024 * 1024), 10);
// 사용자 등급 인증(10-19): internal(내부 포트·서비스 토큰) / external(발급 키) / master. RAG API 와 같은 모듈·같은 키 파일을 쓴다(한쪽만 바꾸면 사고).
const { makeAuth } = require('./auth_tier');
const MCP_INTERNAL_PORT = parseInt(process.env.MCP_INTERNAL_PORT || '0', 10);   // 내부 전용 포트 — 게이트웨이·프록시에 노출 금지
const EXT_FILE = process.env.RAG_EXTERNAL_KEYS_FILE || '';
const AUTH = makeAuth({ internalPort: MCP_INTERNAL_PORT, internalCidrs: process.env.INTERNAL_ALLOW_CIDR || '127.0.0.0/8,::1', serviceKey: TOKEN, masterKey: process.env.RAG_MASTER_KEY || '', externalKeysFile: EXT_FILE,
  open: !TOKEN && !EXT_FILE && !MCP_INTERNAL_PORT, scope: 'mcp' });   // 아무 것도 설정하지 않으면 기존대로 «게이트웨이가 책임»
// 10-21 리뷰 #3: MCP 경로에도 한도를 둔다(API 와 같은 값). 배치는 한 요청에 도구 호출을 몰아 넣어 한도를 우회할 수 있어 길이를 제한하고 항목마다 센다. internal·master 는 제외.
const RL_MAX = parseInt(process.env.RATE_LIMIT_PER_MIN || '40', 10), SEM_MAX = parseInt(process.env.SEMANTIC_LIMIT_PER_MIN || '10', 10), MAX_BATCH = parseInt(process.env.MCP_MAX_BATCH || '10', 10);
const rlHits = new Map(), semHits = new Map();
const rlOver = (m, k, max) => { const now = Date.now(), a = (m.get(k) || []).filter(t => now - t < 60000); if (a.length >= max) { m.set(k, a); return true; } a.push(now); m.set(k, a); return false; };
setInterval(() => { const now = Date.now(); for (const m of [rlHits, semHits]) for (const [k, a] of m) if (!a.some(t => now - t < 60000)) m.delete(k); }, 300000).unref();
// 2026-10-26(셀프 서비스 키): 키에 limits(minute·sem_minute·day·sem_day·batch)가 있으면 그 키만 아래 «키별 한도» 로 판정한다. limits 가 없는 키·익명은 위의 전역 한도 코드를 그대로 탄다(동작 불변).
//   일일 카운터는 한국시간(KST) 자정에 초기화. MCP_COUNTER_FILE 이 있으면 작은 JSON 으로 주기 저장(원자적 쓰기) — 읽기 실패·손상은 «카운트 0 에서 시작»(경고 로그), 쓰기 실패는 메모리만으로 계속.
const fs = require('fs');
const COUNTER_FILE = process.env.MCP_COUNTER_FILE || '';
const kstDay = t => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const toKstMidnightSec = t => Math.max(1, Math.ceil((86400e3 - ((t + 9 * 3600e3) % 86400e3)) / 1000));
const dayCnt = new Map(), usedMap = new Map(); let dirty = false, allUsed = false;   // usedMap: 키 id → 최초 인증 성공 시각(분실 키 재신청 판정용). allUsed: 카운터 파일 손상 시 «모든 키 사용됨» 으로 안전하게 표시    // key id → { d: 'YYYY-MM-DD', n, s }
const limHits = new Map(), limSem = new Map();  // 분 창(키 id → 시각 배열)
function loadCounters() {
  if (!COUNTER_FILE) return;
  try { const j = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8')), today = kstDay(Date.now());
    for (const [id, v] of Object.entries(j.c || {})) if (v && v.d === today && Number.isInteger(v.n) && Number.isInteger(v.s) && v.n >= 0 && v.s >= 0) dayCnt.set(id, v);
    for (const [id, ts] of Object.entries(j.used || {})) usedMap.set(id, Number.isFinite(ts) ? ts : Date.now());   // 값이 이상해도 «사용됨» 으로 둔다
    if (j.all_used) allUsed = true;
  } catch (e) {
    if (e.code !== 'ENOENT') { console.error('[mcp-http] 카운터 파일 손상·읽기 실패 — 일일 카운트는 0 에서 시작, 사용 여부는 «모두 사용됨» 으로 표시:', e.message); allUsed = true; }
    dirty = true;   // 없으면 새로 만들고, 손상이면 표시를 남겨 정상 파일로 교체
  }
}
function flushCounters() {
  if (!COUNTER_FILE || !dirty) return; dirty = false;
  try { const today = kstDay(Date.now()), c = {}; for (const [id, v] of dayCnt) if (v.d === today) c[id] = v;
    const tmp = COUNTER_FILE + '.tmp.' + process.pid; const fd = fs.openSync(tmp, 'w', 0o640); fs.fchmodSync(fd, 0o640); fs.writeSync(fd, JSON.stringify({ v: 1, c, used: Object.fromEntries(usedMap), ...(allUsed ? { all_used: true } : {}) })); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, COUNTER_FILE);
  } catch (e) { dirty = true; console.error('[mcp-http] 카운터 저장 실패(메모리로 계속):', e.message); }
}
loadCounters(); flushCounters(); setInterval(flushCounters, 5000).unref();
const markUsed = id => { if (!COUNTER_FILE || usedMap.has(id)) return; usedMap.set(id, Date.now()); dirty = true; flushCounters(); };   // 키당 한 번만 즉시 저장(쓰기 최소화), 실패하면 dirty 로 남겨 주기 저장이 재시도
const dayOf = (id, now) => { let v = dayCnt.get(id); if (!v || v.d !== kstDay(now)) { v = { d: kstDay(now), n: 0, s: 0 }; dayCnt.set(id, v); } return v; };
const winOf = (m, id, now) => { const a = (m.get(id) || []).filter(t => now - t < 60000); m.set(id, a); return a; };
// calls: 이 요청의 tools/call 배열. 한도 초과면 {which,max,retry,text}, 아니면 null 이고 사용량을 기록한다(전부 통과할 때만 기록 — 일부만 세지 않음).
function keyLimited(who, calls, now = Date.now()) {
  const L = who.limits, n = calls.length, s = calls.filter(isSemCall).length; if (!n) return null;
  const e = dayOf(who.id, now), wm = winOf(limHits, who.id, now), ws = winOf(limSem, who.id, now), mMax = L.minute || RL_MAX, sMax = L.sem_minute || SEM_MAX;
  const hit = (which, max, text, retry) => ({ which, max, retry, text });
  if (L.day && e.n + n > L.day) return hit('day', L.day, `일일 호출 한도(${L.day}회)를 넘었습니다. 한국시간 자정에 초기화됩니다.`, toKstMidnightSec(now));
  if (s && L.sem_day && e.s + s > L.sem_day) return hit('sem_day', L.sem_day, `일일 의미검색 한도(${L.sem_day}회)를 넘었습니다. 한국시간 자정에 초기화됩니다.`, toKstMidnightSec(now));
  const wait = (w, max, k) => { const i = w.length + k - max - 1; return i >= 0 && i < w.length ? Math.max(1, Math.ceil((w[i] + 60000 - now) / 1000)) : 60; };   // 창에서 k 건이 빠질 때까지(요청 자체가 한도보다 크면 60)
  if (wm.length + n > mMax) return hit('minute', mMax, `분당 호출 한도(${mMax}회)를 넘었습니다. 잠시 후 다시 시도하세요.`, wait(wm, mMax, n));
  if (s && ws.length + s > sMax) return hit('sem_minute', sMax, `분당 의미검색 한도(${sMax}회)를 넘었습니다. 잠시 후 다시 시도하세요.`, wait(ws, sMax, s));
  for (let i = 0; i < n; i++) wm.push(now); for (let i = 0; i < s; i++) ws.push(now);
  e.n += n; e.s += s; dirty = true; return null;
}
const { clientIp } = require('./client_ip');   // 2026-11-09: XFF_TRUST=legacy 기본 = 종전 동작(첫 항목), strict 이면 신뢰 중계만
const isSemCall = r => r && r.method === 'tools/call' && r.params && r.params.arguments && (r.params.arguments.semantic || r.params.arguments.hybrid);
const bearerOf = h => { const m = /^Bearer\s+(.+)$/i.exec(String(h || '')); return m ? m[1] : ''; };

const log = (...a) => console.error('[mcp-http]', ...a);
const jsonRes = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
                        'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// 🔴 토큰 비교는 길이가 달라도 같은 시간이 걸리게 한다(타이밍 공격 차단).
function tokenOk(header) {
  if (!TOKEN) return true;                       // 미설정 = 게이트웨이가 책임진다
  const m = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  if (!m) return false;
  const a = Buffer.from(m[1]); const b = Buffer.from(TOKEN);
  if (a.length !== b.length) { require('crypto').timingSafeEqual(b, b); return false; }
  return require('crypto').timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY) {
        // 🔴 여기서 req.destroy() 를 하면 «응답을 쓰기 전에» 소켓이 끊겨 클라이언트가 413 을 못 본다
        // (curl 은 000 = 연결 실패로 본다). 읽기만 멈추고, 끊는 것은 응답을 flush 한 뒤에.
        req.pause();
        reject(Object.assign(new Error('본문이 너무 큽니다'), { code: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    return jsonRes(res, 200, { ok: true, service: 'alio-rag-mcp', transport: 'http' });
  }
  if (url !== '/mcp') return jsonRes(res, 404, { error: 'Not Found' });
  // 서버가 먼저 보낼 것이 없다 — 스트리밍이 필요해지면 그때 연다.
  if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }

  const who = AUTH.authTier(req, bearerOf(req.headers.authorization));
  if (!who) {
    return jsonRes(res, 401, rpcErr(null, -32001, 'unauthorized'));
  }

  if (who.tier === 'external' && who.id !== 'anonymous') markUsed(who.id);   // 인증에 성공한 첫 호출을 기록(미사용 키 재신청 허용 판단에 쓰임)
  let raw;
  try { raw = await readBody(req); }
  catch (e) {
    // 남은 업로드를 다 받지 않고 끊되, 413 을 먼저 보낸다.
    res.setHeader('Connection', 'close');
    res.on('finish', () => req.socket && req.socket.destroy());
    return jsonRes(res, e.code === 413 ? 413 : 400, rpcErr(null, -32600, e.message));
  }

  let payload;
  try { payload = JSON.parse(raw); }
  catch { return jsonRes(res, 400, rpcErr(null, -32700, 'parse error')); }
  // 10-21 레드팀 #1·#6·#7: 의미 한도는 mcp_server 와 같은 truthy 기준. NUL(\u0000)·객체 아닌 요소는 DB·dispatch 까지 보내지 않는다(오류 문구에 PG 인코딩 오류가 새고 null 은 500 이 났다).
  if (raw.includes('\\u0000') || !payload || typeof payload !== 'object' || (Array.isArray(payload) && (!payload.length || payload.some(x => !x || typeof x !== 'object' || Array.isArray(x))))) return jsonRes(res, 400, rpcErr(null, -32600, 'invalid request'));

  const maxBatch = (who.limits && who.limits.batch) || MAX_BATCH;   // limits 가 없으면 전역 MAX_BATCH(종전과 같음)
  if (Array.isArray(payload) && payload.length > maxBatch) return jsonRes(res, 400, rpcErr(null, -32600, `배치는 ${maxBatch}건 이하`));
  if (who.tier === 'external' && who.limits) {
    const v = keyLimited(who, (Array.isArray(payload) ? payload : [payload]).filter(r => r && r.method === 'tools/call'));
    if (v) { res.setHeader('Retry-After', String(v.retry)); return jsonRes(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32002, message: v.text, data: { limit: v.which, max: v.max, retry_after: v.retry } } }); }
  } else if (who.tier === 'external') {
    const rk = who.id === 'anonymous' ? clientIp(req) : who.id;
    for (const r of (Array.isArray(payload) ? payload : [payload])) {
      if (!r || r.method !== 'tools/call') continue;
      if (rlOver(rlHits, rk, RL_MAX) || (isSemCall(r) && rlOver(semHits, rk, SEM_MAX))) {
        res.setHeader('Retry-After', '60'); return jsonRes(res, 429, rpcErr(null, -32002, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.'));
      }
    }
  }
  try {
    if (Array.isArray(payload)) {                       // 배치
      const out = [];
      for (const r of payload) { const v = await dispatch(r, who.tier, who.label); if (v) out.push(v); }
      return out.length ? jsonRes(res, 200, out) : (res.writeHead(202), res.end());
    }
    const v = await dispatch(payload, who.tier, who.label);
    if (!v) { res.writeHead(202); return res.end(); }    // 알림 — 응답 본문 없음
    return jsonRes(res, 200, v);
  } catch (e) {
    log('dispatch 오류:', e.message);
    return jsonRes(res, 500, rpcErr(payload?.id, -32603, 'internal error'));
  }
});

if (MCP_INTERNAL_PORT) {
  const s2 = http.createServer(); server.listeners('request').forEach(l => s2.on('request', l));
  s2.listen(MCP_INTERNAL_PORT, process.env.MCP_INTERNAL_HOST || '127.0.0.1', () => log(`내부 전용 포트 ${MCP_INTERNAL_PORT} (토큰 없이 internal)`));
}
server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT}/mcp · auth=${TOKEN ? 'bearer' : '없음(게이트웨이 전제)'}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log(sig, '— 종료'); flushCounters(); server.close(() => pool.end().finally(() => process.exit(0))); });
}
