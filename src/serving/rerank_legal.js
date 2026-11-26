'use strict';
/**
 * 법령 한정 리랭커(서빙용, 의존성 없음). 2026-10-26 사용자 승인 «리랭커 도입 확정» — 법령 test 32건 사전등록 판정 통과
 * (kure-nano-int8 · 상위 10건 · rerank_only: hit1 0.219→0.531, MRR 0.349→0.573, 서버 p95 2.2s).
 * 검증된 조건만 켠다: corpus='legal' 명시 + semantic(비하이브리드) + 후보 ≥2. 그 밖(hybrid·keyword·타 코퍼스·all)은 손대지 않는다.
 * 실패·타임아웃·차단기는 항상 «원순위 + 사유». RERANK_LEGAL 이 off(기본)면 아무것도 하지 않고 rerank:null → 응답에 키가 붙지 않는다(바이트 동일).
 *
 *   RERANK_LEGAL=off|on   RERANK_URL=http://localhost:8000/rerank   RERANK_MODEL=kure-nano-int8   RERANK_TOKEN=(Bearer)
 *   RERANK_TOP=10   RERANK_TIMEOUT_MS=5000   RERANK_CACHE_MAX=300   RERANK_CACHE_TTL_MS=600000   RERANK_BREAKER_FAILS=3   RERANK_BREAKER_MS=30000
 * [2026-11-26 후보] RERANK_CORPORA=legal(기본)|legal,bylaws — 허용 코퍼스 목록. 비-법령은 입력에 «[기관명] » 접두(V2)·semantic 단독·scope 기본(출연연 extra 제외)만.
 *   RERANK_SHADOW_CORPORA=(기본 빈값) — 여기 든 코퍼스는 «점수만 계산해 로그, 응답·순서 불변», 사용자 대기 없음(비동기). RERANK_URL_BYLAWS/RERANK_TIMEOUT_MS_BYLAWS/RERANK_MODEL_BYLAWS — 비-법령용 별도 엔드포인트(로컬 사이드카), 이때 RERANK_TOKEN 은 보내지 않는다.
 *   RERANK_HYBRID_CORPORA=(기본 빈값) — 여기 든 코퍼스는 hybrid 응답(의미 팔 성공 시)도 대상. 내규만 근거 있음(KureV2Expand C·HybridFuse §3).
 * 환경변수는 호출 시점에 읽는다(재시작 없이 시험 가능, 운영은 컨테이너 env). 토큰 값은 로그·응답에 남기지 않는다.
 */
const crypto = require('crypto');
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => { const v = Number(env(k, d)); return Number.isFinite(v) ? v : d; };
const enabled = () => env('RERANK_LEGAL', 'off') === 'on';

// 평가(rerank_eval.js head())와 같은 입력 구성: «문서명 조번호 조제목\n본문» 앞 4000자.
const DOC_MAX = 4000;
const rowText = (r, corpus) => {
  const pre = corpus && corpus !== 'legal' && r.inst_name ? `[${r.inst_name}] ` : '';   // V2: 법령 외는 기관명 접두(KureV2Expand §8). 법령은 V1 그대로(바이트 동일)
  return `${pre}${r.doc_title || ''} ${r.art_ref || ''} ${r.art_title || ''}\n${r.body || ''}`.slice(0, DOC_MAX);
};
const list = k => env(k, '').split(',').map(x => x.trim()).filter(Boolean);
const corpora = () => { const l = list('RERANK_CORPORA'); return l.length ? l : ['legal']; };
const docNote = () => (corpora().length === 1 && corpora()[0] === 'legal') ? '법령(corpus=legal)' : '법령·내규(corpus=legal|bylaws)';   // 도구 설명용: 기본값이면 기존 문구와 바이트 동일

// 'apply' | 'shadow' | false. 검증된 조합만: 코퍼스 명시 + semantic 단독 + 후보 ≥2 (+ 비-법령은 scope 기본, 출연연 extra·all 제외)
function modeOf(rows, ctx) {
  if (!enabled()) return false;
  const m = corpora().includes(ctx.corpus) ? 'apply' : list('RERANK_SHADOW_CORPORA').includes(ctx.corpus) ? 'shadow' : false;
  if (!m) return false;
  if (ctx.corpus !== 'legal' && ctx.scope && ctx.scope !== 'default') return false;
  if (!ctx.semantic) return false;   // hybrid 라도 의미 팔이 실패해 키워드 단독으로 강등된 응답은 semantic=false 로 들어와 여기서 걸러진다
  if (ctx.hybrid && !list('RERANK_HYBRID_CORPORA').includes(ctx.corpus)) return false;   // hybrid 허용은 코퍼스별 별도 플래그(기본 빈값)
  return Array.isArray(rows) && rows.length >= 2 ? m : false;
}
const eligible = (rows, ctx) => modeOf(rows, ctx) === 'apply';
const target = corpus => {
  const url = corpus !== 'legal' && env('RERANK_URL_BYLAWS', '');
  return url ? { url, model: env('RERANK_MODEL_BYLAWS', env('RERANK_MODEL', 'kure-nano-int8')), token: '', timeout: num('RERANK_TIMEOUT_MS_BYLAWS', 1500) }
             : { url: env('RERANK_URL', 'http://localhost:8000/rerank'), model: env('RERANK_MODEL', 'kure-nano-int8'), token: env('RERANK_TOKEN', ''), timeout: num('RERANK_TIMEOUT_MS', 5000) };
};

