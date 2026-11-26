'use strict';
/**
 * FindCases: find_cases(사례 카드 검색). rag_ext.card_items(LLM 추출 카드: 요지·결과·원문 인용·위치)에서 다기관 사례를 거른다.
 * 플래그: MCP_FIND_CASES=on(기본 off, 마운트는 mcp_server.js) · MCP_FIND_CASES_EXTERNAL=on(기본 off — external·미지정 tier 비노출).
 * 설정(env, 호출마다 읽음 — CardQA 검증 결과 반영용): FIND_CASES_RUN(기본 cp_full_p3) · FIND_CASES_CODES(노출 코드) · FIND_CASES_MIN_CONF(high|medium|low, 기본 medium=low 제외)
 *   · FIND_CASES_FAVOR(on|off) · FIND_CASES_FAVOR_CODES · FIND_CASES_EXCLUDE_TYPES(쉼표) · FIND_CASES_PER_MIN · FIND_CASES_CONC
 * 규칙: READ ONLY·값 바인딩·정규식 비허용(키워드는 escape 한 LIKE)·limit≤30·동시 2·분당 한도·statement_timeout 5s·순위/최다/집계 요구 거부·응답 문자열 마스킹.
 * 카드는 «파일럿 표본» 이다 — 응답에 exhaustive=false·coverage·고지를 항상 싣는다.
 */
const { resolveInst } = require('./inst_alias.js');
const QX = require('./query_expand.js');
const { maskText, maskOptsForTier } = require('./mask_pii.js');

const CODE_NAME = { 21028: '노사협의회', 63795: '단체협약', 63796: '노사합의·임금협약', 43006: '감사결과', 43005: '이사회', B1220: '감사원 등 지적', B1230: '경영평가', 42605: '대내외 평가', B1210: '국회 지적' };
// C2View(방안 A): card2_* 코드는 호환 뷰 rag_ext.card2_find_v 에서 읽는다(뷰 없으면 해당 코드만 조용히 꺼짐). 제출일이 없는 코드(NODATE)는 months/from/to 대신 ref_year(기준연도)로 거른다.
const C2 = new Set(['B1220', 'B1230', '42605', 'B1210']), NODATE = new Set(['B1220', 'B1210']), EVAL = new Set(['B1230', '42605']);
const C2_SAMPLE = { B1220: '2022년~ 공시 대표 표본', B1210: '2024년~ 공시 표본' };
const TAGS = ['임금', '수당', '휴가', '복지', '채용', '안전', '징계', '계약', '재무', '인사', '근로시간', '조직', '교육', '노사관계', '기타'];
const FAVORS = ['favorable', 'neutral', 'unfavorable', 'unknown'];
const RANK_PARAMS = ['rank', 'order', 'order_by', 'sort', 'top', 'top_n', 'compare', 'desc', 'group_by', 'count'];
const BAD_Q = /(최다|순위|랭킹|상위|가장\s*많|제일\s*많|횟수|몇\s*번|몇\s*건|비율|퍼센트|전체\s*합계|전\s*기관|몇\s*곳|몇\s*개)/;
const KEYS = ['ref_year', 'basis', 'like_inst', 'like_by', 'date_basis', 'with_basis', 'topic', 'type', 'code', 'result', 'favor', 'months', 'from', 'to', 'inst', 'ministry', 'distinct_inst', 'per_inst', 'limit', 'offset', 'cursor', 'include_old', 'include_low', 'brief'];
const bad = m => Object.assign(new Error(m), { code: 'BAD_REQUEST' });
const refuse = m => Object.assign(new Error('거부: ' + m), { code: 'BAD_REQUEST' });
const intIn = (v, d, lo, hi) => { const n = parseInt(v, 10); return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : d)); };
const likeEsc = s => String(s).replace(/[\\%_]/g, '\\$&');
const csv = s => String(s == null ? '' : s).split(',').map(x => x.trim()).filter(Boolean);
const ALT = '대체 경로: scan_documents(terms·item 코드·months — 문서 본문 전수 문자열 검색)·search_corpus(item·months)·get_document(doc_id, find=표현).';

const fs = require('fs'), path = require('path');
// 핫 스위치 설정 파일(JSON, 30초마다 mtime 확인 — 재시작 불필요): FIND_CASES_CONFIG(기본 /app/data/find_cases.json). 키: codes·min_conf·favor·favor_codes·favor_filter_off_codes·exclude_types.
// 우선순위: 파일 > env > 기본값. 기본 노출 코드는 CardQA 결론에 따라 43005·43006 만(노사 코드는 재추출 후 켠다).
let FILE = {}, fmt = -1, fchk = 0;
function fileCfg() {
  const now = Date.now(); if (fmt !== -1 && now - fchk < 30000) return FILE; fchk = now;
  try { const f = process.env.FIND_CASES_CONFIG || path.join(__dirname, 'data', 'find_cases.json'), m = fs.statSync(f).mtimeMs; if (f + m !== fmt) { FILE = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; fmt = f + m; } } catch { FILE = {}; fmt = 0; }   // 파일이 없거나 깨지면 빈 설정(env·기본값)으로 — 삭제 후 옛 값이 남지 않게
  return FILE;
}
const lst = v => Array.isArray(v) ? v.map(String) : csv(v);
function cfg() {
  const e = process.env, F = fileCfg(), pick = (k, ev, d) => F[k] != null ? F[k] : ev != null ? ev : d;
  const codes = lst(pick('codes', e.FIND_CASES_CODES, '43005,43006')).filter(c => CODE_NAME[c]);
  const mcn = pick('min_conf', e.FIND_CASES_MIN_CONF, 'medium'), mc = ['high', 'medium', 'low'].includes(mcn) ? mcn : 'medium';
  return { run: e.FIND_CASES_RUN || 'cp_full_p3', codes, minConf: { high: 3, medium: 2, low: 1 }[mc], minConfName: mc,
    favorOn: String(pick('favor', e.FIND_CASES_FAVOR, 'on')) !== 'off', favorCodes: lst(pick('favor_codes', e.FIND_CASES_FAVOR_CODES, '21028,63795,63796')),
    favorOffCodes: lst(pick('favor_filter_off_codes', e.FIND_CASES_FAVOR_OFF_CODES, '21028')),   // 이 코드는 favor 필터·표시 제공 안 함(CardQA: 정확도 75%)
    exTypes: lst(pick('exclude_types', e.FIND_CASES_EXCLUDE_TYPES, '')),
    // 코드별 덮어쓰기(파일 전용): {"43006":{"min_conf":"high","exclude_types":["기타"]}} — 없는 키는 전역값
    perCode: (() => { const pc = F.per_code && typeof F.per_code === 'object' ? F.per_code : {}, o = {}; for (const k of Object.keys(pc)) if (CODE_NAME[k] && pc[k] && typeof pc[k] === 'object') {
      const m = pc[k].min_conf; o[k] = { minConf: m != null ? ({ high: 3, medium: 2, low: 1 }[m] || null) : null, exTypes: pc[k].exclude_types != null ? lst(pc[k].exclude_types) : null }; } return o; })(),
    basisOn: String(pick('with_basis', e.FIND_CASES_WITH_BASIS, 'on')) !== 'off', perMin: intIn(e.FIND_CASES_PER_MIN, 0, 0, 10000), conc: intIn(e.FIND_CASES_CONC, 2, 1, 8) };
}

