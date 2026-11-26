'use strict';
// REST 기관 수 집계(2026-11-10): «X 가 본문에 나오는 기관은 몇 곳인가» 질문용. 상위 k 검색은 전체를 못 세므로 DB 에서 기관을 DISTINCT 로 센다.
// 센 것은 «본문(조문)에 키워드 문자열이 들어 있는 기관» 이다 — 제도를 «시행한다» 는 뜻이 아니며(언급·부정문 포함), 모든 판본(연혁) 기준이다. 응답 basis 에 그대로 적는다.
const CORPORA = ['disclosure', 'bylaws', 'ca', 'legal'];
const likeEsc = s => s.replace(/[\\%_]/g, m => '\\' + m);
// 부하 보호(11-10): 넓은 키워드(예: «휴가» 약 8초, 1~2자 흔한 말은 10초 초과)는 DB 를 오래 쓴다 → ① 같은 질의는 TTL 안에 캐시 ② 같은 질의가 진행 중이면 그 결과를 공유 ③ 동시에 도는 집계는 MAX_RUN 개까지, 넘으면 BUSY(대기열 없음).
const TTL = +process.env.COUNT_CACHE_MS || 600000, MAX_RUN = +process.env.COUNT_MAX_RUN || 2, MAX_CACHE = 300;
const cache = new Map(), inflight = new Map(); let running = 0;
async function countInst(withPooled, a) {
  const kw0 = String(a.keyword || '').trim().slice(0, 30).toLowerCase(), key = [kw0, a.corpus || 'all', Math.min(200, Math.max(0, parseInt(a.max_list, 10) || 0))].join('|');
  const hit = cache.get(key); if (hit && Date.now() - hit.t < TTL) return hit.v;
  if (inflight.has(key)) return inflight.get(key);
  if (running >= MAX_RUN) throw Object.assign(new Error('집계 요청이 많습니다. 잠시 후 다시 시도하세요'), { code: 'BUSY' });
  running++;
  const p = countInst0(withPooled, a).then(v => { if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value); cache.set(key, { t: Date.now(), v }); return v; }).finally(() => { running--; inflight.delete(key); });
  inflight.set(key, p); return p;
}
async function countInst0(withPooled, a) {
  const kw = String(a.keyword || '').trim().slice(0, 30);
  if (kw.replace(/\s/g, '').length < 2) throw Object.assign(new Error('keyword 는 2자 이상이어야 합니다'), { code: 'BAD_REQUEST' });
  const corpus = a.corpus && a.corpus !== 'all' ? String(a.corpus) : 'all';
  if (corpus !== 'all' && !CORPORA.includes(corpus)) throw Object.assign(new Error('corpus 는 ' + CORPORA.join('|') + '|all'), { code: 'BAD_REQUEST' });
  const maxList = Math.min(200, Math.max(0, parseInt(a.max_list, 10) || 0));
  const pat = '%' + likeEsc(kw.toLowerCase()) + '%';
  // lower(body) 는 idx_articles_body_bigm 식과 같아야 인덱스를 탄다(없이 body LIKE 는 순차 스캔이라 10초를 넘는다 — 11-10 실측 약 2초 vs 10초 초과)
  return withPooled(["SET LOCAL statement_timeout='10s'"], async c => {
    const rows = (await c.query(
      `SELECT d.corpus, i.inst_name FROM articles a JOIN documents d USING (doc_id) JOIN institutions i USING (inst_code)
        WHERE lower(a.body) LIKE $1 AND ($2 = 'all' OR d.corpus = $2) AND COALESCE(d.meta->>'scope', '') <> 'extra' GROUP BY d.corpus, i.inst_name`, [pat, corpus])).rows;
    const names = new Set(rows.map(r => r.inst_name)), per = k => new Set(rows.filter(r => r.corpus === k).map(r => r.inst_name)).size;
    const out = { keyword: kw, corpus, institutions_total: names.size, by_corpus: Object.fromEntries(CORPORA.filter(k => corpus === 'all' || k === corpus).map(k => [k, per(k)])),
      basis: '조문 본문에 키워드 문자열이 들어 있는 기관 수(언급 포함·모든 판본 기준). 제도의 시행 여부와는 다르다. 국가과학기술연구회 소관 출연연 23곳은 센 대상에서 제외한다.' };
    if (maxList) out.institutions = [...names].sort().slice(0, maxList);
    return out;
  });
}
module.exports = { countInst };
