'use strict';
/**
 * 검색 계약 응답 메타(G2-D·E). REST(api_server.js)·MCP(mcp_server.js) 공용. 모든 키는 «추가만» — 기존 응답 키·순서는 불변.
 *   period_semantics  period·report_period·target_year 를 쓴 호출에만 붙는 한 줄 설명(회차 라벨 ≠ 자료 대상 연도)
 *   docs_total        구조 필터(item·period·report_period·target_year·inst·type·ministry·usecase·year)를 만족하는 «공시 문서 수»(키워드 무시, 회차 재게시 포함).
 *                     DOCS_TOTAL_CAP(기본 5000) 을 넘으면 docs_total=CAP·docs_total_capped=true, 시간(5초) 초과면 docs_total_note. DOCS_TOTAL=off 로 끔.
 *   zero_reasons      0건일 때 이유 후보(문장 배열) — 필터가 너무 좁은지·period 라벨 불일치·키워드 모드 한계
 *   AUTO_HYBRID_ON_ZERO=on 이면(기본 off) 키워드 0건 + 문장형 질의를 hybrid 로 한 번 더 — 호출부가 auto_hybrid:true 를 단다.
 */
const IF = require('./item_filter.js');
const { postFilter } = require('./search.js');

const PERIOD_SEMANTICS = 'period=공시 «회차(제출)» 라벨(1~3월 제출 4분기 보고서는 다음 해 라벨, 회차마다 과거 연도 첨부가 재게시됨). 보고 대상 분기/연도는 report_period(period_label_adj 기준), 자료 자체의 연도(문서 제목 «20XX년»·«(20XX)»)는 target_year. 연도 첨부형 항목은 제출 회차 기준이며 target_year·report_period 필터는 제목 형식에 따라 문서를 놓칠 수 있다(결과가 적거나 0건이어도 «없음» 이 아니다).';
const CAP = () => Math.max(1, parseInt(process.env.DOCS_TOTAL_CAP || '5000', 10) || 5000);
const docsOn = () => process.env.DOCS_TOTAL !== 'off';
const autoHybridOn = () => process.env.AUTO_HYBRID_ON_ZERO === 'on';
const usedPeriodish = a => !!(a.period || a.reportPeriod || a.targetYear);
const USECASE_KEYS = ['recruit', 'audit', 'governance', 'labor', 'finance', 'welfare', 'safety', 'security', 'esg'];   // classify_usecase.js USECASES(_shared 는 자동 포함)
/** 없는 usecase 키(예 discipline)는 에러 없이 0건이 되므로 알린다. 모르는 키가 없으면 null */
const usecaseWarning = raw => {
  const bad = String(raw == null || raw === true ? '' : raw).split(',').map(x => x.trim()).filter(x => x && x !== '_shared' && !USECASE_KEYS.includes(x));
  return bad.length ? `usecase 키 «${bad.join(', ')}» 는 없는 값입니다(유효: ${USECASE_KEYS.join('·')}) — 이 값으로는 결과가 0건이 됩니다.` : null;
};
const isSentence = kw => (String(kw || '').trim().match(/\s+/g) || []).length >= 2;   // 공백 2개 이상

/** 필터를 만족하는 공시 문서 수. corpus 가 disclosure·all 이고 사후 필터가 있을 때만(아니면 null). 반환 {docs_total, docs_total_capped?} | {docs_total_note} | null */
async function docsTotal(run, args, over = {}) {
  const a = { ...args, ...over };
  if (!docsOn() || !IF.hasPost(a) || !['all', 'disclosure'].includes(a.corpus)) return null;
  const pf = postFilter({ ...a, corpus: 'disclosure' }, 6);
  const cap = CAP();
  try {
    const r = await run(`SELECT count(*)::int AS n FROM (SELECT 1 FROM documents d LEFT JOIN institutions i USING(inst_code)
        WHERE d.corpus = 'disclosure'
          AND ($1::text IS NULL OR d.doc_type ILIKE '%'||$1||'%')
          AND ($2::text IS NULL OR i.inst_name ILIKE '%'||$2||'%')
          AND ($3::text IS NULL OR i.ministry ILIKE '%'||$3||'%')
          AND ($4::text[] IS NULL OR d.usecases && $4::text[])
          AND ($5::text IS NULL OR d.doc_date LIKE $5||'%')${pf.sql}
        LIMIT ${cap + 1}) t`, [a.type || null, a.inst || null, a.ministry || null, a.usecase || null, a.year || null, ...pf.params]);
    const n = r[0].n;
    return n > cap ? { docs_total: cap, docs_total_capped: true } : { docs_total: n };
  } catch (e) { return { docs_total_note: '문서 수 계산 실패·시간 초과(결과와 무관)' }; }
}

/** 0건 이유 후보. 호출부가 «rows 0 · degraded 없음» 일 때만 부른다. dt = docsTotal 결과(없으면 null). */
async function zeroReasons(run, args, { hybrid = false, semantic = false, dt = null } = {}) {
  const out = [];
  const n = dt && dt.docs_total !== undefined && !dt.docs_total_capped ? dt.docs_total : null;
  if (IF.hasPost(args)) {
    if (n === 0) out.push('항목·기간·대상연도·기관 필터를 «모두» 만족하는 공시 문서가 0건입니다 — 필터가 너무 좁거나 값이 어긋났을 수 있습니다(필터를 하나씩 빼 보세요).');
    else if (n > 0) out.push(`필터를 만족하는 공시 문서는 ${n}건 있으나 키워드와 맞는 조문이 없습니다 — 키워드를 줄이거나(핵심 명사) 항목명만 쓰고 hybrid:true 로 시도하세요.`);
    if (args.period && args.period.col === 'label' && !args.reportPeriod && (n === 0 || n === null)) {
      const alt = await docsTotal(run, { ...args, period: null }, { reportPeriod: { col: 'adj', op: args.period.op, val: args.period.val, text: args.period.text } });
      if (alt && alt.docs_total > 0) out.push(`period=${args.period.text} 는 공시 «회차 라벨» 기준이라 0건이지만, 같은 값을 report_period(보고 대상 분기/연도)로 걸면 문서 ${alt.docs_total}건${alt.docs_total_capped ? '+' : ''}이 있습니다 — 1~3월에 제출한 4분기 보고서는 다음 해 라벨(2026Q4 = 실제 2025년 4분기)입니다.`);
      else out.push('period 는 공시 «회차 라벨» 입니다 — 1~3월 제출 4분기 보고서는 다음 해 라벨이니 대상 분기로 찾으려면 report_period 를 쓰세요.');
    }
    if (args.targetYear && n === 0) out.push('target_year 는 문서 제목의 «20XX년» 으로 거릅니다 — 제목에 연도가 없는 문서(예 «임직원 수 2025Q4»)는 제외되니 target_year 를 빼고 report_period 로 시도하세요.');
  }
  if (!hybrid && !semantic && isSentence(args.keyword)) out.push('키워드 모드(기본)는 제목(body=true 면 본문) 부분일치만 찾아 문장형 질의는 0건이 되기 쉽습니다 — hybrid:true 또는 semantic:true 로 다시 시도하세요.');
  return out;
}
module.exports = { usecaseWarning, PERIOD_SEMANTICS, docsTotal, zeroReasons, autoHybridOn, isSentence, usedPeriodish };
