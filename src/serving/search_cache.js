'use strict';
// 정확 일치 검색 결과 캐시(SEARCH_CACHE=on, 기본 off). 키 = (정규화 질의, 모든 필터·모드 인자, corpus 버전 스탬프). TTL: 법령·내규·단협 24h·공시(·all) 6h. LRU(항목·바이트 상한).
// 스탬프 = documents·articles 의 누적 변경 카운터(pg_stat_user_tables n_tup_ins+upd+del) — 일일 델타 적재가 끝나면 값이 바뀌어 이전 키가 저절로 무효화된다. 스탬프를 못 읽으면 캐시를 쓰지 않는다(fail-open).
const on = () => process.env.SEARCH_CACHE === 'on';
const MAX_ENTRIES = +process.env.SEARCH_CACHE_MAX || 500, MAX_BYTES = +process.env.SEARCH_CACHE_BYTES || 30e6;
const TTL = { legal: 24, bylaws: 24, ca: 24 };   // 시간, 그 외(공시·all·미지정) 6h
const map = new Map(); let bytes = 0, stamp = null, stampAt = 0;
const stats = { hit: 0, miss: 0, store: 0, skip: 0 };
const PART = /(에서의|에서는|에서|으로|입니다|인가요|나요|은|는|이|가|을|를|의|에|도|만|로|와|과)$/;
function normKw(k) {
  return String(k || '').trim().toLowerCase().replace(/[\s?？.!。,]+$/g, '').split(/\s+/).map(t => (t.length > 2 ? t.replace(PART, '') : t)).join('');   // 공백 제거·말미 구두점·어절 끝 조사
}
const keyOf = (tool, a) => { const o = {}; for (const k of Object.keys(a || {}).sort()) if (a[k] !== undefined && a[k] !== null && a[k] !== '') o[k] = a[k]; o.keyword = normKw(a.keyword); return tool + '|' + JSON.stringify(o); };
async function getStamp(withPooled) {
  if (stamp !== null && Date.now() - stampAt < 30000) return stamp;
  try {
    stamp = await withPooled(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='3s'"], async c => (await c.query(
      `SELECT string_agg(relname || ':' || (n_tup_ins + n_tup_upd + n_tup_del), ',' ORDER BY relname) AS s FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname IN ('documents','articles')`)).rows[0].s);
    stampAt = Date.now();
  } catch { stamp = null; }
  return stamp;
}
const skipLabel = l => /^warm/i.test(String(l || ''));   // 워밍·모니터링은 캐시 제외(워밍이 캐시를 데우면 콜드 지연을 못 본다)
/** run() → 응답 객체. 캐시 사용 가능하면 히트 시 {…, cache:'hit'}. */
async function through(tool, a, ctx, withPooled, run) {
  if (!on() || skipLabel(ctx && ctx.label)) { stats.skip++; return run(); }
  const st = await getStamp(withPooled); if (!st) { stats.skip++; return run(); }
  const key = st + '|' + keyOf(tool, a), now = Date.now(), e = map.get(key);
  if (e && now < e.exp) { map.delete(key); map.set(key, e); stats.hit++; return { ...JSON.parse(e.s), cache: 'hit' }; }
  if (e) { map.delete(key); bytes -= e.s.length; }
  stats.miss++;
  const out = await run();
  if (out && !out.degraded && !out.auto_hybrid_failed) {
    const s = JSON.stringify(out), ttl = (TTL[a && a.corpus] || 6) * 3600e3;
    if (s.length < 400000) { map.set(key, { s, exp: now + ttl }); bytes += s.length; stats.store++; while (map.size > MAX_ENTRIES || bytes > MAX_BYTES) { const k = map.keys().next().value, v = map.get(k); map.delete(k); bytes -= v.s.length; } }
  }
  return out;
}
module.exports = { on, through, normKw, keyOf, stats, _map: map };
