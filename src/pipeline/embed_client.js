'use strict';
/**
 * 임베딩 HTTP 클라이언트 — 재시도(지수 백오프)·차원 단언·비용 누적/가드(상태 파일). DB 접근 없음(단위시험 가능).
 *
 * 비용: OpenRouter 응답의 usage.cost(USD)를 누적한다. 없으면 priceFallbackPerMTok × 토큰, 그것도 없으면 오류(누적 불가 상태로 돌지 않는다).
 * 가드: 누적 ≥ budgetUsd 이면 halted=true — 호출자는 새 배치를 투입하지 말고 종료(rc=3). 같은 명령 재실행 = 상태 파일에서 이어서.
 * 상태 파일은 응답을 받은 «직후, DB 쓰기 전에» 저장한다(재개 시 과소집계 방향으로만 어긋나지 않게 — 마지막 1회분 이내).
 */
const fs = require('fs');
const http = require('http');
const https = require('https');

const sleepDefault = ms => new Promise(r => setTimeout(r, ms));

class EmbedError extends Error {
  constructor(msg, { status = 0, fatal = false, retryAfterMs = 0 } = {}) { super(msg); this.status = status; this.fatal = fatal; this.retryAfterMs = retryAfterMs; }
}

const retryable = e => !e.fatal && (e.status === 429 || e.status >= 500 || e.status === 0);

function loadState(file, model) {
  const fresh = { model, spent_usd: 0, tokens: 0, calls: 0, retries: 0, updated_at: null };
  if (!file || !fs.existsSync(file)) return fresh;
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (s.model !== model) throw new Error(`상태 파일 ${file} 의 model(${s.model}) ≠ 현재(${model}) — 다른 모델의 비용을 섞지 않는다`);
  return { ...fresh, ...s };
}

function saveState(file, st) {
  if (!file) return;
  st.updated_at = new Date().toISOString();
  fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 2));
  fs.renameSync(file + '.tmp', file);     // 원자적 교체 — 중간에 죽어도 반쪽 파일이 남지 않는다
}

/**
 * @param {object} o
 *   url, model, apiKey(없으면 헤더 생략: ollama), dim, body(texts)->obj, pick(json)->vecs, timeoutMs,
 *   providerOnly: string[]|null  (OpenRouter provider:{only:[…]} — 기본 꺼짐),
 *   trackCost: bool (true 면 usage.cost 필수), budgetUsd(0=가드 끔), priceFallbackPerMTok, stateFile,
 *   retry: { max=8, baseMs=2000, capMs=120000, jitter=true }, sleep(ms) — 시험에서 주입, log(msg)
 */