// 카드 테이블 신규 컬럼 존재 여부(재추출·후처리로 추가 예정) — 있으면 사용, 없으면 현재 컬럼으로 폴백. 60초 캐시.
const NEWCOLS = ['result_norm', 'result_list', 'favor_post', 'content_date', 'is_repost', 'dup_group', 'quality', 'inst_mismatch'];
let colCache = { t: 0, v: {} };
async function cols(withPooled) {
  if (Date.now() - colCache.t < 60000) return colCache.v;
  const rows = await withPooled(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='3s'"], async c => (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='rag_ext' AND table_name='card_items' AND column_name = ANY($1::text[])", [NEWCOLS])).rows);
  const v = {}; for (const r of rows) v[r.column_name] = true; colCache = { t: Date.now(), v }; return v;
}

let tabCache = { t: 0, v: {} };
async function tabs(withPooled) {   // 60초 캐시. 테이블이 없으면 해당 기능만 조용히 꺼진다(기존 동작 유지)
  if (Date.now() - tabCache.t < 60000) return tabCache.v;
  const rows = await withPooled(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='3s'"], async c => (await c.query("SELECT to_regclass('rag_ext.card_event') IS NOT NULL ev, to_regclass('rag_ext.card_cite_link') IS NOT NULL cite, to_regclass('public.inst_meta') IS NOT NULL im, to_regclass('rag_ext.card2_find_v') IS NOT NULL c2")).rows);
  tabCache = { t: Date.now(), v: rows[0] || {} }; return tabCache.v;
}

// ── 입력 정리(순수 함수 — 단위 시험 대상) ──
function normalize(a, C) {
  a = a && typeof a === 'object' && !Array.isArray(a) ? a : {};
  for (const k of Object.keys(a)) if (RANK_PARAMS.includes(k)) throw refuse(`${k}: 순위·정렬·집계·기관 간 비교는 제공하지 않습니다(카드는 파일럿 표본이라 «최다·순위» 가 틀립니다). 사례 목록을 읽고 판단하세요.`);
  const o = {}, ignored = Object.keys(a).filter(k => !KEYS.includes(k));
  const txt = (k, lo, hi) => { if (a[k] == null || a[k] === '') return null; const s = String(a[k]).replace(/\s+/g, ' ').trim(); if ([...s.replace(/\s/g, '')].length < lo || [...s].length > hi) throw bad(`${k} 는 ${lo}~${hi}자`); if (BAD_Q.test(s)) throw refuse(`${k} 에 순위·최다·건수·비율 등 통계 요구가 들어 있습니다 — 이 도구는 사례 카드를 거르는 용도입니다`); return s; };
  o.topic = txt('topic', 2, 60); o.type = txt('type', 2, 20); o.result = txt('result', 2, 20); o.inst = txt('inst', 2, 40); o.ministry = txt('ministry', 2, 40);
  if (o.topic) { o.terms = [...new Set(o.topic.split('|').map(s => s.trim()).filter(Boolean))]; if (o.terms.length > 6 || o.terms.some(t => [...t.replace(/\s/g, '')].length < 2 || [...t].length > 20)) throw bad('topic 은 «A|B» 최대 6개, 각 2~20자'); }
  if (a.code != null && a.code !== '') { o.code = String(a.code).trim(); if (!CODE_NAME[o.code]) throw bad('code 는 ' + Object.keys(CODE_NAME).join('·') + ' 중 하나(list_catalog(kind="case_codes") 참조)'); if (!C.codes.includes(o.code)) throw bad('code ' + o.code + '(' + CODE_NAME[o.code] + ') 카드는 현재 제공하지 않습니다(독립 검증 결과 재추출 전까지 비활성). ' + ALT); }
  if (a.favor != null && a.favor !== '') {
    if (!C.favorOn) throw bad('favor 필터는 현재 제공하지 않습니다(유불리 판단은 모델 산출물로 검증 중). favor 없이 호출하세요.');
    o.favor = String(a.favor).trim(); if (!FAVORS.includes(o.favor)) throw bad('favor 는 ' + FAVORS.join('|'));
    if (o.code && C.favorOffCodes.includes(o.code)) throw bad('code ' + o.code + ' 는 favor 필터를 제공하지 않습니다(유불리 판정 정확도 낮음).');
    if (o.code && !C.favorCodes.includes(o.code)) throw bad('favor 는 노사 코드(' + C.favorCodes.join('·') + ')에만 있습니다');
  }
  o.basis = txt('basis', 2, 60);
  if (o.basis) { const m = /^(.+?)\s*(?:제\s*(\d{1,4})\s*조(?:\s*의\s*(\d{1,3}))?)?$/.exec(o.basis); o.basisLaw = m[1].trim(); o.basisArt = m[2] ? +m[2] : null; o.basisSub = m[3] ? +m[3] : null; if ([...o.basisLaw.replace(/\s/g, '')].length < 2) throw bad('basis 는 «법령·내규명 [제N조]» (예: 근로기준법 제56조)'); }
  for (const k of ['type', 'result']) if (o[k] && o[k].includes('|')) { const t = [...new Set(o[k].split('|').map(x => x.trim()).filter(Boolean))]; if (t.length > 4 || t.some(x => [...x].length < 2)) throw bad(k + ' 의 A|B 는 최대 4개, 각 2자 이상'); o[k + 's'] = t; }
  o.likeInst = txt('like_inst', 2, 40);
  if (o.likeInst) { const lb = csv(a.like_by == null || a.like_by === '' ? 'type,size' : Array.isArray(a.like_by) ? a.like_by.join(',') : a.like_by); if (!lb.length || lb.some(x => !['type', 'size', 'ministry', 'region'].includes(x))) throw bad('like_by 는 type|size|ministry|region 의 쉼표 목록(기본 type,size)'); o.likeBy = [...new Set(lb)]; }
  else if (a.like_by != null && a.like_by !== '') throw bad('like_by 는 like_inst 와 함께만 씁니다');
  o.dateBasis = a.date_basis == null || a.date_basis === '' ? 'submitted' : String(a.date_basis); if (!['submitted', 'content'].includes(o.dateBasis)) throw bad('date_basis 는 submitted(제출일, 기본)|content(본문 회의일, 없으면 제출일)');
  o.withBasis = a.with_basis == null || a.with_basis === '' ? true : a.with_basis === true || a.with_basis === 'true';
  o.months = a.months == null || a.months === '' ? null : (() => { if (!/^\d+$/.test(String(a.months).trim())) throw bad('months 는 1~24 정수'); return intIn(a.months, 12, 1, 24); })();
  o.inputNotes = [];
  const day = (v, n) => {
    if (v == null || v === '') return null; let s = String(v).trim();
    if (/^20\d{2}$/.test(s)) { const r = n === 'from' ? s + '-01-01' : s + '-12-31'; o.inputNotes.push(`${n}="${s}"(연도 4자리)를 ${r} 로 해석했다.`); return r; }
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw bad(`${n} 는 YYYY-MM-DD 날짜(예: ${n}="${n === 'from' ? '2025-01-01' : '2025-12-31'}") 또는 연도 4자리(예: "2025")여야 합니다(받은 값 «${s.slice(0, 20)}»). 최근 N개월은 months(1~24)를 쓰세요.`);
    return s;
  };
  o.from = day(a.from, 'from'); o.to = day(a.to, 'to');
  if (o.months) { const d = new Date(Date.now() + 9 * 3600e3); d.setUTCMonth(d.getUTCMonth() - o.months); const c = d.toISOString().slice(0, 10); if (!o.from || c > o.from) o.from = c; }
  const bo = (v, d) => v == null ? d : v === true || v === 'true' ? true : v === false || v === 'false' ? false : d;
  o.distinct = bo(a.distinct_inst, true); o.per = intIn(a.per_inst, 1, 1, 2); o.limit = intIn(a.limit, 10, 1, 30);
  o.includeOld = bo(a.include_old, false); o.includeLow = bo(a.include_low, false); o.brief = bo(a.brief, true);
  const off = a.offset != null && a.offset !== '' ? a.offset : a.cursor;
  if (off != null && off !== '') { if (!/^\d{1,6}$/.test(String(off).trim())) throw bad('offset·cursor 는 직전 응답의 next_offset(0 이상 정수)'); o.offset = +off; } else o.offset = 0;
  if (o.favor && !o.code) o.codes = C.codes.filter(c => C.favorCodes.includes(c) && !C.favorOffCodes.includes(c));
  if (o.favor && !o.code && !o.codes.length) throw bad('favor 필터를 제공하는 코드가 현재 노출되어 있지 않습니다. favor 없이 호출하세요.');
  // C2View: 기준연도(ref_year) 필터 — card2 코드 전용. «2024» 또는 «2022-2024»
  if (a.ref_year != null && a.ref_year !== '') {
    const m = /^(20\d{2})\s*(?:[-~]\s*(20\d{2}))?$/.exec(String(a.ref_year).trim()); if (!m || (m[2] && +m[2] < +m[1])) throw bad('ref_year 는 2024 또는 2022-2024 형식입니다(예: ref_year="2024"). 사용 가능한 code 는 list_catalog(kind="case_codes") 로 확인하세요.');
    o.refFrom = +m[1]; o.refTo = +(m[2] || m[1]);
    if (o.code && !C2.has(o.code)) throw bad('ref_year 는 ' + [...C2].join('·') + ' 카드에만 씁니다(노사·이사회·감사 카드는 months·from·to). 코드별 사용법은 list_catalog(kind="case_codes") 로 확인하세요. 예: code="' + [...C2][0] + '", ref_year="2024"');
    if (o.favor) throw bad('ref_year 와 favor 는 함께 쓸 수 없습니다(favor 는 노사 코드 전용)');
    if (!o.code) { o.codes = C.codes.filter(c => C2.has(c)); if (!o.codes.length) throw bad('ref_year 를 쓰는 코드(' + [...C2].join('·') + ')가 현재 노출되어 있지 않습니다. list_catalog(kind="case_codes") 로 노출된 코드를 확인하고, ref_year 없이 months(예: months=12)로 거르세요.'); }
  }
  if (o.code && NODATE.has(o.code) && (o.from || o.to)) throw bad('code ' + o.code + '(' + CODE_NAME[o.code] + ') 카드에는 제출일이 없어 months·from·to 를 쓸 수 없습니다 — 기준연도 ref_year(예 2024 또는 2022-2024)로 거르세요. 예: code="' + o.code + '", ref_year="2024"');
  o.ignored = ignored;
  return o;
}

// ── 카드 원천: card_items(기존 run) ∪ card2_find_v(호환 뷰, 적재된 run 만) — 같은 열 형태로 맞춘 UNION ──
// 새 컬럼(NEWCOLS)은 card_items 에 실제로 있는 것(K)만 싣고 ::text(content_date 는 ::date)로 맞춰 뷰와 타입 충돌을 피한다. card_id 는 두 테이블에서 겹치므로 (run_id, card_id) 가 키다.
function srcSql(C, K, T, codes, p) {
  const nc = ['result_norm', 'result_list', 'favor_post', 'content_date', 'is_repost', 'dup_group', 'quality', 'inst_mismatch'].filter(x => K[x]);
  const base = 'card_id, run_id, doc_id, inst_code, inst_name, submitted_at, code, case_type, topics, summary, result, quote, quote_start, quote_end, favor, favor_reason, confidence';
  const lg = codes.filter(c => !C2.has(c)), c2 = T.c2 ? codes.filter(c => C2.has(c)) : [];
  const V2 = new Set(['result_norm', 'result_list', 'favor_post', 'is_repost', 'quality', 'inst_mismatch']);
  const ty = x => x === 'content_date' ? '::date' : '::text';
  const a = () => `SELECT 'c1'::text src, ${base}, NULL::int ref_year, NULL::text authority, NULL::text subject${nc.map(x => `, ${x}${ty(x)} AS ${x}`).join('')} FROM rag_ext.card_items WHERE run_id = ${p(C.run)} AND code = ANY(${p(lg)}::text[])`;
  const b = () => `SELECT 'c2'::text src, ${base}, ref_year, authority, subject${nc.map(x => V2.has(x) ? `, ${x}${ty(x)} AS ${x}` : `, NULL${ty(x)} AS ${x}`).join('')} FROM rag_ext.card2_find_v WHERE code = ANY(${p(c2)}::text[])`;
  return '(' + (c2.length ? (lg.length ? a() + ' UNION ALL ' + b() : b()) : a()) + ')';   // 쓰지 않는 가지는 파라미터도 만들지 않는다(미사용 $n 은 PG 타입 추론 오류)
}

// ── 카드 필터 SQL ──
function build(o, C, K = {}, T = {}, ref = null) {
  const P = [], p = v => { P.push(v); return '$' + P.length; }, w = [];
  const codes = o.code ? [o.code] : (o.codes || C.codes);
  if (!T.c2 && codes.some(c => C2.has(c)) && o.code) throw bad('code ' + o.code + '(' + CODE_NAME[o.code] + ') 카드는 현재 사용할 수 없습니다(호환 뷰 rag_ext.card2_find_v 없음).');
  const src = srcSql(C, K, T, codes, p);
  if (o.refFrom != null) w.push('c.ref_year BETWEEN ' + p(o.refFrom) + '::int AND ' + p(o.refTo) + '::int');
  const pcs = Object.keys(C.perCode).filter(k => C.perCode[k].minConf);
  const conf = `CASE c.confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END >= ` + (pcs.length
    ? `CASE c.code ${pcs.map(k => `WHEN ${p(k)}::text THEN ${p(C.perCode[k].minConf)}::int`).join(' ')} ELSE ${p(C.minConf)}::int END` : `${p(C.minConf)}`);
  let join = '';
  // 날짜 기준: content = 본문 회의일(content_date, 없으면 제출일). 컬럼이 없으면 제출일로 폴백(응답에 date_basis_effective 로 알림)
  const contentOk = o.dateBasis === 'content' && K.content_date, de = contentOk ? 'LEAST(COALESCE(c.content_date, c.submitted_at), c.submitted_at)' : 'c.submitted_at';   // 회의일이 제출일보다 뒤인 값(240장·모두 30일 이내, 예정일·오추출 가능)은 제출일로 눌러 쓴다
  if (o.from) { const s = de + ' >= ' + p(o.from) + '::date'; w.push(s); }
  if (o.to) { const s = de + ' <= ' + p(o.to) + '::date'; w.push(s); }
  let needI = false;
  if (ref) {   // 유사 기관: 기준 기관과 같은 inst_meta 속성(유형·규모·지역)·같은 부처, 기준 기관 자신은 제외
    w.push('c.inst_code <> ' + p(ref.inst_code));
    const lb = o.likeBy; join += ' JOIN public.inst_meta im ON im.inst_code = c.inst_code';
    if (lb.includes('type')) w.push('im.inst_type = ' + p(ref.inst_type));
    if (lb.includes('size')) w.push('im.size_bucket = ' + p(ref.size_bucket));
    if (lb.includes('region')) w.push('im.region = ' + p(ref.region));
    if (lb.includes('ministry')) { needI = true; w.push('i.ministry = ' + p(ref.ministry)); }
  }
  let instName = null, mi = null;
  if (o.inst) { instName = resolveInst(o.inst); const s = `c.inst_name ILIKE '%'||${p(likeEsc(instName))}||'%'`; w.push(s); }
  if (o.ministry) { mi = QX.resolveMinistry(o.ministry); needI = true; const s = `i.ministry ILIKE '%'||${p(likeEsc(String(mi.value)))}||'%'`; w.push(s); }
  if (needI) join += ' JOIN institutions i ON i.inst_code = c.inst_code';
  const f = [conf], ovr = Object.keys(C.perCode).filter(k => C.perCode[k].exTypes);
  if (C.exTypes.length) f.push('(c.code = ANY(' + p(ovr) + '::text[]) OR c.case_type <> ALL(' + p(C.exTypes) + '::text[]))');
  for (const k of ovr) if (C.perCode[k].exTypes.length) f.push('NOT (c.code = ' + p(k) + '::text AND c.case_type = ANY(' + p(C.perCode[k].exTypes) + '::text[]))');
  const modes = [], sh = [];
  if (o.terms) {
    const ors = [];
    for (const t of o.terms) {
      if (TAGS.includes(t)) { ors.push('c.topics @> ARRAY[' + p(t) + ']::text[]'); modes.push({ term: t, mode: 'tag' }); }
      else { const ph = p(likeEsc(t.toLowerCase().replace(/\s/g, '')));
        ors.push(`regexp_replace(lower(coalesce(c.summary,'') || ' ' || c.quote), '\\s', '', 'g') LIKE '%'||${ph}||'%'`); sh.push(`regexp_replace(lower(coalesce(c.summary,'')), '\\s', '', 'g') LIKE '%'||${ph}||'%'`); modes.push({ term: t, mode: 'keyword' }); }
    }
    f.push('(' + ors.join(' OR ') + ')');
  }
  if (o.type) f.push('(' + (o.types || [o.type]).map(t => `c.case_type ILIKE '%'||${p(likeEsc(t))}||'%'`).join(' OR ') + ')');
  if (o.result) {   // result_norm·result_list(다값 카드)가 있으면 함께 본다 — 단일 result 만 보면 다값 카드를 놓친다. A|B = OR(최대 4)
    const rs = [];
    for (const rr of (o.results || [o.result])) {
      const r = likeEsc(rr), pr = p(r), pn = p('미' + r), ex = [`(c.result ILIKE '%'||${pr}||'%' AND c.result NOT ILIKE '%'||${pn}||'%')`];
      if (K.result_norm) ex.push(`(c.result_norm::text ILIKE '%'||${pr}||'%' AND c.result_norm::text NOT ILIKE '%'||${pn}||'%')`);
      if (K.result_list) ex.push(`(c.result_list::text ILIKE '%'||${pr}||'%' AND c.result_list::text NOT ILIKE '%'||${pn}||'%')`);
      rs.push('(' + ex.join(' OR ') + ')');
    }
    f.push('(' + rs.join(' OR ') + ')');
  }
  if (o.basisLaw) {   // 근거 법령·내규 필터(card_cite_link): 법령명 부분일치 [+ 조문]
    if (!T.cite) throw bad('basis 필터는 현재 사용할 수 없습니다(근거 연결 테이블 없음).');
    const nm = p(likeEsc(o.basisLaw)), art = o.basisArt != null ? ` AND l.art_no = ${p(o.basisArt)}::int` + (o.basisSub != null ? ` AND COALESCE(l.art_sub,0) = ${p(o.basisSub)}::int` : '') : '';
    f.push(`EXISTS (SELECT 1 FROM rag_ext.card_cite_link l WHERE l.run_id = c.run_id AND l.card_id = c.card_id AND (COALESCE(l.dst_title,'') ILIKE '%'||${nm}||'%' OR COALESCE(l.name_raw,'') ILIKE '%'||${nm}||'%')${art})`);
  }
  const fv = K.favor_post ? 'COALESCE(c.favor_post, c.favor)' : 'c.favor';   // 후처리 컬럼이 있으면 그것(모델 의견)
  if (o.favor) f.push(fv + ' = ' + p(o.favor));
  const tr = x => `COALESCE(c.${x}::text, 'false') IN ('true','t','1')`;
  if (K.inst_mismatch) f.push('NOT (' + tr('inst_mismatch') + ')');
  if (K.quality && !o.includeLow) f.push("COALESCE(c.quality::text, '') <> 'low'");
  // 재게시 의심(근사): 제목 앞 yymmdd 가 제출연도-1 보다 과거이거나, 제목·요지·인용에 연도 표기가 있는데 제출연도-1 이후 연도가 하나도 없음 → 본문 회의일이 과거인 재게시로 본다(카드에 회의일 필드가 없어 텍스트 규칙만).
  const t = `(coalesce(d.doc_title,'') || ' ' || coalesce(c.summary,'') || ' ' || c.quote)`, Y = 'extract(year FROM c.submitted_at)::int';
  const old = `((CASE WHEN d.doc_title ~ '^[0-9]{6}[_ ]' THEN 2000 + substr(d.doc_title, 1, 2)::int < ${Y} - 1 ELSE false END)
    OR (${t} ~ '20[0-9]{2}\\s*년' AND ${t} !~ ('(' || (${Y} - 1) || '|' || ${Y} || ')\\s*(년|\\.\\s*[0-9]|-[0-9]|/[0-9])')))`;
  // 재게시: 신규 컬럼(is_repost·content_date)이 있으면 그것(content_date 가 제출일보다 12개월 넘게 앞서면 재게시), 없으면 위 텍스트 근사.
  const oc = []; if (K.is_repost) oc.push(tr('is_repost')); if (K.content_date) oc.push("(c.content_date IS NOT NULL AND c.content_date < c.submitted_at - interval '12 months')");
  return { P, src, where: w.concat(f).join(' AND '), join, old: "(c.src = 'c1' AND COALESCE(" + (oc.length ? '(' + oc.join(' OR ') + ')' : old) + ', false))', oldSource: oc.length ? 'columns' : 'text_heuristic', modes, instName, mi, fv, shit: sh.length ? '(' + sh.join(' OR ') + ')' : 'FALSE',
    de, contentOk, jev: T.ev ? ' LEFT JOIN rag_ext.card_event ev ON ev.run_id = c.run_id AND ev.card_id = c.card_id' : '',
    dk: (() => { const base = K.dup_group ? "CASE WHEN c.dup_group IS NULL THEN c.run_id || ':' || c.card_id::text ELSE c.dup_group::text END" : null;   // 같은 사건: card_event(event_id) 우선, 없으면 dup_group
      return T.ev ? `COALESCE(ev.event_id, ${base || "c.run_id || ':' || c.card_id::text"})` : base; })() };
}

// ── 응답 ──
function cardOut(r, o, C, basisBy) {
  const cap = o.brief ? [200, 240] : [500, 800], cut = (s, n) => (s && [...s].length > n ? [...s].slice(0, n).join('') + '…' : s);
  const q = r.quote || '', c = {
    card_id: Number(r.card_id), ...(r.src === 'c2' ? { card_run: r.run_id } : {}), inst_name: r.inst_name, submitted_at: r.submitted_at || undefined, ...(r.ref_year ? { ref_year: r.ref_year } : {}), code: r.code, case_type: r.case_type, topics: r.topics,
    summary: cut(r.summary, cap[0]), result: r.result || undefined, quote: cut(q, cap[1]), ...([...q].length > cap[1] ? { quote_truncated: true } : {}), quote_span: [r.quote_start, r.quote_end],
    confidence: r.confidence, doc_id: r.doc_id, doc_title: cut(r.doc_title, 80), ...(r.maybe_old ? { maybe_reposted: true } : {}),
    ...(r.content_date ? { content_date: dayStr(r.content_date) } : {}), ...(r.ev_size > 1 ? { same_event_cards: r.ev_size, same_event_note: '같은 기관의 같은 내용 카드가 ' + r.ev_size + '장(재게시·수정공시·동일 합의서 복수 게시) — 이 카드를 대표로 보인다' } : {}) };
  if (r.src === 'c2') { if (r.subject) c.subject = r.subject; if (EVAL.has(r.code) && r.result) c.result_item = r.subject || undefined;   // 등급은 인용에 literal 로 있던 지표·항목별 등급일 수 있다 — 항목명(subject)을 함께 표시
       if (r.authority) c.authority = r.authority; }   // B1220: 감사원 / 주무부처 구분
  const bs = (basisBy && basisBy.get(r.run_id + ':' + r.card_id)) || null;
  if (bs) c.legal_basis = bs;
  if (r.s_hit) c.matched_in = 'summary'; else if (o.terms && o.terms.length && r.s_hit === false) c.matched_in = 'quote';
  if (C.favorOn && !C.favorOffCodes.includes(r.code) && r.favor && r.favor !== 'not_applicable') c.favor = { value: r.favor, reason: r.favor_reason, by: 'model_opinion' };
  return c;
}
const dayStr = d => (d instanceof Date ? new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10) : d == null ? d : String(d).slice(0, 10));
const SKIPM = new Set(['doc_id', 'inst_code', 'submitted_at', 'code', 'card_id', 'quote_span', 'confidence', 'value', 'by']);
function maskDeep(v, mo, key) {
  if (typeof v === 'string') return key && SKIPM.has(key) ? v : maskText(v, mo).text;
  if (Array.isArray(v)) return v.map(x => maskDeep(x, mo, key));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = maskDeep(v[k], mo, k); return o; }
  return v;
}

