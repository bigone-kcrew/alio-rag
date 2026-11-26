'use strict';
// MCPexpose (2026-11-24): structured_query 에 «공개용 뷰» 기반 새 데이터셋을 얹는다 — structured_query.js 가 require 해서 쓴다.
// 플래그(전부 기본 off): STRUCT_B2=on → b2_bizcost·b2_lawsuit·b2_board·b2_donation·b2_contrib | STRUCT_C2=on → c2_meeting·c2_agenda·c2_audit·c2_eval·c2_finding | STRUCTURED_CONTRACTS=on → contracts.
// 데이터 소스는 rag_ext 공개용 뷰만(b2_*_public·c2_*_current·contract_public·contract_small_agg·b2_hidden_inst_years). 원본 테이블·_current 원본 뷰·rep_name·recipient 원본·raw 컬럼은 조회하지 않는다.
// 응답 규칙(레드팀 20261124_RTdata 권고): 행 조회·건수 허용 / 기관·연 총액은 조건부 / 순위·전 기관 합계·상대방 상위 N·기관 간 비교·횟수·비율은 거부 / 모든 응답 exhaustive=false·source_doc_ids·quality·caveats.
module.exports = function (H) {
  const { bad, pickInsts, compact, envelope, ZERO, kstNow, UNTRUSTED, zeroHint } = H;
  const on = k => process.env[k] === 'on';
  const B2 = ['b2_bizcost', 'b2_lawsuit', 'b2_board', 'b2_donation', 'b2_contrib'], C2 = ['c2_meeting', 'c2_agenda', 'c2_audit', 'c2_eval', 'c2_finding'];
  const names = () => [...(on('STRUCT_B2') ? B2 : []), ...(on('STRUCT_C2') ? C2.filter(d => d !== 'c2_eval') : []), ...(on('STRUCT_C2_EVAL') ? ['c2_eval'] : []), ...(on('STRUCTURED_CONTRACTS') ? ['contracts'] : [])];

  const FLAGS = 'd.coverage_warn, d.multi_doc_round, d.sum_check, d.no_total_row, d.total_diff, d.source_file';
  const yrEq = (col) => (y) => `${col} = ${y}::int`;
  const meetYear = y => `((m.meeting_date >= make_date(${y}::int, 1, 1) AND m.meeting_date < make_date(${y}::int + 1, 1, 1)) OR (m.meeting_date IS NULL AND m.rel_path LIKE '%/' || ${y}::int::text || '/%'))`;
  const SPEC = {
    b2_bizcost: { code: '20701', flags: true, view: 'b2_bizcost_public', src: 'bizcost', label: '기관장 업무추진비(20701)', from: 'rag_ext.b2_bizcost_public d', inst: 'd.inst_code', yearCond: yrEq('d.yr'), yearCol: 'd.yr', month: 'd.month', amt: true, unitAdj: true, missing: 'd.amount_missing', q: ['d.category', 'd.place'],
      cols: `d.doc_id, d.yr, d.month, d.spent_date::text AS spent_date, d.category, d.n_cases, d.amount_won::float8 AS amount_won, d.place, d.pay_method, d.headcount, d.amount_missing, d.unit_adjusted, ${FLAGS}`, order: 'd.yr DESC, d.month, d.spent_date, d.doc_id' },
    b2_donation: { code: '21502', flags: true, view: 'b2_donation_public', src: 'donation', label: '기부 내역(21502)', from: 'rag_ext.b2_donation_public d', inst: 'd.inst_code', yearCond: yrEq('d.yr'), yearCol: 'd.yr', amt: true, missing: 'd.amount_won IS NULL', q: ['d.recipient_public', 'd.reason'],
      cols: `d.doc_id, d.yr, d.event_date::text AS event_date, d.recipient_public, d.amount_won::float8 AS amount_won, d.reason, ${FLAGS}`, order: 'd.yr DESC, d.event_date, d.doc_id' },
    b2_contrib: { code: '32001', flags: true, view: 'b2_contrib_public', src: 'contrib', label: '출연·출자·지원금(32001)', from: 'rag_ext.b2_contrib_public d', inst: 'd.inst_code', yearCond: yrEq('d.yr'), yearCol: 'd.yr', amt: true, missing: 'd.amount_won IS NULL', q: ['d.recipient_public', 'd.object', 'd.reason'],
      cols: `d.doc_id, d.yr, d.event_date::text AS event_date, d.recipient_public, d.amount_won::float8 AS amount_won, d.object, d.reason, ${FLAGS}`, order: 'd.yr DESC, d.event_date, d.doc_id' },
    b2_lawsuit: { code: '21301', flags: true, view: 'b2_lawsuit_public', src: 'lawsuit', label: '소송 현황(21301)', from: 'rag_ext.b2_lawsuit_public d', inst: 'd.inst_code', yearCond: yrEq('d.yr'), yearCol: 'd.yr', cnt: true, q: ['d.case_type', 'd.side'],
      cols: 'd.doc_id, d.yr, d.case_no_raw, d.n_cases, d.n_cases_single, d.n_cases_range, d.is_range, d.is_no_case, d.side, d.delegation, d.case_type, d.coverage_warn, d.multi_doc_round, d.source_file', order: 'd.yr DESC, d.doc_id, d.case_no_raw' },
    b2_board: { code: '43009', view: 'b2_board_public', src: 'board', label: '이사회 의결·표결(43009)', from: 'rag_ext.b2_board_public d', inst: 'd.inst_code', yearCond: yrEq('d.yr'), yearCol: 'd.yr', noCount: true, result: 'd.result', q: ['d.agenda_text'],
      cols: 'd.doc_id, d.yr, d.meeting_no, d.meeting_date::text AS meeting_date, d.agenda_type, d.agenda_text, d.result, d.n_for, d.n_against, d.n_absent, d.n_abstain, d.n_not_eligible, d.source_file', order: 'd.yr DESC, d.meeting_date DESC NULLS LAST, d.meeting_no, d.doc_id, d.agenda_text' },
    c2_meeting: { code: '43005', view: 'c2_board_meeting_current', label: '이사회 회의 목록(c2)', from: 'rag_ext.c2_board_meeting_current m', inst: 'm.inst_code', yearCond: meetYear, noCount: true,
      cols: 'm.doc_id, m.rel_path, m.meeting_no, m.meeting_kind, m.meeting_date::text AS meeting_date, m.date_src_text, m.meeting_hour, m.n_members, m.n_attend, m.n_agenda, m.n_versions::int AS n_versions, m.same_day_n::int AS same_day_n', order: 'm.meeting_date DESC NULLS LAST, m.meeting_no, m.doc_id' },
    c2_agenda: { code: '43005', view: 'c2_board_agenda_current', label: '이사회 안건·결과(c2)', from: 'rag_ext.c2_board_agenda_current a JOIN rag_ext.c2_board_meeting_current m USING (doc_id)', inst: 'm.inst_code', yearCond: meetYear, noCount: true, result: 'a.result', q: ['a.title'],
      cols: 'a.doc_id, m.rel_path, m.meeting_no, m.meeting_date::text AS meeting_date, a.seq, a.agenda_no, a.kind, a.title, a.result_raw, a.result, a.result_flag', order: 'm.meeting_date DESC NULLS LAST, m.meeting_no, a.doc_id, a.seq' },
    c2_audit: { code: '32301', view: 'c2_audit_opinion_current', label: '외부 감사의견(c2)', from: 'rag_ext.c2_audit_opinion_current d', inst: 'd.inst_code', yearCond: y => `EXTRACT(year FROM COALESCE(d.period_end, d.report_date)) = ${y}::int`,
      cols: 'd.doc_id, d.report_type, d.fs_kind, d.opinion, d.report_date::text AS report_date, d.period_end::text AS period_end, d.auditor, d.has_kam, d.has_emphasis, d.going_concern, d.n_versions::int AS n_versions, d.opinion_conflict', order: 'COALESCE(d.period_end, d.report_date) DESC NULLS LAST, d.report_type, d.fs_kind, d.doc_id' },
    c2_eval: { code: '42605', view: 'c2_eval_score_current', label: '경영평가 점수·등급(c2)', from: 'rag_ext.c2_eval_score_current d', inst: 'd.inst_code', yearCond: yrEq('d.eval_year'), q: ['d.indicator', 'd.category'],
      cols: 'd.doc_id, d.row_no, d.eval_year, d.category, d.indicator, d.level, d.grade, d.w_nq::float8 AS w_nq, d.score_nq::float8 AS score_nq, d.w_q::float8 AS w_q, d.score_q::float8 AS score_q, d.source, d.n_versions::int AS n_versions, d.version_conflict, d.value_conflict, d.grade_conflict, d.year_unknown', order: 'd.eval_year DESC NULLS LAST, d.doc_id, d.row_no' },
    c2_finding: { code: 'B1210', view: 'c2_finding_item_current', label: '감사 지적사항 조치(c2)', from: 'rag_ext.c2_finding_item_current d', inst: 'd.inst_code', yearCond: yrEq('d.audit_year'), q: ['d.request'], status: 'd.status',
      cols: 'd.doc_id, d.row_no, d.audit_year, left(d.request, 300) AS request, d.status, d.status_raw, left(d.result_head, 300) AS result_head, d.result_chars, d.n_versions::int AS n_versions, d.status_conflict, d.year_unknown', order: 'd.audit_year DESC NULLS LAST, d.doc_id, d.row_no' },
  };
  for (const [k, s] of Object.entries(SPEC)) UNTRUSTED[k] = { b2_bizcost: ['category', 'place', 'pay_method'], b2_donation: ['recipient_public', 'reason'], b2_contrib: ['recipient_public', 'object', 'reason'], b2_lawsuit: ['case_type', 'case_no_raw'], b2_board: ['agenda_text', 'result'], c2_meeting: ['rel_path'], c2_agenda: ['title', 'result_raw', 'result'], c2_audit: ['auditor', 'opinion'], c2_eval: ['indicator', 'category'], c2_finding: ['request', 'status_raw', 'result_head'] }[k];
  UNTRUSTED.contracts = ['contract_name', 'counterparty', 'content', 'reason'];

  // ── 허용 파라미터·거부 규칙 ───────────────────────────────────────────────
  const ALLOWED = { contracts: ['inst', 'year', 'q', 'group_by', 'metric', 'limit', 'offset'] };
  for (const [k, s] of Object.entries(SPEC)) ALLOWED[k] = ['inst', 'year', ...(s.month ? ['month'] : []), ...(s.q ? ['q'] : []), ...(s.result ? ['result'] : []), ...(s.status ? ['status'] : []), 'metric', 'group_by', 'limit', 'offset'];
  const RANK_PARAMS = ['rank', 'order', 'order_by', 'sort', 'top', 'top_n', 'compare', 'desc'];
  const ALT = '대체 경로: 기관·연도를 지정한 행 목록(이 도구) 또는 search_corpus(item=…, inst=…)+get_document 로 원문을 직접 읽어 확인하세요.';
  const refuse = why => bad(`[거부] ${why} — ${ALT}`);
  const BAD_Q = /(최다|순위|랭킹|상위|가장\s*많|제일\s*많|횟수|몇\s*번|비율|퍼센트|전체\s*합계|전\s*기관)/;
  function validate(o) {
    const d = o.dataset, ks = Object.keys(o);
    for (const k of ks) if (RANK_PARAMS.includes(k)) throw refuse(`${k}: 순위·정렬·기관 간 비교는 제공하지 않습니다(이중집계·단위 오류·정규화 한계로 «전체/최다» 가 틀릴 수 있어 레드팀 권고로 보류)`);
    if (!o.inst) throw bad('inst(기관명)가 필요합니다 — 기관을 지정하지 않는 전 기관 합계·순위·목록은 제공하지 않습니다. 여러 기관 비교는 도구 목록에 있는 count_institutions(예: {keyword:"…", max_list:50})·find_cases(예: {topic:"…"})·search_corpus(item=…, distinct_inst=true)로, 이 도구는 기관 1곳 지정(예: inst:"한국철도공사"). ' + ALT);
    if (/[,，]/.test(o.inst)) throw refuse('기관 간 비교·다기관 합계는 제공하지 않습니다 — inst 는 기관 1곳');
    for (const k of ['q', 'result']) if (k in o) { o[k] = String(o[k]).trim(); if (o[k].length > 60) throw bad(`${k} 는 60자 이내`); }
    if ('q' in o) { if (o.q.length < 2) throw bad('q 는 2자 이상'); if (BAD_Q.test(o.q)) throw refuse('q 에 순위·최다·횟수·비율·합계 등 통계 요구가 들어 있습니다 — 이 도구는 키워드로 행을 거르는 용도입니다'); }
    if ('month' in o) { const m = +o.month; if (!/^\d{1,2}$/.test(String(o.month)) || m < 1 || m > 12) throw bad('month 는 1~12'); o.month = m; }
    if (o.group_by) {
      if (o.group_by === 'year') { if (d !== 'contracts' && !SPEC[d].amt && !SPEC[d].cnt) throw refuse(`${d}: 건수·횟수·연도별 집계는 제공하지 않습니다(회차 번호·개최일이 문서마다 달라 «개최 횟수»·«안건 전부»·결과 비율이 틀릴 수 있음). 원문 링크가 있는 행 목록만`); o.metric = o.metric || 'count'; }
      else if (o.group_by === 'counterparty') throw refuse('상대방별 집계·상위 N·«최다 계약 기업»은 거부합니다 — 상대방명 정규화 한계(대표자·지점명 부착, 개명·계열 미병합, 법인격 다른 업체 병합, 개인명 혼입)와 소액합산·사택 혼입으로 «전수 아님». 특정 업체의 계약은 q 로 계약명·상대방을 거른 행 목록으로 확인');
      else if (o.group_by === 'inst') throw refuse('기관 간 비교·전 기관 합계는 거부합니다(기관마다 공시 형식·단위·누락이 달라 비교가 성립하지 않음)');
      else throw refuse(`group_by=${o.group_by}: 이 데이터셋의 집계는 group_by=year(기관 1곳의 연도별 건수·조건부 총액)만 제공합니다. 종류·결과·상태별 분포·비율 통계는 거부`);
    }
    if (d === 'contracts' && o.metric && !['count', 'amount'].includes(o.metric)) throw bad('metric 은 count|amount');
    if (d !== 'contracts' && o.metric) {
      if (!SPEC[d].amt && !SPEC[d].cnt) throw refuse(`${d}: 건수·횟수·합계 집계는 제공하지 않습니다(회차 번호·개최일이 문서마다 달라 «개최 횟수»·«안건 전부»·결과 비율이 틀릴 수 있음). 원문 링크가 있는 행 목록만`);
      if (!['count', 'amount'].includes(o.metric)) throw bad('metric 은 count|amount');
      if (o.metric === 'amount' && !SPEC[d].amt) throw refuse(`${d}: 금액 총액 집계는 제공하지 않습니다(metric=count 만)`);
    }
    if (SPEC[d] && SPEC[d].noCount && o.limit === 0) throw refuse(`${d}: 건수만 보기(limit=0)는 제공하지 않습니다 — 개최 횟수·안건 수 단정을 막기 위해 행 목록만`);
    if (o.metric && o.offset != null) throw bad('metric(집계)에는 offset 을 쓸 수 없습니다');
    if (o.metric && !o.group_by) o.group_by = 'year';
    return o;
  }

  // ── 공통 응답 조립 ─────────────────────────────────────────────────────────
  const COMMON = [
    'exhaustive=false: 공시 문서에서 규칙으로 추출한 부분집합이다 — 표 인식 실패·누락·중복이 있을 수 있어 «전체·전부·최다·순위» 로 단정 금지. 확인은 source_doc_ids → get_document(원문)로.',
    '순위·전 기관 합계·기관 간 비교·횟수·비율 통계는 의도적으로 제공하지 않는다(레드팀 20261124 권고). 이런 질의는 거부하고 행 목록·원문 링크로 안내한다.'];
  const uniq = (rows, k, n) => [...new Set(rows.map(r => r[k]).filter(Boolean))].slice(0, n);
  const NA = '해당 없음';
  const quality = (rows, s) => ({ sum_check: s.amt ? uniq(rows, 'sum_check', 5) : NA, coverage_warn: s.flags ? rows.some(r => r.coverage_warn) : NA, multi_doc_round: s.flags ? rows.some(r => r.multi_doc_round) : NA });
  const asOf = () => ({ today_kst: kstNow().slice(0, 10) });
  const VERIFIED = new Set(['ok', 'unit']);
  // 레드팀 3라운드 N8: «연간 개요표+월별 시트» 이중 적재로 sum_check=ok 인데 상세합이 총계의 2배인 20701 기관·연도 — 원천 수정 전까지 총액 보류(env STRUCT_B2_DENY="bizcost:C0284:2020,…" 로 교체 가능)
  const DENY = new Set((process.env.STRUCT_B2_DENY || 'bizcost:C0284:2020,bizcost:C0284:2024,bizcost:C0284:2025,bizcost:C0043:2020,bizcost:C1120:2020,bizcost:C0232:2020').split(',').map(x => x.trim()).filter(Boolean));
  const SC_MSG = { diff: '검증 불가/불일치: 상세 행의 합이 문서의 합계행과 맞지 않아(sum_check=diff) 총액을 내지 않고 행만 제공', none: '검증 불가: 문서에 합계행이 없어(no_total_row) 상세 합을 검증하지 못함 — 총액을 내지 않고 행만 제공' };
  const HOLD = (n) => `보류(자료 없음이 아님): 이 기관·연도는 금액 단위·이상값 의심 행(${n}행)이 공개에서 빠져 있어 일부만 보이거나 총액을 낼 수 없다 — 원문(search_corpus·get_document)으로 확인할 것`;

  const SPEC_CAV = {
    b2_bizcost: ['기관장 업무추진비 표(20701)에서 추출한 행(공개용 뷰 b2_bizcost_public). 금액 원 단위, unit_adjusted=단위(천원→원 등) 보정 행. 합계·월 합계 행은 제외되어 있다.', 'category(사용 내역)·place 는 기관이 쓴 자유 서술이며 개인명이 있으면 마스킹·치환되지만 완전하지 않을 수 있다.'],
    b2_donation: ['기부 내역 표(21502). recipient_public 은 개인정보 처리된 수령처, 원본 수령인은 조회하지 않는다.'],
    b2_contrib: ['출연·출자·지원 내역(32001). 헤더 단위(천원/원) 혼동·합계행·병합셀 문제로 일부 기관·연도는 행이 보류(b2_hidden_inst_years)되어 있다.'],
    b2_lawsuit: ['소송 현황(21301). n_cases 는 «사건 수» 칸이며 case_range(범위 표기) 행이 합의 대부분일 수 있어 건수 합계는 n_cases_single(단건 표기)과 범위 행 수를 분리해 보여준다. «자료 없음» 과 «0건» 은 is_no_case 로만 구분된다.'],
    b2_board: ['이사회 의결·표결(43009). 개최일 고유값 수와 회차 번호가 맞지 않는 곳, 오첨부 의심, 미래 날짜, 표결 모순이 있다. 개최 횟수·안건 수·부결 비율은 제공하지 않는다(건수 미제공).', 'result 는 원문 표기 그대로(정규화 안 함).'],
    c2_meeting: ['이사회 회의록 목록(대표 문서 뷰). 개최 일자가 비어 있는 행(약 20%)은 date_src_text·rel_path 로 확인. 같은 날 복수 문서(same_day_n)·다중 버전(n_versions)이 있어 행 수 ≠ 개최 횟수 — «개최 횟수» 는 거부.', '원문 링크: rel_path(+doc_id, get_document).'],
    c2_agenda: ['이사회 안건·결과. result 는 원문 결과 문구, result_raw 는 안건 원문 행(둘 다 원문 링크 rel_path 와 함께 읽을 것) — 규칙 정규화값(result_norm)은 오분류가 있어 노출하지 않는다. «안건 전부»·부결/보류 비율은 거부(안건 0행 문서가 약 35%).'],
    c2_audit: ['외부 감사의견(현행 뷰). 연결/별도·보고 유형별 1행씩이며 opinion_conflict=true 면 같은 키에 상충 문서가 있다.'],
    c2_eval: ['경영평가 점수·등급(현행 뷰). year_unknown·version_conflict·value_conflict·grade_conflict 표식을 확인. 기관 간 비교·순위는 거부.'],
    c2_finding: ['감사 지적사항 조치 항목(현행 뷰). 같은 항목이 회차마다 반복되어 대표 1건으로 합쳤으나 status_conflict 가 있을 수 있다. 상태별 분포·비율 통계는 거부.'],
  };

  async function rowsQuery(c, s, a, insts) {
    const P = [], p = v => (P.push(v), '$' + P.length), w = [`${s.inst} = ANY(${p(insts.map(i => i.inst_code))})`];
    if (a.year) w.push(s.yearCond(p(a.year)));
    if (a.month) w.push(`${s.month} = ${p(a.month)}::int`);
    if (a.q) { const ph = p(H.likeEsc(a.q)); w.push('(' + s.q.map(x => `${x} ILIKE '%' || ${ph} || '%'`).join(' OR ') + ')'); }
    if (a.result) w.push(`${s.result} ILIKE '%' || ${p(H.likeEsc(a.result))} || '%'`);
    if (a.status) w.push(`${s.status} = ${p(a.status)}`);
    return { w, P, p };
  }
  const hiddenOf = async (c, s, insts, year) => s.src ? (await c.query(`SELECT yr, hidden_rows::int AS n FROM rag_ext.b2_hidden_inst_years WHERE src = $1 AND inst_code = ANY($2)${year ? ' AND yr = $3' : ''} ORDER BY yr DESC`, year ? [s.src, insts.map(i => i.inst_code), year] : [s.src, insts.map(i => i.inst_code)])).rows : [];

  // ── 행 목록 ──────────────────────────────────────────────────────────────
  async function list(c, a) {
    const s = SPEC[a.dataset], insts = await pickInsts(c, a.inst), { w, P, p } = await rowsQuery(c, s, a, insts), name = insts[0].inst_name;
    const rows = (await c.query(`SELECT ${s.cols}, count(*) OVER ()::int AS total FROM ${s.from} WHERE ${w.join(' AND ')} ORDER BY ${s.order} LIMIT ${p(a.limit + 1)} OFFSET ${p(a.offset || 0)}`, P)).rows;
    const hasMore = rows.length > a.limit, shown = rows.slice(0, a.limit), off = a.offset || 0;
    const hid = await hiddenOf(c, s, insts, a.year);
    const out = shown.map(r => { const o = { inst: name, ...r }; delete o.total; if (o.total_diff === false) delete o.total_diff; return compact(o); });
    const cav = [...COMMON, ...SPEC_CAV[a.dataset]];
    if (hid.length) cav.push(`hold: ${name} ${hid.map(h => h.yr + '년').join('·')} — ` + HOLD(hid.map(h => h.n).join('·')));
    let zh = null; if (!out.length) { cav.push(hid.length ? '조건에 맞는 공개 행이 없지만 «자료 없음» 이 아니라 위 hold(보류) 때문일 수 있다.' : ZERO); if (!hid.length) { zh = await zeroHint(c, [s.code], insts); if (zh) cav.push(zh.hint); } }
    if (s.yearCond && a.dataset.startsWith('c2_') && !a.year) cav.push('year 를 지정하지 않으면 전 기간 행이 최신순으로 나온다(전체 아님).');
    if (hasMore) cav.push(`limit(${a.limit}) 절단 — 전체가 아니다.` + (s.noCount ? ' 전체 건수는 제공하지 않는다.' : ' total 이 조건에 맞는 행 수.'));
    if (s.amt) cav.push('행 조회형이다. 기관·연 총액이 필요하면 metric=amount(검증된 문서만 총액 반환).');
    const pg = { shown: out, total: s.noCount ? null : rows.length ? rows[0].total : 0, has_more: hasMore, ...(hasMore && a.limit ? { next_offset: off + a.limit } : {}), exhaustive: false };
    const env = envelope(a.dataset, pg, { inst: name, rows: out, source_doc_ids: uniq(shown, 'doc_id', 20), ...(uniq(shown, 'source_file', 10).length ? { source_files: uniq(shown, 'source_file', 10) } : {}), quality: quality(shown, s), ...(zh ? { zero_row_hint: zh } : {}), ...(hid.length ? { hold: hid.map(h => ({ year: h.yr, hidden_rows: h.n, message: HOLD(h.n) })) } : {}) },
      { tables: ['rag_ext.' + s.view].concat(s.src ? ['rag_ext.b2_hidden_inst_years'] : []) }, cav, asOf());
    if (s.noCount) { delete env.total; env.count_note = `건수·횟수 미제공(total 없음) — count=이 페이지 행 수, has_more=${hasMore}${hasMore && a.limit ? ', 이어 읽기 next_offset=' + (off + a.limit) : ' (더 없음, 단 전체 보장 아님)'}`; }
    return env;
  }

  // ── 기관·연도별 건수·조건부 총액(b2) ─────────────────────────────────────────
  async function yearly(c, a) {
    const s = SPEC[a.dataset], insts = await pickInsts(c, a.inst), { w, P, p } = await rowsQuery(c, s, a, insts), name = insts[0].inst_name, wantAmt = a.metric === 'amount';
    const rows = (await c.query(s.cnt
      ? `SELECT d.yr AS y, d.doc_id, count(*)::int AS n, count(*) FILTER (WHERE d.is_range)::int AS n_range_rows, count(*) FILTER (WHERE d.is_no_case)::int AS n_no_case, COALESCE(sum(d.n_cases_single), 0)::int AS n_single, bool_or(d.coverage_warn) AS cw, bool_or(d.multi_doc_round) AS mdr, max(d.source_file) AS sf, max(d.submitted_at)::text AS sub FROM ${s.from} WHERE ${w.join(' AND ')} GROUP BY 1, 2 ORDER BY 1 DESC, 2 LIMIT 300`
      : `SELECT ${s.yearCol} AS y, d.doc_id, max(d.sum_check) AS sc, bool_or(d.no_total_row) AS ntr, bool_or(d.coverage_warn) AS cw, bool_or(d.multi_doc_round) AS mdr, bool_or(d.total_diff) AS td, count(*)::int AS n, sum(d.amount_won)::float8 AS amt, count(*) FILTER (WHERE ${s.missing})::int AS n_missing, ${s.unitAdj ? 'bool_or(d.unit_adjusted)' : 'false'} AS ua, max(d.source_file) AS sf, max(d.submitted_at)::text AS sub FROM ${s.from} WHERE ${w.join(' AND ')} GROUP BY 1, 2 ORDER BY 1 DESC, 2 LIMIT 300`, P)).rows;
    const hid = await hiddenOf(c, s, insts, a.year), hidMap = new Map(hid.map(h => [h.yr, h.n])), byY = new Map();
    for (const r of rows) { if (!byY.has(r.y)) byY.set(r.y, []); byY.get(r.y).push(r); }
    for (const h of hid) if (!byY.has(h.yr)) byY.set(h.yr, []);
    const years = [...byY.keys()].sort((x, y) => y - x).map(y => {
      const docs = byY.get(y), hold = hidMap.get(y), base = { year: y, n_rows: docs.reduce((t, r) => t + r.n, 0), n_docs: docs.length, source_doc_ids: docs.map(r => r.doc_id).slice(0, 10), source_files: [...new Set(docs.map(r => r.sf).filter(Boolean))].slice(0, 5),
        coverage_warn: docs.some(r => r.cw), multi_doc_round: docs.some(r => r.mdr) };
      if (hold) return compact({ ...base, status: 'hold', message: HOLD(hold), hidden_rows: hold });
      if (s.cnt) return compact({ ...base, n_cases_single_sum: docs.reduce((t, r) => t + r.n_single, 0), n_range_rows: docs.reduce((t, r) => t + r.n_range_rows, 0), n_no_case_rows: docs.reduce((t, r) => t + r.n_no_case, 0), status: 'count_only', message: '행 수·단건 표기 사건 수(n_cases_single)만 — 범위 표기 행(n_range_rows)의 사건 수는 합산하지 않았다. «0건» 과 «자료 없음» 은 구분되지 않을 수 있다.' });
      if (wantAmt && DENY.has(`${s.src}:${insts[0].inst_code}:${y}`)) return compact({ ...base, sum_check: [...new Set(docs.map(r => r.sc))], status: 'unverified', message: '검증 불가/불일치 의심: 레드팀 점검에서 연간 개요표와 월별 시트가 이중 적재돼 상세합이 총계의 약 2배로 확인된 기관·연도(sum_check 는 ok 로 표시됨) — 총액을 내지 않고 행만 제공', per_doc: docs.map(r => ({ doc_id: r.doc_id, sum_check: r.sc, n_rows: r.n })) });
      const sc = [...new Set(docs.map(r => r.sc))], bad_ = docs.filter(r => !VERIFIED.has(r.sc) || r.ntr), ok = docs.filter(r => VERIFIED.has(r.sc) && !r.ntr);
      const ent = { ...base, sum_check: sc, no_total_row: docs.some(r => r.ntr), unit_adjusted: docs.some(r => r.ua) || null, n_amount_missing: docs.reduce((t, r) => t + r.n_missing, 0) || null };
      if (!wantAmt) return compact({ ...ent, status: 'count_only' });
      if (bad_.length) return compact({ ...ent, status: 'unverified', message: [...new Set(bad_.map(r => r.ntr ? SC_MSG.none : SC_MSG[r.sc] || `검증 불가: sum_check=${r.sc} — 총액을 내지 않고 행만 제공`))].join(' / '), per_doc: docs.map(r => ({ doc_id: r.doc_id, sum_check: r.sc, n_rows: r.n })) });
      if (ok.length > 1) return compact({ ...ent, status: 'multi_doc', message: '같은 연도에 현행 문서가 여럿이라(이중집계 위험) 합산하지 않았다 — 문서별 값만 제공', per_doc: ok.map(r => ({ doc_id: r.doc_id, total_won: r.amt, n_rows: r.n, source_file: r.sf })) });
      return compact({ ...ent, status: 'verified_total', total_won: ok[0].amt, message: '검증됨(sum_check=' + ok[0].sc + '): 상세 합이 문서 합계행과 일치. 그래도 부분집합일 수 있다.' });
    });
    const cav = [...COMMON, ...SPEC_CAV[a.dataset], s.cnt ? 'metric=count: 연도별 행 수·단건 사건 수만 — 소송 «전체 건수» 단정 금지.' : wantAmt ? '총액 규칙: sum_check=ok(또는 unit)이고 no_total_row 아닌 문서 1건일 때만 total_won 을 낸다. diff/none/기타는 «검증 불가/불일치» 로 행만, 다중 문서는 합산 안 함. 한 연도 값일 뿐 기관 간 비교·순위에 쓰지 말 것.' : 'metric=count: 연도별 행 수(총액 없음).'];
    if (hid.length) cav.push(`hold: ${hid.map(h => h.yr + '년').join('·')} — ` + HOLD(hid.map(h => h.n).join('·')));
    let zh = null; if (!years.length) { cav.push(ZERO); zh = await zeroHint(c, [s.code], insts); if (zh) cav.push(zh.hint); }
    const pg = { shown: years, total: years.length, has_more: false, exhaustive: false };
    const all = rows;
    return envelope(a.dataset, pg, { inst: name, group_by: 'year', metric: a.metric, year_totals: years, ...(zh ? { zero_row_hint: zh } : {}), source_doc_ids: [...new Set(all.map(r => r.doc_id))].slice(0, 20), quality: { sum_check: s.cnt ? '해당 없음' : [...new Set(all.map(r => r.sc))], coverage_warn: all.some(r => r.cw), multi_doc_round: all.some(r => r.mdr) } },
      { tables: ['rag_ext.' + s.view, 'rag_ext.b2_hidden_inst_years'] }, cav, asOf());
  }

  // ── 계약(contract_public·contract_small_agg) ─────────────────────────────────
  const US = `d.parse_flags && ARRAY['unit_suspect','unit_suspect_low','unit_suspect_est']::text[]`;
  const CONTRACT_NOTICE = n => `고정 고지: ① 500만원 이하 소액 수의계약은 건별 공시가 아니라 합산 공시라 이 건수·금액에 없고 별도 소액합산 ${n.n}건·약 ${Math.round(n.amt).toLocaleString('en-US')}원이 있다(기관·연도 단위). ② 사택·임차 계약 제외. ③ 금액은 VAT 포함/제외 혼재. ④ 단위 의심 행의 금액은 NULL(합계에서 빠짐). ⑤ .xls 원본 공시는 변환본 기준.`;
  const CT_CAV = ['scope=수의계약(70301) 공시 표만 — 경쟁입찰·전체 계약이 아니다. 공개용 뷰 contract_public(사택·임차·합계행 제외, 개인정보 처리) 기준.', '상대방(counterparty)은 법인 상대방만 노출하며 개인(마스킹·개인명 가능) 행은 이름을 숨긴다. 상대방명은 규칙 정규화라 표기가 다른 같은 업체가 갈라지거나 다른 업체가 합쳐질 수 있다.', '동일 계약이 여러 회차 문서에 중복 게재된 경우가 일부 남아 있고(약 1%), 기간 역전·장기 기간(period_suspect) 행이 있다.'];
  const contractWhere = (a, insts) => { const P = [], p = v => (P.push(v), '$' + P.length), w = [`d.inst_code = ANY(${p(insts.map(i => i.inst_code))})`];
    if (a.year) w.push(`d.target_year = ${p(a.year)}::int`);
    if (a.q) { const ph = p(H.likeEsc(a.q)); w.push(`(d.contract_name ILIKE '%' || ${ph} || '%' OR d.cp_key ILIKE '%' || ${ph} || '%')`); }
    return { w, P, p }; };
  async function smallAgg(c, insts, year) { const r = (await c.query(`SELECT target_year AS y, COALESCE(sum(small_agg_n), 0)::int AS n, COALESCE(sum(small_agg_amount), 0)::float8 AS amt FROM rag_ext.contract_small_agg WHERE inst_code = ANY($1)${year ? ' AND target_year = $2' : ''} GROUP BY 1 ORDER BY 1 DESC`, year ? [insts.map(i => i.inst_code), year] : [insts.map(i => i.inst_code)])).rows; return new Map(r.map(x => [x.y, x])); }
  async function contracts(c, a) {
    const insts = await pickInsts(c, a.inst), name = insts[0].inst_name, { w, P, p } = contractWhere(a, insts), sm = await smallAgg(c, insts, a.year), cav = [...COMMON, ...CT_CAV];
    if (a.metric) {
      const rows = (await c.query(`SELECT d.target_year AS y, count(*)::int AS n, count(DISTINCT d.doc_id)::int AS n_docs, sum(d.amount_won)::float8 AS amt, count(*) FILTER (WHERE d.amount_won IS NULL)::int AS n_null, count(*) FILTER (WHERE ${US})::int AS n_unit, bool_or(d.coverage_warn) AS cw, count(*) FILTER (WHERE d.period_suspect)::int AS n_ps, (array_agg(DISTINCT d.doc_id))[1:5] AS docs FROM rag_ext.contract_public d WHERE ${w.join(' AND ')} GROUP BY 1 ORDER BY 1 DESC NULLS LAST LIMIT ${p(Math.min(a.limit || 50, 60))}`, P)).rows;
      const ys = new Map(rows.map(r => [r.y, r])); for (const y of sm.keys()) if (!ys.has(y) && y != null) ys.set(y, { y, n: 0, n_docs: 0, amt: 0, n_null: 0, n_unit: 0, cw: false, n_ps: 0, docs: [] });
      const out = [...ys.values()].sort((x, y) => (y.y || 0) - (x.y || 0)).map(r => { const sa = sm.get(r.y) || { n: 0, amt: 0 };
        return compact({ year: r.y == null ? '연도미상' : r.y, count: r.n, ...(a.metric === 'amount' ? { amount_won_excl_small: r.amt } : {}), small_agg_n: sa.n, small_agg_amount: sa.amt, rows_amount_null: r.n_null || null, rows_unit_suspect: r.n_unit || null, rows_period_suspect: r.n_ps || null, n_docs: r.n_docs, coverage_warn: r.cw || null, source_doc_ids: r.docs, notice: CONTRACT_NOTICE({ n: sa.n, amt: sa.amt }) }); });
      cav.push(a.metric === 'amount' ? '금액은 사택 제외·소액합산 제외·단위 의심 행 NULL 제외 합이다 — 실제 총액보다 작을 수 있다(small_agg 별도). 기관 1곳·연도별 값이며 기관 간 비교·순위에 쓰지 말 것.' : '건수는 소액합산을 제외한 건별 공시 행 수(small_agg_n 별도).');
      let zh = null; if (!out.length) { cav.push(ZERO); zh = await zeroHint(c, ['70301'], insts); if (zh) cav.push(zh.hint); }
      const allDocs = out.flatMap(r => r.source_doc_ids || []);
      return envelope('contracts', { shown: out, total: out.length, has_more: false, exhaustive: false }, { inst: name, group_by: 'year', metric: a.metric, scope: '수의계약만', year_totals: out, ...(zh ? { zero_row_hint: zh } : {}), source_doc_ids: [...new Set(allDocs)].slice(0, 20), quality: { sum_check: '해당 없음', coverage_warn: out.some(r => r.coverage_warn) || false, multi_doc_round: '해당 없음' } },
        { tables: ['rag_ext.contract_public', 'rag_ext.contract_small_agg'] }, cav, asOf());
    }
    const rows = (await c.query(`SELECT d.doc_id, d.contract_name, d.first_date::text AS first_date, d.change_date::text AS change_date, d.period_start::text AS period_start, d.period_end::text AS period_end, d.first_amount::float8 AS first_amount, d.final_amount::float8 AS final_amount, d.amount_won::float8 AS amount_won, d.est_price::float8 AS est_price, d.cp_key AS counterparty, d.counterparty_class2 AS counterparty_class, left(d.content, 200) AS content, left(d.reason, 200) AS reason, d.contract_type, d.contract_method, d.target_year, d.round_label, d.source_file, d.coverage_warn, d.period_suspect, (${US}) AS unit_suspect, count(*) OVER ()::int AS total
        FROM rag_ext.contract_public d WHERE ${w.join(' AND ')} ORDER BY d.first_date DESC NULLS LAST, d.row_id LIMIT ${p(a.limit + 1)} OFFSET ${p(a.offset || 0)}`, P)).rows;
    const hasMore = rows.length > a.limit, shown = rows.slice(0, a.limit), off = a.offset || 0, total = rows.length ? rows[0].total : 0;
    const out = shown.map(r => { const o = { inst: name, ...r }; delete o.total; if (!o.counterparty) { o.counterparty = '(개인·비공개)'; } if (!o.unit_suspect) delete o.unit_suspect; else o.amount_note = '단위 의심 — 금액 NULL 처리 가능'; if (!o.period_suspect) delete o.period_suspect; if (!o.coverage_warn) delete o.coverage_warn; return compact(o); });
    const sa = [...sm.values()].reduce((t, x) => ({ n: t.n + x.n, amt: t.amt + x.amt }), { n: 0, amt: 0 });
    cav.push(CONTRACT_NOTICE(sa) + (a.year ? '' : ' (소액합산은 지정 기관 전 연도 합)'));
    if (hasMore) cav.push(`limit(${a.limit}) 절단 — 전체가 아니다. total 이 조건에 맞는 행 수.`);
    let zh = null; if (!out.length) { cav.push(ZERO); zh = await zeroHint(c, ['70301'], insts); if (zh) cav.push(zh.hint); }
    return envelope('contracts', { shown: out, total, has_more: hasMore, ...(hasMore && a.limit ? { next_offset: off + a.limit } : {}), exhaustive: false }, { inst: name, scope: '수의계약만', rows: out, ...(zh ? { zero_row_hint: zh } : {}), small_agg: { n: sa.n, amount_won: sa.amt }, source_doc_ids: uniq(shown, 'doc_id', 20), source_files: uniq(shown, 'source_file', 10), quality: { sum_check: '해당 없음', coverage_warn: shown.some(r => r.coverage_warn), multi_doc_round: '해당 없음' } },
      { tables: ['rag_ext.contract_public', 'rag_ext.contract_small_agg'] }, cav, asOf());
  }

  const RUN = { contracts: (c, a) => contracts(c, a) };
  for (const k of Object.keys(SPEC)) RUN[k] = (c, a) => (a.metric ? yearly(c, a) : list(c, a));
  return { names, ALLOWED, validate, RUN, SPEC, RANK_PARAMS, refuse };
};
