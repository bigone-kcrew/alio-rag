'use strict';
// c6: 코드 가이드(유형·구조화 상태·권장 호출·주의) + 코드별 커버리지(최근 12개월 제출 기관 수). 플래그 MCP_ITEM_GUIDE=on 일 때만 호출부가 쓴다.
// 가이드 위치: ALIO_CODE_GUIDE_PATH > 마운트 폴더 data/code_guide.json(운영이 교체하는 ops 파일) > 이미지 기본본 code_guide.default.json. 30초 핫리로드.
const fs = require('fs'), path = require('path');
const on = () => process.env.MCP_ITEM_GUIDE === 'on';
const fileNow = () => { if (process.env.ALIO_CODE_GUIDE_PATH) return process.env.ALIO_CODE_GUIDE_PATH; const o = path.join(__dirname, 'data', 'code_guide.json'); return fs.existsSync(o) ? o : path.join(__dirname, 'code_guide.default.json'); };
let G = new Map(), stamp = '', checked = 0;
function load() {
  const now = Date.now(); if (stamp && now - checked < (+process.env.ALIO_INST_ALIAS_CHECK_MS || 30000)) return G; checked = now;
  try { const f = fileNow(), k = f + fs.statSync(f).mtimeMs; if (k !== stamp) { /* 배열(원본 docs/plans 형식)·{items:[…]} 둘 다, 중복 코드는 첫 항목 */ const j = JSON.parse(fs.readFileSync(f, 'utf8')), arr = Array.isArray(j) ? j : (j.items || []), m = new Map(); for (const x of arr) if (x && x.code && !m.has(x.code)) m.set(x.code, x); G = m; stamp = k; } } catch { if (!stamp) stamp = '0'; }
  return G;
}
const ARCH = { A: '페이지 필드·표', B: '첨부 xlsx 행 목록', C: '문서·서술', D: '재무표(PDF)', E: '게시판 공고', F: '이미지' };
const guideFor = code => { const g = load().get(code); return g ? { type: g.archetype + '(' + (ARCH[g.archetype] || '') + ')', structured: g.structured_dataset || '없음', status: g.status, how: g.how, ...(g.caveat ? { caveat: g.caveat } : {}) } : null; };

// 최근 12개월 제출 기관 수(코드별, 1시간 캐시). 제출일 메타가 없는 코드(B1030·B1220 등)는 period_label 연도(올해·작년)로 근사하고 그 사실을 note 에 적는다.
const covCache = new Map(); let totalInst = null, totalAt = 0;
async function itemCoverage(withPooled, code, cats) {
  const hit = covCache.get(code); if (hit && Date.now() - hit.t < 3600e3) return hit.v;
  const d = new Date(Date.now() + 9 * 3600e3); d.setUTCMonth(d.getUTCMonth() - 12); const cut = d.toISOString().slice(0, 10), yr = d.getUTCFullYear();
  const run = (sql, p) => withPooled(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='6s'"], async c => (await c.query(sql, p)).rows);
  const [r] = await run(`SELECT count(DISTINCT inst_code) FILTER (WHERE meta->>'submitted_at' >= $2)::int AS n_sub, count(DISTINCT inst_code) FILTER (WHERE meta->>'submitted_at' IS NULL AND substr(meta->>'period_label', 1, 4) >= $3)::int AS n_pl,
      count(*) FILTER (WHERE meta->>'submitted_at' IS NULL)::int AS nosub, count(*)::int AS docs FROM documents WHERE corpus = 'disclosure' AND category = ANY($1::text[])`, [cats, cut, String(yr)]);
  if (!totalInst || Date.now() - totalAt > 6 * 3600e3) { totalInst = (await run(`SELECT count(DISTINCT inst_code)::int AS n FROM documents WHERE corpus = 'disclosure' AND COALESCE(meta->>'scope','') <> 'extra'`))[0].n; totalAt = Date.now(); }
  const approx = r.nosub > r.docs / 2, n = approx ? r.n_pl : r.n_sub;
  const v = { code, institutions_12m: n, pct_12m: totalInst ? Math.round(n / totalInst * 1000) / 10 : null, total_institutions: totalInst,
    note: '최근 12개월(제출일 ≥ ' + cut + (approx ? ', 제출일 메타가 없는 항목이라 회차 라벨 연도 ≥ ' + yr + ' 로 근사' : '') + ') 이 항목 문서를 낸 기관 수 — 제출 의무 목록이 없어 «자료 없음» 과 «제출 대상 아님» 을 구분할 수 없다(비율이 낮아도 미제출이라는 뜻이 아님).' };
  covCache.set(code, { t: Date.now(), v }); return v;
}
module.exports = { on, guideFor, itemCoverage, load };