let running = 0; const hits = new Map(), cache = new Map();
function limited(ctx, C) {
  if (!ctx) return false;
  const ext = ctx.tier !== 'internal' && ctx.tier !== 'master', max = C.perMin || (ext ? 6 : 30), k = ctx.tier + ':' + (ctx.label || ''), now = Date.now();
  const a = (hits.get(k) || []).filter(t => now - t < 60000);
  if (a.length >= max) { hits.set(k, a); return { max, retry: Math.max(1, Math.ceil((a[0] + 60000 - now) / 1000)) }; }
  a.push(now); hits.set(k, a); if (hits.size > 2000) for (const [kk, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(kk);
  return false;
}

async function lookupRef(withPooled, o, T) {
  if (!T.im) throw bad('like_inst 는 기관 메타(inst_meta)가 있어야 합니다 — 현재 사용 불가');
  const nm = resolveInst(o.likeInst);
  const rs = await withPooled(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='3s'"], async c => {
    const sql = x => `SELECT i.inst_code, i.inst_name, i.ministry, m.inst_type, m.region, m.emp, m.size_bucket FROM institutions i LEFT JOIN public.inst_meta m ON m.inst_code = i.inst_code WHERE ${x} LIMIT 6`;
    let r = (await c.query(sql('i.inst_name = $1'), [nm])).rows; if (!r.length) r = (await c.query(sql("i.inst_name ILIKE '%'||$1||'%'"), [likeEsc(nm)])).rows; return r; });
  if (!rs.length) throw bad('like_inst 기관을 찾지 못했습니다: ' + o.likeInst + ' (list_catalog kind=institutions 로 정확한 기관명 확인)');
  if (rs.length > 1) throw bad('like_inst 가 모호합니다(' + rs.map(x => x.inst_name).join('·') + ') — 정확한 기관명으로');
  const r = rs[0], need = { type: 'inst_type', size: 'size_bucket', region: 'region', ministry: 'ministry' };
  for (const k of o.likeBy) if (!r[need[k]]) throw bad(`기준 기관 ${r.inst_name} 의 ${k} 정보가 기관 메타에 없습니다 [미확인] — like_by 에서 빼세요.`);
  return r;
}
const SIZE_KO = { small: '소규모', medium: '중간', large: '대규모' };
function simOut(r, o) {
  return { inst: r.inst_name, by: o.likeBy, basis: { ...(o.likeBy.includes('type') ? { inst_type: r.inst_type } : {}), ...(o.likeBy.includes('size') ? { size_bucket: r.size_bucket, emp: r.emp } : {}), ...(o.likeBy.includes('region') ? { region: r.region } : {}), ...(o.likeBy.includes('ministry') ? { ministry: r.ministry } : {}) },
    unavailable: '업종·주요사업·자산규모는 기관 메타에 없어 «유사»에 쓰지 않음 [미확인] — 유형·규모(직원 수 구간)·지역·부처만 사용', self_excluded: true };
}

// ── list_catalog 확장: find_cases 의 topic/type/result 어휘(실제 카드에 있는 값과 건수) ──
const CATALOG_KINDS = ['case_topics', 'case_types', 'case_results', 'case_codes'];
async function catalogExt(withPooled, a) {
  const kind = String(a.kind || ''); if (!CATALOG_KINDS.includes(kind)) throw bad('kind 는 ' + CATALOG_KINDS.join('|'));
  const C = cfg(), K = await cols(withPooled), q = String(a.q || '').slice(0, 60).trim().toLowerCase(), limit = intIn(a.limit, 50, 1, 200), offset = intIn(a.offset, 0, 0, 1e6);
  const code = a.code != null && a.code !== '' ? String(a.code) : null; if (code && !C.codes.includes(code)) throw bad('code ' + code + ' 는 현재 노출되지 않는 코드입니다(노출: ' + C.codes.join('·') + ')');
  const T = await tabs(withPooled), P = [], pp = v => { P.push(v); return '$' + P.length; }, SRC = srcSql(C, K, T, code ? [code] : C.codes, pp), w = ['TRUE'];
  if (K.quality) w.push("COALESCE(c.quality::text,'') <> 'low'"); if (K.inst_mismatch) w.push("NOT (COALESCE(c.inst_mismatch::text,'false') IN ('true','t','1'))");
  const W = w.join(' AND '), rcol = K.result_norm ? 'c.result_norm' : 'c.result';
  const SQL = { case_topics: `SELECT t AS value, count(*)::int AS cards, count(DISTINCT c.inst_code)::int AS institutions FROM ${SRC} c, unnest(c.topics) t WHERE ${W} GROUP BY t ORDER BY cards DESC, value`,
    case_types: `SELECT c.code, c.case_type AS value, count(*)::int AS cards, count(DISTINCT c.inst_code)::int AS institutions FROM ${SRC} c WHERE ${W} AND c.case_type IS NOT NULL GROUP BY c.code, c.case_type ORDER BY c.code, cards DESC`,
    case_results: `SELECT ${rcol} AS value, array_agg(DISTINCT c.code ORDER BY c.code) AS codes, count(*)::int AS cards FROM ${SRC} c WHERE ${W} AND ${rcol} IS NOT NULL AND ${rcol} <> '' GROUP BY ${rcol} ORDER BY cards DESC, value LIMIT 200`,
    case_codes: `SELECT c.code AS value, count(*)::int AS cards, count(DISTINCT c.doc_id)::int AS docs, count(DISTINCT c.inst_code)::int AS institutions FROM ${SRC} c WHERE ${W} GROUP BY c.code ORDER BY c.code` }[kind];
  let rows = await withPooled(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='5s'"], async c => (await c.query(SQL, P)).rows);
  if (kind === 'case_codes') rows = rows.map(r => ({ ...r, name: CODE_NAME[r.value], favor: C.favorOn && C.favorCodes.includes(r.value) && !C.favorOffCodes.includes(r.value) ? 'filter_ok' : 'off' }));
  if (kind === 'case_types') rows = rows.map(r => ({ ...r, code_name: CODE_NAME[r.code] }));
  const hit = q ? rows.filter(r => String(r.value).toLowerCase().includes(q)) : rows, items = hit.slice(offset, offset + limit);
  const notes = { case_topics: 'find_cases 의 topic 에 이 값(주제 태그)을 그대로 쓰면 태그 일치, 그 밖의 말은 요지·인용 키워드 검색. A|B=OR.', case_types: 'find_cases 의 type(부분일치). 코드마다 유형이 다르다.',
    case_results: 'find_cases 의 result(부분일치). «합의» 검색은 «미합의» 를 제외한다. 값 정규화본(result_norm) 기준.', case_codes: 'find_cases 의 code. 노출 중인 코드만(설정 codes) — favor 는 노사 코드 중 filter_ok 인 코드만.' };
  return { kind, total: hit.length, items, ...(offset + limit < hit.length ? { next_offset: offset + limit } : {}), count_unit: '카드 수(파일럿 표본 — 전체 건수 아님)', note: notes[kind], run: C.run };
}

async function findCases(withPooled, a, ctx) {
  const C = cfg(), o = normalize(a, C), tier = ctx && ctx.tier;
  const lim = limited(ctx, C); if (lim) throw Object.assign(new Error(`find_cases 호출 한도(분당 ${lim.max}회)를 넘었습니다. ${lim.retry}초 후 다시 시도하세요.`), { code: 'BUSY' });
  const mo = maskOptsForTier(tier), ck = JSON.stringify([o, C.run, C.codes, C.minConf, C.favorOn, C.favorOffCodes, C.perCode, C.basisOn, mo, colCache.v, tabCache.v]), hit = cache.get(ck);
  if (hit && Date.now() - hit.t < 60000) return hit.out;
  if (running >= C.conc) throw Object.assign(new Error('find_cases 동시 실행 한도(' + C.conc + ')를 넘었습니다. 몇 초 뒤 다시 시도하세요.'), { code: 'BUSY' });
  running++; const t0 = Date.now();
  try {
    const K = await cols(withPooled), T = await tabs(withPooled), ref = o.likeInst ? await lookupRef(withPooled, o, T) : null, b = build(o, C, K, T, ref), P = b.P;
    const sel = `${b.dk && T.ev ? 'ev.ev_size, ev.ev_rank, ' : "NULL::int AS ev_size, NULL::int AS ev_rank, "}${K.content_date ? 'c.content_date' : 'NULL::date AS content_date'}, COALESCE(${b.de}, make_date(c.ref_year, 1, 1)) AS deff, c.src, c.run_id, c.ref_year, c.authority, c.subject, c.card_id, c.doc_id, c.inst_name, c.submitted_at, c.code, c.case_type, c.topics, c.summary, c.result, c.quote, c.quote_start, c.quote_end, ${b.fv} AS favor, c.favor_reason, c.confidence, d.doc_title, ${b.old} AS maybe_old, ${b.shit} AS s_hit${b.dk ? ', ' + b.dk + ' AS dk' : ''}`;
    const base = `FROM ${b.src} c${b.join}${b.jev} LEFT JOIN documents d ON d.doc_id = c.doc_id WHERE ${b.where}`;
    const inc = o.includeOld ? 'TRUE' : 'NOT maybe_old';
    const rows = await withPooled(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='5s'"], async cl => {
      const q = x => cl.query(x[0], x[1]).then(r => r.rows);
      // (1) 카드 목록 — distinct_inst: 기관별 per_inst 장(신뢰도 높음·최신 우선), 출력은 제출일 최신순(중요도 순서 아님)
      // 선택 순서: 요지 일치(키워드) 우선 → 신뢰도 높음 → 최신. dup_group 이 있으면 그룹 대표 1건만(필터 통과분 중).
      const dd = b.dk ? `, h AS (SELECT * FROM (SELECT g1.*, row_number() OVER (PARTITION BY dk ORDER BY s_hit DESC, (confidence='high') DESC, ev_rank NULLS LAST, card_id) dr FROM g1) z WHERE dr = 1)` : ', h AS (SELECT * FROM g1)';
      const listSql = `WITH f AS (SELECT ${sel} ${base}), g1 AS (SELECT * FROM f WHERE ${inc})${dd}, g AS (SELECT h.*, row_number() OVER (PARTITION BY ${o.distinct ? 'inst_name' : "run_id || ':' || card_id"} ORDER BY s_hit DESC, (confidence='high') DESC, deff DESC, card_id) rn FROM h)
        SELECT * FROM g WHERE rn <= ${o.distinct ? o.per : 1} ORDER BY s_hit DESC, deff DESC, run_id, card_id LIMIT ${o.limit + 1} OFFSET ${o.offset}`;
      const list = await q([listSql, P]);
      // (2) 필터 일치 합계
      const tot = (await q([`WITH f AS (SELECT ${sel} ${base}), g1 AS (SELECT * FROM f WHERE ${inc})${dd}
        SELECT (SELECT count(*)::int FROM f) n_all, (SELECT count(*)::int FROM g1) n_pre_dedup, count(*)::int n, count(DISTINCT doc_id)::int docs, count(DISTINCT inst_name)::int insts, count(*) FILTER (WHERE s_hit)::int n_summary FROM h`, P]))[0];
      // (3) 범위(코드·기간·기관·부처) 안의 카드 대상 문서·카드 0장 문서 — topic/type/result/favor 와 무관한 «처리 범위»
      const sp = [], sw = [];
      const S = v => { sp.push(v); return '$' + sp.length; };
      const scope = o.code ? [o.code] : (o.codes || C.codes), lgS = scope.filter(c => !C2.has(c)), c2S = T.c2 ? scope.filter(c => C2.has(c)) : [];
      sw.push('l.run_id = ' + S(C.run)); sw.push("split_part(d.category,'_',1) = ANY(" + S(lgS) + '::text[])');
      if (o.from) sw.push("d.meta->>'submitted_at' >= " + S(o.from)); if (o.to) sw.push("d.meta->>'submitted_at' <= " + S(o.to));
      if (b.instName) sw.push(`i.inst_name ILIKE '%'||${S(likeEsc(b.instName))}||'%'`); if (b.mi) sw.push(`i.ministry ILIKE '%'||${S(likeEsc(String(b.mi.value)))}||'%'`);
      const by = !lgS.length ? [] : await q([`SELECT split_part(d.category,'_',1) code, count(*)::int docs, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_ext.card_items x WHERE x.run_id = l.run_id AND x.doc_id = l.doc_id))::int with_cards,
          count(*) FILTER (WHERE l.status = 'parse_failed')::int failed FROM rag_ext.card_doc_log l JOIN documents d ON d.doc_id = l.doc_id LEFT JOIN institutions i ON i.inst_code = d.inst_code WHERE ${sw.join(' AND ')} GROUP BY 1 ORDER BY 1`, sp]);
      // (3b) card2 코드: card2_doc_log(처리된 문서) 기준 — 뷰가 내보내는 «적재된 run» 만. 기간 조건은 제출일 있는 문서에만 의미가 있다.
      if (c2S.length) {
        const cp = [], cw = [], CS = v => { cp.push(v); return '$' + cp.length; };
        cw.push('l.code = ANY(' + CS(c2S) + '::text[])');
        if (o.from) cw.push("d.meta->>'submitted_at' >= " + CS(o.from)); if (o.to) cw.push("d.meta->>'submitted_at' <= " + CS(o.to));
        if (b.instName) cw.push(`i.inst_name ILIKE '%'||${CS(likeEsc(b.instName))}||'%'`); if (b.mi) cw.push(`i.ministry ILIKE '%'||${CS(likeEsc(String(b.mi.value)))}||'%'`);
        by.push(...await q([`SELECT l.code, e.run_id run, count(*)::int docs, count(*) FILTER (WHERE l.n_cards > 0)::int with_cards, count(*) FILTER (WHERE l.status = 'parse_failed')::int failed
          FROM rag_ext.card2_doc_log l JOIN (SELECT DISTINCT code, run_id FROM rag_ext.card2_find_v) e ON e.code = l.code AND e.run_id = l.run_id JOIN documents d ON d.doc_id = l.doc_id LEFT JOIN institutions i ON i.inst_code = d.inst_code WHERE ${cw.join(' AND ')} GROUP BY 1, 2 ORDER BY 1`, cp]));
      }
      // (4) 근거 법령·내규 연결(card_cite_link) — 목록 카드 id 에 대해서만 ((run_id, card_id) 키: card2 카드는 연결이 없으면 조용히 비어 있다)
      let basis = []; if (T.cite && o.withBasis && C.basisOn && list.length) basis = await q([`SELECT run_id, card_id, ev_text, kind, dst_title, dst_doc_id, art_no, art_sub, art_found, verified_state, reason FROM rag_ext.card_cite_link WHERE run_id || ':' || card_id = ANY($1::text[]) ORDER BY run_id, card_id, ev_start`, [list.slice(0, o.limit).map(r => r.run_id + ':' + r.card_id)]]);
      return { list, tot, by, basis };
    });
    const basisBy = new Map(); for (const x of rows.basis || []) { const kk = x.run_id + ':' + x.card_id, a = basisBy.get(kk) || []; if (a.length < 4) a.push({ cite: x.ev_text, matched: x.kind !== 'unmatched', ...(x.kind !== 'unmatched' ? { kind: x.kind === 'law' ? '법령·지침(legal)' : x.kind === 'ca' ? '단체협약(ca)' : '기관 내규(bylaws)', title: x.dst_title, doc_id: x.dst_doc_id, article_found: !!x.art_found, check: x.verified_state } : { state: '미매칭', reason: x.reason }) }); basisBy.set(kk, a); }
    const more = rows.list.length > o.limit, list = rows.list.slice(0, o.limit);
    const docs = rows.by.reduce((s, x) => s + x.docs, 0), wc = rows.by.reduce((s, x) => s + x.with_cards, 0), failed = rows.by.reduce((s, x) => s + x.failed, 0);
    const inScope = o.code ? [o.code] : (o.codes || C.codes), onlyC2 = inScope.every(c => C2.has(c)), noCards = inScope.filter(c => !(rows.by.find(x => x.code === c) || {}).with_cards).map(c => c + '(' + CODE_NAME[c] + ')');
    const fa = { code: o.code || inScope.join(','), ...(o.topic ? { topic: b.modes } : {}), ...(o.type ? { type: o.type } : {}), ...(o.result ? { result: o.results || o.result } : {}), ...(o.basisLaw ? { basis: { law: o.basisLaw, ...(o.basisArt != null ? { art: o.basisArt } : {}) } } : {}), ...(o.favor ? { favor: o.favor } : {}),
      ...(o.refFrom != null ? { ref_year: o.refFrom === o.refTo ? o.refFrom : o.refFrom + '-' + o.refTo } : {}), ...(o.from ? { from: o.from } : {}), ...(o.to ? { to: o.to } : {}), ...(b.instName ? { inst: b.instName } : {}), ...(b.mi && b.mi.value ? { ministry: b.mi.value, ...(b.mi.from ? { ministry_resolved: { from: b.mi.from, to: b.mi.value } } : {}) } : {}),
      date_basis: o.dateBasis === 'content' && !b.contentOk ? 'submitted(content_date 컬럼 없음 — 폴백)' : o.dateBasis,
      ...(ref ? { similar_to: simOut(ref, o) } : {}), distinct_inst: o.distinct, ...(o.distinct ? { per_inst: o.per } : {}), include_old: o.includeOld, min_confidence: C.minConfName };
    const out = {
      tool_note: 'find_cases — LLM 이 문서에서 추출한 사례 카드(요지·결과·원문 인용). 순위·최다·전수가 아니며 정렬은 제출일 최신순이다.',
      filters_applied: fa, ...(o.inputNotes && o.inputNotes.length ? { input_notes: o.inputNotes } : {}), ...(o.ignored.length ? { params_ignored: o.ignored } : {}),
      coverage: {
        scope_note: onlyC2 ? '카드는 LLM 이 공시 문서에서 추출한 표본이며 전수 아님(적재된 문서만 대상 — coverage.by_code 의 docs).' : '카드는 최근 12개월 제출분 약 3,000문서(코드별 쿼터로 고른 표본) 파일럿 범위이며 전수 아님(card2 코드는 card2_notice 참조).',
        cards_matching: rows.tot.n, docs_with_matching_cards: rows.tot.docs, institutions_with_matching_cards: rows.tot.insts,
        ...(rows.tot.n_pre_dedup > rows.tot.n ? { dedup_merged: rows.tot.n_pre_dedup - rows.tot.n, dedup_rule: T.ev ? 'card_event(같은 기관 동일 인용·수정공시)+dup_group' : 'dup_group' } : {}),
        ...(!o.includeOld && rows.tot.n_all > rows.tot.n ? { reposted_excluded: rows.tot.n_all - rows.tot.n } : {}), repost_rule: b.oldSource,
        ...(o.terms && o.terms.some(t => !TAGS.includes(t)) ? { keyword_matched_in_summary: rows.tot.n_summary, keyword_note: '요지에서 일치한 카드를 먼저 보인다(matched_in). quote 에서만 일치한 카드는 근거 조항 언급(예: «정관»)일 수 있어 요지 일치보다 약하다.' } : {}),
        ...(onlyC2 ? {} : { recall_note: '독립 검증 기준 카드 재현율 약 71%(코드별 66~80%) — 원문에 있는 사례 일부가 카드에 없다. 카드 풀은 최근 12개월 선별 풀의 일부 표본(약 13~36%)이다. 63795 는 48개 기관·한국철도공사 33% 편중.' }),
        card_target_docs_in_scope: docs, docs_with_cards: wc, docs_zero_cards_ratio: docs ? +((docs - wc) / docs).toFixed(3) : null, ...(failed ? { docs_extraction_failed: failed } : {}),
        by_code: rows.by.map(x => ({ code: x.code, name: CODE_NAME[x.code], ...(x.run ? { run: x.run } : {}), docs: x.docs, with_cards: x.with_cards })),
        codes_without_cards: noCards, codes_not_covered: '카드는 ' + Object.keys(CODE_NAME).length + '개 코드(' + Object.entries(CODE_NAME).map(([k, v]) => k + ' ' + v).join('·') + ')만 있다 — 그 밖의 공시 항목은 카드가 없다.',
      },
      count_returned: list.length, ...(o.distinct ? { distinct_note: '기관당 최대 ' + o.per + '장(신뢰도 높음·최신 우선 선택). 같은 기관의 다른 카드는 offset 이 아니라 distinct_inst=false 로 본다.' } : {}),
      cases: list.map(r => cardOut({ ...r, submitted_at: dayStr(r.submitted_at) }, o, C, basisBy)),
      exhaustive: false,
    };
    if (more) { out.has_more = true; out.next_offset = o.offset + o.limit; }
    if (out.cases.some(c => c.legal_basis)) out.basis_note = 'legal_basis 는 카드 인용문에서 규칙(정규식+법령명 사전)으로 뽑은 «근거 법령·내규 연결» 이다 — 자동 추출이라 확인 필요. article_found=false 면 문서는 찾았으나 그 조문 번호가 없다(개정 전후 판·번호 이동). 미매칭=법령 DB·해당 기관 내규에 없는 이름(예: 상법)이거나 표기 변형.';
    if (o.dateBasis === 'content' && b.contentOk) out.date_note = '날짜 필터·정렬은 본문 회의일(content_date, 추정값이며 없으면 제출일)을 쓴다.';
    if (out.cases.some(c => c.favor)) out.favor_note = 'favor 는 «모델 의견»(모델 판단, 근거 한 줄 동봉)이며 노사 평가·법적 판단이 아니다. 원문 확인 필요.';
    if (!o.includeOld && list.length) out.repost_note = '제출일은 최근이어도 본문 회의일이 과거인 재게시 카드는 근사 규칙(연도 표기)으로 뺀다. include_old=true 면 포함하고 maybe_reposted 표시.';
    out.notice = ['순위·최다·건수 단정 금지: 카드는 표본이며 일치 건수는 표본 안의 값이다.', '요지·유형·결과는 모델이 추출한 요약이다 — 인용문(quote, 원문 그대로)·quote_span(문서 본문 청크를 줄바꿈으로 이은 문자열 내 [시작,끝))으로 get_document(doc_id) 원문을 확인할 것(긴 문서는 find=인용 앞부분).',
      '카드가 없다고 사례가 없다는 뜻이 아니다(처리 범위 밖·추출 실패·본문 없음 포함).'];
    // C2View 고지: card2 코드가 결과에 있거나 범위에 있으면 기준연도·표본·평가의견 발췌·authority 안내
    const c2c = [...new Set((list.length ? list.map(r => r.code) : inScope).filter(c => C2.has(c)))];
    if (c2c.length) {
      const n = [];
      if (c2c.some(c => NODATE.has(c))) n.push('«기준연도(ref_year)» 는 공시 기준 연도이며 제출일이 아니다 — B코드 카드는 months·from·to 가 아니라 ref_year(예 2024, 2022-2024)로 거른다.');
      if (c2c.some(c => C2_SAMPLE[c])) n.push('표본: ' + c2c.filter(c => C2_SAMPLE[c]).map(c => c + ' ' + C2_SAMPLE[c]).join(' · ') + ' — 해당 기간 전수가 아니다. 전량 추출 진행 중이면 «적재된 문서» 만 대상(coverage.by_code 의 docs).');
      if (c2c.some(c => EVAL.has(c))) n.push('경영평가·대내외 평가 카드는 평가위원 의견 발췌이며 전수·순위가 아니다. result(등급)는 인용에 등급 문자가 literal 로 있을 때만 모델이 추출하며 대부분 비어 있다. 등급이 있는 카드는 지표·항목별 등급일 수 있고 종합등급이 아니다 — result_item(지표·항목명)과 quote 로 확인할 것.');
      n.push('summary 는 «모델 요약», quote 는 «원문 근거» 다. 요약에는 인용 밖 원문 사실이 포함될 수 있다(독립 검수 표본 약 6%) — 근거는 quote·quote_span 으로 원문 확인.');
      if (c2c.includes('B1220')) n.push('B1220 은 감사원 지적과 주무부처 지적이 섞여 있다 — 각 카드의 authority 를 확인할 것(subject=지적 주제).');
      if ((o.from || o.to) && !o.code && c2c.some(c => NODATE.has(c))) n.push('기간 조건(months·from·to)은 제출일이 있는 카드에만 적용되어 제출일 없는 B1210·B1220 카드는 제외되었다.');
      out.card2_notice = n; out.card2_codes = c2c; out.field_labels = { summary: '모델 요약', quote: '원문 근거(원문 그대로)' };
    }
    if (/부결/.test((o.result || '') + (o.type || '') + (o.topic || ''))) out.reject_note = '부결 카드: 회의록 서식 문구(«부결 시…»)를 결과로 오추출했을 수 있고, 카드의 부결 목록은 누락될 수 있다 — 반드시 원문(doc_id)으로 확인.';
    if (!list.length) {
      const reasons = [];
      if (!docs) reasons.push('이 기간·코드·기관 범위에는 카드 처리 대상 문서가 없다(파일럿 표본 밖).');
      else if (!wc) reasons.push('범위 안 대상 문서 ' + docs + '건에서 카드가 한 장도 나오지 않았다(' + (failed ? '추출 실패 ' + failed + '건 포함' : '사례성 내용 없음') + ').');
      else if (!rows.tot.n_all) reasons.push('범위 안 카드는 있으나 topic·type·result·favor·신뢰도 조건과 일치하는 카드가 없다 — 조건을 줄여 보라.');
      else reasons.push('일치 카드 ' + rows.tot.n_all + '장이 모두 재게시 의심으로 제외됨 — include_old=true 로 보라.');
      if (o.offset) reasons.push('offset 이 결과 끝을 넘었다.');
      out.zero_result = { reasons, alternatives: ALT, note: '«카드 없음 ≠ 사례 없음» — 위 대체 경로로 원문을 직접 찾을 것.' };
    }
    out.elapsed_ms = Date.now() - t0;
    const res = maskDeep(out, mo);
    if (cache.size > 60) cache.clear(); cache.set(ck, { t: Date.now(), out: res });
    return res;
  } finally { running--; }
}

function toolDef() {
  return {
    name: 'find_cases',
    description: '다기관 사례 카드(감사·이사회·노사·평가): 요지·원문 인용·근거법령. 표본: 순위·최다·전수 불가, 0건≠사례없음.',
    inputSchema: { type: 'object', properties: {
      topic: { type: 'string', description: 'A|B=OR, list_catalog case_topics' }, type: { type: 'string' },
      code: { type: 'string', description: 'case_codes' }, ref_year: { type: 'string', description: '기준연도 2024|2022-2024' }, result: { type: 'string' },
      favor: { type: 'string', enum: FAVORS }, months: { type: 'integer' },
      from: { type: 'string' }, to: { type: 'string' }, inst: { type: 'string' }, ministry: { type: 'string' },
      like_inst: { type: 'string' }, date_basis: { type: 'string' },
      basis: { type: 'string', description: '법령 [제N조]' }, limit: { type: 'integer' }, offset: { type: 'integer' },
    } },
  };
}
module.exports = { findCases, toolDef, normalize, build, cfg, maskDeep, catalogExt, CATALOG_KINDS, CODE_NAME, TAGS, _internal: { resetCols: () => { colCache = { t: 0, v: {} }; }, cache, hits, get running() { return running; }, resetTabs: () => { tabCache = { t: 0, v: {} }; } } };