function createEmbedClient(o) {
  const dim = o.dim || 1024;
  const retry = { max: 8, baseMs: 2000, capMs: 120000, jitter: true, ...(o.retry || {}) };
  const sleep = o.sleep || sleepDefault;
  const log = o.log || (() => {});
  const state = loadState(o.stateFile, o.model);
  const u = new URL(o.url);
  const transport = u.protocol === 'http:' ? http : https;

  const spentUsd = () => state.spent_usd;
  const halted = () => !!(o.budgetUsd > 0 && state.spent_usd >= o.budgetUsd);

  function once(texts) {
    const payload = o.body ? o.body(texts) : { model: o.model, input: texts };
    if (o.providerOnly && o.providerOnly.length) payload.provider = { only: o.providerOnly };
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (o.apiKey) headers.Authorization = 'Bearer ' + o.apiKey;
    return new Promise((resolve, reject) => {
      const req = transport.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'POST', timeout: o.timeoutMs || 120000, headers }, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          if (r.statusCode !== 200) {
            const ra = parseFloat(r.headers['retry-after']);
            // 402=크레딧 소진·401/403=키 문제 → 재시도해도 소용없다(fatal). 본문은 앞 160자만(키·원문 노출 방지: 서버 오류문만)
            const fatal = r.statusCode !== 429 && r.statusCode < 500;
            return reject(new EmbedError(`HTTP ${r.statusCode}: ${d.slice(0, 160)}`, { status: r.statusCode, fatal, retryAfterMs: ra > 0 ? ra * 1000 : 0 }));
          }
          try { resolve(JSON.parse(d)); } catch { reject(new EmbedError('응답 JSON 파싱 실패: ' + d.slice(0, 120), { status: 502 })); }
        });
      });
      req.on('error', e => reject(new EmbedError('network: ' + e.message, { status: 0 })));
      req.on('timeout', () => { req.destroy(); reject(new EmbedError('timeout', { status: 0 })); });
      req.write(body); req.end();
    });
  }

  function account(j, n) {
    const usage = j.usage || {};
    const tok = usage.prompt_tokens ?? usage.total_tokens ?? j.prompt_eval_count ?? 0;
    let cost = typeof usage.cost === 'number' ? usage.cost : null;
    if (cost == null && o.trackCost) {
      if (o.priceFallbackPerMTok > 0 && tok) cost = tok / 1e6 * o.priceFallbackPerMTok;
      else throw new EmbedError('응답에 usage.cost 없음 — 비용 누적 불가(중단)', { fatal: true });
    }
    state.spent_usd += cost || 0; state.tokens += tok; state.calls += 1;
    return tok;
  }

  async function embed(texts) {
    for (let i = 0; ; i++) {
      try {
        const j = await once(texts);
        let vecs = o.pick(j);
        if (Array.isArray(j.data) && j.data.every(x => typeof x.index === 'number')) {
          vecs = [...j.data].sort((a, b) => a.index - b.index).map(x => x.embedding);   // index 순서 보장
        }
        if (!Array.isArray(vecs) || vecs.length !== texts.length) throw new EmbedError(`응답 개수 ${vecs && vecs.length} ≠ 입력 ${texts.length}`, { fatal: true });
        const bad = vecs.find(v => !Array.isArray(v) || v.length !== dim || !v.every(Number.isFinite));
        if (bad) throw new EmbedError(`차원/값 불일치: ${bad && bad.length} (기대 ${dim})`, { fatal: true });
        account(j, texts.length);
        saveState(o.stateFile, state);
        return vecs;
      } catch (e) {
        if (!(e instanceof EmbedError)) throw e;
        if (!retryable(e) || i >= retry.max) throw e;
        const exp = Math.min(retry.capMs, retry.baseMs * 2 ** i);
        const w = Math.max(e.retryAfterMs, retry.jitter ? exp * (0.5 + Math.random() / 2) : exp);
        state.retries += 1;
        log(`재시도 ${i + 1}/${retry.max} (${e.message.slice(0, 80)}) — ${(w / 1000).toFixed(1)}s 대기`);
        await sleep(w);
      }
    }
  }

  // 한 입력이 컨텍스트를 넘으면(ollama truncate:false → HTTP 400) 배치 «전체»가 실패한다 — 400 이면 이분 분할해 문제 입력만 격리한다.
  // 반환: vecs(입력과 같은 길이, 격리된 자리는 null) · bad([{index, message}]). 400 이외(429·5xx·fatal)는 embed() 의 기존 재시도·실패 동작 그대로.
  // 비용: 400 은 과금되지 않고 account() 도 호출되지 않는다. 최악 호출 수 ≈ 2·bad·log2(n).
  async function embedIsolate(texts) {
    const vecs = new Array(texts.length).fill(null), bad = [];
    const go = async (lo, hi) => {
      try { (await embed(texts.slice(lo, hi))).forEach((v, k) => { vecs[lo + k] = v; }); }
      catch (e) {
        if (!(e instanceof EmbedError) || e.status !== 400) throw e;
        if (hi - lo === 1) { bad.push({ index: lo, message: e.message }); return; }
        const mid = (lo + hi) >> 1; await go(lo, mid); await go(mid, hi);
      }
    };
    await go(0, texts.length);
    return { vecs, bad };
  }

  return { embed, embedIsolate, halted, spentUsd, state, saveState: () => saveState(o.stateFile, state) };
}

module.exports = { createEmbedClient, EmbedError };