// ── LRU(+TTL) 캐시: Map 삽입순서 = 사용순서 ──
const cache = new Map();
const norm = q => String(q || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const md5 = x => crypto.createHash('md5').update(x).digest('hex');
const cacheKey = (query, texts, model) => md5(norm(query) + '\0' + model + '\0' + texts.map(md5).join(','));
function cacheGet(k) {
  const e = cache.get(k); if (!e) return null;
  if (Date.now() - e.t > num('RERANK_CACHE_TTL_MS', 600000)) { cache.delete(k); return null; }
  cache.delete(k); cache.set(k, e); return e;
}
function cacheSet(k, v) { cache.set(k, { ...v, t: Date.now() }); while (cache.size > num('RERANK_CACHE_MAX', 300)) cache.delete(cache.keys().next().value); }

// ── 차단기: 연속 실패 K 회면 BREAKER_MS 동안 호출하지 않고 즉시 원순위 ──
const br = { fails: 0, until: 0 };

async function call(query, texts, tg) {
  const headers = { 'content-type': 'application/json', ...(tg.token ? { authorization: 'Bearer ' + tg.token } : {}) };
  const res = await fetch(tg.url, {
    method: 'POST', headers, signal: AbortSignal.timeout(tg.timeout),
    body: JSON.stringify({ model: tg.model, query: String(query).slice(0, 500), documents: texts, top_n: texts.length }),
  });
  if (res.status === 429) { const e = new Error('busy'); e.reason = 'busy'; throw e; }
  if (!res.ok) { const e = new Error('http ' + res.status); e.reason = 'service_error'; throw e; }
  const j = await res.json();
  const sc = new Array(texts.length).fill(null);
  for (const x of (j && j.results) || []) if (Number.isInteger(x.index) && x.index >= 0 && x.index < sc.length && Number.isFinite(x.score)) sc[x.index] = x.score;
  if (sc.some(s => s === null)) { const e = new Error('bad scores'); e.reason = 'bad_response'; throw e; }
  return { scores: sc, model: (j.meta && j.meta.model) || tg.model, elapsed: j.meta && j.meta.elapsed_ms };
}

/** rows(관련도순) → { rows, rerank }. 적용 대상이 아니면 { rows(같은 참조), rerank:null }. */
async function rerankRows(rows, ctx) {
  const mode = modeOf(rows, ctx);
  if (!mode) return { rows, rerank: null };
  const n = Math.max(2, Math.min(30, num('RERANK_TOP', 10)));
  const cand = rows.slice(0, n), tail = rows.slice(n);
  if (cand.length < 2) return { rows, rerank: null };
  const now = Date.now();
  if (br.until > now) return { rows, rerank: { applied: false, reason: 'breaker_open' } };
  const tg = target(ctx.corpus);
  const texts = cand.map(r => rowText(r, ctx.corpus));
  const ck = cacheKey(ctx.query, texts, tg.model);
  if (mode === 'shadow') { shadow(ctx, cand, texts, ck, tg).catch(() => {}); return { rows, rerank: null }; }   // 대기 없음·응답 불변
  const t0 = Date.now();
  let sc, model, cached = false;
  const hit = cacheGet(ck);
  if (hit) { sc = hit.scores; model = hit.model; cached = true; }
  else {
    try {
      const r = await call(ctx.query, texts, tg);
      sc = r.scores; model = r.model; br.fails = 0; cacheSet(ck, { scores: sc, model });
    } catch (e) {
      br.fails++;
      if (br.fails >= num('RERANK_BREAKER_FAILS', 3)) { br.until = Date.now() + num('RERANK_BREAKER_MS', 30000); br.fails = 0; }
      const reason = e.reason || (e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'error');
      process.stderr.write(`[rerank] 원순위 폴백: ${reason}\n`);
      return { rows, rerank: { applied: false, reason } };
    }
  }
  const order = cand.map((_, i) => i).sort((a, b) => sc[b] - sc[a] || a - b);   // 동점은 원순위 유지
  return { rows: order.map(i => cand[i]).concat(tail), rerank: { applied: true, model, n: cand.length, ms: Date.now() - t0, ...(cached ? { cached: true } : {}) } };
}

// 그림자: 점수만 계산해 stderr 한 줄(질의는 md5 앞 8자만, 본문 없음). 응답·순서·캐시 오염 없음.
async function shadow(ctx, cand, texts, ck, tg) {
  if (br.until > Date.now()) return;
  const t0 = Date.now(), key = r => (r.doc_id || '') + '#' + (r.art_ref || '');
  let rec = { corpus: ctx.corpus, q: md5(norm(ctx.query)).slice(0, 8), n: cand.length };
  try {
    const hit = cacheGet(ck); const sc = hit ? hit.scores : (await call(ctx.query, texts, tg)).scores;
    if (!hit) cacheSet(ck, { scores: sc, model: tg.model });
    const order = cand.map((_, i) => i).sort((a, b) => sc[b] - sc[a] || a - b);
    rec = { ...rec, ok: true, ms: Date.now() - t0, cached: !!hit, top1_changed: order[0] !== 0, new_top1_from: order[0], orig: cand.slice(0, 3).map(key), new: order.slice(0, 3).map(i => key(cand[i])) };
    br.fails = 0;
  } catch (e) { br.fails++; if (br.fails >= num('RERANK_BREAKER_FAILS', 3)) { br.until = Date.now() + num('RERANK_BREAKER_MS', 30000); br.fails = 0; } rec = { ...rec, ok: false, reason: e.reason || e.name || 'error', ms: Date.now() - t0 }; }
  process.stderr.write('[rerank-shadow] ' + JSON.stringify(rec) + '\n');
}

module.exports = { rerankRows, eligible, modeOf, docNote, rowText, _reset: () => { cache.clear(); br.fails = 0; br.until = 0; } };
