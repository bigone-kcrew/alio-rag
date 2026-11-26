'use strict';
/**
 * 항목(공시 항목) 필터 — 자연어 항목명·별칭 해석 + 필터 인자 준비 (DB 접근 없음, 순수 함수).
 *   ITEM_FILTER=off(기본)|explicit|auto
 *     off      이 모듈은 아무 것도 하지 않는다(prepare → null). item·period·sort=latest 인자는 무시 → 응답이 next2 와 같다.
 *     explicit 명시 인자 item(자연어 항목명·별칭·코드 목록)·period·sort=latest 만 적용.
 *     auto     explicit + 질의 문장에서 항목 자동 감지(신뢰도 high 일 때만 적용, 애매하면 미적용 + item_resolved 로 후보 표기).
 * 사전은 item_catalog.json(build_item_catalog.js: bf_cfg.catalog + DB category + 근거 달린 별칭).
 * 필터는 «공시 문서 행»에만 걸린다(법령·내규·단협 행은 영향 없음). 값은 documents.category(코드_소분류)의 목록으로 바뀐다.
 */
const CAT = require('./item_catalog.json');
let understand = null; try { ({ understand } = require('./_query_understand.js')); } catch { /* 질의 이해 없이도 동작(기관명 제거만 약해짐) */ }

const MODES = ['off', 'explicit', 'auto'];
const mode = () => { const v = process.env.ITEM_FILTER || 'off'; return MODES.includes(v) ? v : 'off'; };

// ── 정규화: 공백·가운뎃점·괄호·구두점 제거(임·직원=임직원, 수입·지출=수입지출) ──
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[\s·ㆍ.,;:()\[\]{}<>'"“”‘’~\-_/|&!?]/g, '');

// ── 사전 구성 ──
const ITEMS = new Map(CAT.items.map(i => [i.code, i]));       // code → {code, minor, name, categories[], n}
const nameOf = it => it.name || it.minor;
const PHRASES = new Map();                                      // 정규화 구 → {codes:Set, text, kind}
const MINORS = new Map();                                       // 소분류(자동 감지 제외) → codes
const addPhrase = (text, codes, kind) => {
  const k = norm(text); if (k.length < 3) return;
  const e = PHRASES.get(k) || PHRASES.set(k, { codes: new Set(), text, kind }).get(k);
  for (const c of codes) if (ITEMS.has(c)) e.codes.add(c);
};
{
  const byName = new Map();
  for (const it of CAT.items) { const n = nameOf(it); (byName.get(n) || byName.set(n, []).get(n)).push(it.code); }
  for (const [n, codes] of byName) {
    addPhrase(n, codes, 'item');
    const m = n.match(/^(.*?)\s*\((.*)\)\s*$/);               // «요약 손익계산서 (또는 요약 포괄손익계산서)» → 본 이름·괄호 안(또는 제거)
    if (m) { addPhrase(m[1], codes, 'item'); addPhrase(m[2].replace(/^또는\s*/, ''), codes, 'item'); }
  }
  for (const a of CAT.aliases) addPhrase(a.phrase, a.codes, 'alias');
  const byMinor = new Map();
  for (const it of CAT.items) (byMinor.get(it.minor) || byMinor.set(it.minor, []).get(it.minor)).push(it.code);
  for (const [m, codes] of byMinor) {
    MINORS.set(norm(m), { codes, text: m });
    const bare = m.replace(/^[A-Z]\((.*)\)$/, '$1');         // S(사회) → 사회
    if (bare !== m) MINORS.set(norm(bare), { codes, text: m });
  }
}
// 다른 코퍼스(내규·법령·단협)에서도 흔한 말 — 코퍼스를 disclosure 로 못 박지 않은 질의에서는 자동 적용하지 않는다
const COLLISION = new Set(['이사회', '일반현황', '임원현황', '감사보고서', '계약정보', '인권경영', '안전관리', '재무상태표', '손익계산서', '자본금', '재취업', '수의계약', '계약현황'].map(norm));

// ── 질의 문장에서 항목과 무관한 말(요청 어투·시점 표현)을 걷어내는 목록 ──
const STOP = ['가장최근', '최근', '최신', '현재', '올해', '작년', '지난', '공시', '자료', '내용', '현황', '관련', '대한', '해당', '기간', '분기별', '분기', '전체', '전수', '모두', '모든',
  '알려줘', '알려주세요', '보여줘', '보여주세요', '찾아줘', '찾아주세요', '검색', '조회', '어떻게', '무엇', '뭐야', '있나요', '있어', '해줘', '목록', '리스트', '내역', '정보', '기준', '시점', '연도', '년도', '추이', '대해', '에서', '으로', '에게', '부터', '까지', '및', '그리고', '또는'].map(norm)   // RC: 접속어(항목 두 개를 잇는 «및»)는 잔여로 세지 않는다.sort((a, b) => b.length - a.length);
const PARTICLE_FULL = /^(에서의|에서는|에서도|이라는|이란|에서|에는|에게|까지|부터|으로|은|는|이|가|을|를|의|에|도|만|과|와|로|랑|좀)$/;   // 항목 구 뒤에 «조사만» 이어지는 경우
const ORG_TOKEN = /(공단|공사|공제회|진흥원|연구원|연구소|재단|병원|대학교|대학|정보원|평가원|관리원|개발원|위원회|사업단|협회|은행|박물관|미술관|도서관|센터|협의회|보험|공제조합|본부)$/;

function residualOf(text, spans) {
  // spans: 이미 찾은 구(정규화 문자열) 목록 — 정규화 문자열에서 제거하고 STOP·연도·분기 표기를 걷는다
  let r = text;
  for (const s of spans) r = r.split(s).join('');
  r = r.replace(/(19|20)\d{2}년?도?/g, '').replace(/[1-4]분기/g, '').replace(/q[1-4]/g, '').replace(/[0-9]+/g, '');
  for (const w of STOP) r = r.split(w).join('');
  return r;
}

/** 질의 문장에서 항목 감지 → {codes, phrases, confidence('high'|'medium'|'none'), residual, consumed, applied(corpus 규칙 반영), reason} */
function detect(query, { corpus = 'all' } = {}) {
  const none = (reason, extra) => ({ codes: [], phrases: [], confidence: 'none', residual: null, consumed: false, applied: false, reason, ...extra });
  let q = String(query || '');
  if (!q.trim()) return none('empty');
  if (/제\s*\d+\s*조/.test(q)) return none('article_query');
  if (/ (OR|AND) /.test(q)) return none('boolean_query');
  if (corpus && !['all', 'disclosure'].includes(corpus)) return none('corpus_not_disclosure');
  // 기관명·연도는 질의 이해(사전 기반)로 먼저 뺀다. 사전에 없는 «(재)…센터» 류는 아래 토큰 휴리스틱이 뺀다.
  let strippedInst = false;
  if (understand) { try { const u = understand(q); if (u && u.residual != null) { if (u.inst) strippedInst = true; q = u.residual; } } catch { /* 무시 */ } }
  const t = norm(q);
  // RC: 항목 구는 «어절 경계» 에서만 인정한다 — 앞은 어절 시작, 뒤는 어절 끝이거나 조사(은·는·이·가·을·를·의·에서…)만 이어질 때.
  //   «임직원 수당»·«안전관리자»·«이사회실»·«투자집행내역서» 처럼 항목 구 뒤에 한글이 바로 이어지는 낱말(접미사)을 항목으로 오인하지 않는다(독립 검토 경계 40질의 오탐 6건).
  const tokB = []; { let o = 0; for (const tok of q.split(/\s+/).filter(Boolean)) { const nt = norm(tok); tokB.push({ s: o, e: o + nt.length }); o += nt.length; } }
  const boundaryOk = (i, len) => {
    const e = i + len, tk = tokB.find(x => x.s <= i && i < x.e);
    if (!tk) return true;                                              // 어절 정보가 없으면(구두점만 등) 막지 않는다
    if (tk.s !== i && !tokB.some(x => x.e === i)) return false;        // 어절 중간에서 시작
    const end = tokB.find(x => x.s < e && e <= x.e);
    return !end || end.e === e || PARTICLE_FULL.test(t.slice(e, end.e));
  };
  const hits = [];
  for (const [k, e] of PHRASES) { const i = t.indexOf(k); if (i >= 0 && boundaryOk(i, k.length)) hits.push({ k, i, e }); }
  hits.sort((a, b) => b.k.length - a.k.length || a.i - b.i);
  const picked = [], used = new Array(t.length).fill(false);
  for (const h of hits) {                                          // 긴 구부터, 겹치면 건너뜀
    let free = true; for (let j = h.i; j < h.i + h.k.length; j++) if (used[j]) { free = false; break; }
    if (!free) continue;
    for (let j = h.i; j < h.i + h.k.length; j++) used[j] = true;
    picked.push(h);
  }
  if (!picked.length) return none('no_phrase', { residual: residualOf(t, []) });
  const codes = [...new Set(picked.flatMap(h => [...h.e.codes]))].sort();
  const sets = new Set(picked.map(h => [...h.e.codes].sort().join(',')));
  // 기관명 토큰 제거(사전에 없는 «(주)…»·«…센터» 류): 항목 구와 겹치는 토큰은 건드리지 않는다(예: «징계위원회 구성현황» 의 «징계위원회»)
  let left = '', off = 0;
  for (const tok of q.split(/\s+/).filter(Boolean)) {
    const nt = norm(tok), s0 = off, e0 = off + nt.length; off = e0;
    const touched = used.slice(s0, e0).some(Boolean);
    const core = tok.replace(/[의은는이가을를과와도]$/, '');
    const isOrg = !touched && (/\((주|재|사|유|협)\)|㈜/.test(tok) || (ORG_TOKEN.test(core) && nt.length >= 4));
    if (isOrg) { strippedInst = true; continue; }
    let piece = ''; for (let j = s0; j < e0; j++) if (!used[j]) piece += t[j];
    if (touched && PARTICLE_FULL.test(piece)) piece = '';              // 항목 구에 붙은 조사는 잔여로 세지 않는다
    const stripped = piece.replace(/(에서의|이라는|에서|으로|이란|은|는|이|가|을|를|와|과|의|에|도|만|랑|좀)$/, '');
    left += stripped.length >= 2 ? stripped : piece;   // 조사는 «말미» 에서만 떼고, 떼고 나면 2자 미만이 되는 낱말(한도 등)은 그대로 둔다
  }
  const residual = residualOf(left, []);
  const distinctItems = sets.size;
  let confidence = 'high', reason = 'ok';
  if (residual.length > 0) { confidence = 'medium'; reason = 'residual_content_words'; }
  else if (distinctItems > 2 || (distinctItems === 2 && picked.length > 2)) { confidence = 'medium'; reason = 'multiple_items'; }
  // 코퍼스를 disclosure 로 못 박지 않은(all) 질의: 흔한 말·짧은 구는 자동 적용하지 않는다
  let applied = confidence === 'high';
  if (applied && corpus !== 'disclosure') {
    if (picked.some(h => COLLISION.has(h.k) || h.k.length < 6)) { applied = false; reason = 'corpus_all_ambiguous_phrase'; }
  }
  return { codes, phrases: picked.map(h => h.e.text), confidence, residual, consumed: residual.length === 0, strippedInst, applied, reason };
}

const looksLikeCode = s => /^([0-9]{5}|B[0-9]{4})(?:_.*)?$/i.test(String(s).trim());
const bigrams = s => { const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; };
const jacc = (a, b) => { const A = bigrams(a), B = bigrams(b); let x = 0; for (const g of A) if (B.has(g)) x++; return A.size + B.size ? x / (A.size + B.size - x) : 0; };

/** 명시 인자 item(문자열 | 배열; 자연어 항목명·별칭·소분류·코드, 쉼표·세미콜론·| 로 여러 개) → {codes, names, unresolved, suggestions} */
const ITEM_MAX_LEN = 200, ITEM_MAX_N = 12;   // RC: 입력 상한(부분 포함 탐색이 사전 전체를 훑으므로 길이·개수를 막는다)
function resolveExplicit(input) {
  const raw = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[,;|]+/);
  if (Array.isArray(input) ? raw.some(x => String(x).length > ITEM_MAX_LEN) : String(input == null ? '' : input).length > ITEM_MAX_LEN)
    throw Object.assign(new Error(`item 은 ${ITEM_MAX_LEN}자 이내여야 합니다`), { code: 'BAD_ITEM' });
  const toks = raw.map(s => String(s).trim()).filter(Boolean);
  if (toks.length > ITEM_MAX_N) throw Object.assign(new Error(`item 은 ${ITEM_MAX_N}개 이내여야 합니다`), { code: 'BAD_ITEM' });
  const codes = new Set(), matched = [], unresolved = [], ambiguous = [];
  const sugg = new Map();
  for (const tok of toks) {
    if (looksLikeCode(tok)) {
      const c = tok.split('_')[0].toUpperCase().replace(/^B/, 'B');
      if (ITEMS.has(c)) { codes.add(c); matched.push({ input: tok, as: nameOf(ITEMS.get(c)) + '(' + c + ')', how: 'code' }); } else unresolved.push(tok);
      continue;
    }
    const k = norm(tok);
    let hit = PHRASES.get(k), how = 'name';
    if (!hit && MINORS.has(k)) { hit = { codes: new Set(MINORS.get(k).codes), text: MINORS.get(k).text }; how = 'minor'; }
    if (!hit) {                                                    // 부분 포함: 사전 구가 입력에 들어있거나 입력이 사전 구에 들어있음(최소 3자) — 가장 긴 구 우선
      const c = [...PHRASES].filter(([p]) => k.length >= 3 && (k.includes(p) || p.includes(k))).sort((a, b) => b[0].length - a[0].length);
      // RC: 입력이 사전 구의 «일부(조각)» 일 뿐이고(입력이 어떤 구도 통째로 담지 않음) 서로 다른 항목 여러 개에 걸리면 모호 — 하나로 좁히지 않고 후보만 알린다(예: «임직원»·«장애인»·«평가결과»)
      const whole = c.filter(([p]) => k.includes(p));
      const frag = new Map(); if (!whole.length) for (const [, e] of c) { const key = [...e.codes].sort().join(','); if (e.codes.size && !frag.has(key)) frag.set(key, e); }
      if (!whole.length && frag.size > 1) {
        ambiguous.push({ input: tok, candidates: [...frag.values()].map(e => ({ name: e.text, codes: [...e.codes].sort() })).slice(0, 8) });
        continue;
      }
      if (c.length && (c.length === 1 || c[0][0].length > c[1][0].length || (c[0][1].codes.size === c[1][1].codes.size))) { hit = c[0][1]; how = 'contains'; }
      else if (c.length) { const u = new Set(c.flatMap(([, e]) => [...e.codes])); hit = { codes: u, text: c.map(x => x[1].text).join('+') }; how = 'contains_multi'; }
    }
    if (hit) { for (const x of hit.codes) codes.add(x); matched.push({ input: tok, as: hit.text, how, codes: [...hit.codes].sort() }); continue; }
    unresolved.push(tok);
    const sc = [...PHRASES].map(([p, e]) => [jacc(k, p), e.text]).filter(x => x[0] >= 0.25).sort((a, b) => b[0] - a[0]).slice(0, 3);
    for (const [, tx] of sc) sugg.set(tx, 1);
  }
  return { codes: [...codes].sort(), matched, unresolved, ambiguous, suggestions: [...sugg.keys()] };
}

const categoriesFor = codes => [...new Set(codes.flatMap(c => (ITEMS.get(c) || { categories: [] }).categories))].sort();

// ── period: 2026Q2 | 2026 | 2026-07 | 2026-07-09 | latest ──
function parsePeriod(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/^(latest|최신)$/i.test(s)) return { latest: true, text: 'latest' };
  let m;
  if ((m = s.match(/^((?:19|20)\d{2})\s*-?\s*Q([1-4])$/i))) return { col: 'label', op: 'eq', val: `${m[1]}Q${m[2]}`, text: `${m[1]}Q${m[2]}` };
  if ((m = s.match(/^((?:19|20)\d{2})\s*년?\s*([1-4])\s*분기$/))) return { col: 'label', op: 'eq', val: `${m[1]}Q${m[2]}`, text: `${m[1]}Q${m[2]}` };
  if (/^(19|20)\d{2}$/.test(s)) return { col: 'label', op: 'prefix', val: s, text: s };
  if (/^(19|20)\d{2}-\d{2}(-\d{2})?$/.test(s)) return { col: 'sub', op: 'prefix', val: s, text: s };
  throw Object.assign(new Error('period 는 2026Q2 | 2026 | 2026-07 | 2026-07-09 | latest 형식이어야 합니다: ' + s.slice(0, 20)), { code: 'BAD_PERIOD' });
}

// report_period(G2-A): «보고 대상 분기/연도» — period_label_adj 기준(1~3월 공시 4분기 보고서는 전년 4분기). 2025Q4 | 2025 만(월·latest 없음).
function parseReportPeriod(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^((?:19|20)\d{2})\s*-?\s*Q([1-4])$/i)) || (m = s.match(/^((?:19|20)\d{2})\s*년?\s*([1-4])\s*분기$/))) return { col: 'adj', op: 'eq', val: `${m[1]}Q${m[2]}`, text: `${m[1]}Q${m[2]}` };
  if (/^(19|20)\d{2}$/.test(s)) return { col: 'adj', op: 'prefix', val: s, text: s };
  throw Object.assign(new Error('report_period 는 2025Q4 | 2025 형식이어야 합니다: ' + s.slice(0, 20)), { code: 'BAD_PERIOD' });
}
// target_year(G2-B): 문서 제목의 «20XX년» 에서 뽑은 자료 대상 연도(documents.doc_title). 공시 문서에만 적용.
function parseTargetYear(v) {
  const s = String(v == null ? '' : v).trim().replace(/년$/, '');
  if (!s) return null;
  if (!/^20\d{2}$/.test(s)) throw Object.assign(new Error('target_year 는 2025 같은 4자리 연도(20XX)여야 합니다: ' + s.slice(0, 20)), { code: 'BAD_PERIOD' });
  return s;
}
const TITLE_YEAR_RE = /(20\d{2})(?:년|\))/;   // MCPfix: «2025년» 외 «(2025)» 형식도
const titleYear = t => { const m = TITLE_YEAR_RE.exec(String(t || '')); return m ? m[1] : null; };

// RC: 존재하지 않는 달·일(2026-13, 2026-02-30)·미래 기간은 오류로 막지 않고(필터는 그대로 걸려 0건이 됨) period_warning 으로 알린다. today = KST 오늘(시험용 인자).
function periodWarning(p, today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)) {
  if (!p || p.latest) return null;
  const v = p.val;
  if (p.col === 'sub') {
    const [y, m, d] = v.split('-').map(Number);
    if (m < 1 || m > 12) return `period=${v}: ${m}월은 없는 달입니다 — 결과가 0건일 수 있습니다.`;
    if (d != null && (d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate())) return `period=${v}: ${y}년 ${m}월에 ${d}일은 없습니다 — 결과가 0건일 수 있습니다.`;
    const start = d != null ? v : v + '-01';
    if (start > today) return `period=${v} 는 아직 오지 않은 기간입니다(오늘 ${today}) — 결과가 0건일 수 있습니다.`;
    return null;
  }
  const y = parseInt(v.slice(0, 4), 10), q = v.length > 4 ? parseInt(v.slice(-1), 10) : 1;
  if (`${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01` > today) return `period=${v} 는 아직 오지 않은 기간입니다(오늘 ${today}) — 결과가 0건일 수 있습니다.`;
  return null;
}

// ── 필터 SQL 조각: 공시 행에만 건다(다른 코퍼스 행은 통과) ──
// 법령·내규·단협 한 코퍼스만 도는 질의에는 조각 자체를 달지 않는다(null) — 달면 쓸모없는 OR 때문에 플래너가 인덱스를 못 쓴다(auto + corpus=all 키워드 질의가 306ms → 12s 로 느려진 것을 기능 시험에서 발견·수정).
const appliesTo = corpus => corpus === 'all' || corpus === 'disclosure' || !['legal', 'bylaws', 'ca'].includes(corpus);
const gate = (corpus, cond) => !appliesTo(corpus) ? null : corpus === 'disclosure' ? cond : `(d.corpus <> 'disclosure' OR ${cond})`;
const itemClause = (ph, corpus) => gate(corpus, `d.category = ANY(${ph}::text[])`);
// period_label_adj 의 SQL 판: search.js adjPeriodLabel 과 같은 규칙(YYYYQ4 이고 같은 해 1~3월 공시 → 전년 Q4). 인덱스가 없는 식이므로 다른 조건으로 후보가 좁혀진 뒤에 평가된다.
const ADJ_LABEL_SQL = `(CASE WHEN d.meta->>'period_label' ~ '^[0-9]{4}Q4$' AND substr(d.meta->>'submitted_at', 1, 4) = substr(d.meta->>'period_label', 1, 4) AND substr(d.meta->>'submitted_at', 6, 2) IN ('01', '02', '03') THEN (substr(d.meta->>'period_label', 1, 4)::int - 1)::text || 'Q4' ELSE d.meta->>'period_label' END)`;
const periodClause = (ph, p, corpus) => {
  const col = p.col === 'adj' ? ADJ_LABEL_SQL : p.col === 'label' ? `d.meta->>'period_label'` : `d.meta->>'submitted_at'`;
  return gate(corpus, p.op === 'eq' ? `${col} = ${ph}` : p.op === 'gte' ? `${col} >= ${ph}` : `${col} LIKE ${ph}||'%'`);   // MCPdeep: gte = months(최근 N개월)
};

// target_year 조각: 인덱스 없는 식(substring 등식)이라 다른 조건으로 후보가 좁혀진 뒤 평가된다. trigram 용 `doc_title LIKE '%2025년%'` 보조 조건은 넣지 않는다 —
//   플래너가 전체 «2025년» 제목 4만 건에서 출발하는 계획을 골라 키워드·기관 없는 질의가 0.6s → 7s 로 느려졌다(2026-11-23 EXPLAIN 실측).
const targetYearClause = (ph, corpus) => gate(corpus, `substring(d.doc_title from '(20[0-9]{2})(?:년|[)])') = ${ph}`);
const hasPost = a => !!(a.itemCats || a.period || a.reportPeriod || a.targetYear);   // 사후(후보 뒤) 필터가 걸렸는가
// ITEM_FILTER=off 이면 prepare 가 null 이라 신규 필터가 «조용히» 무시된다 — 신규 인자를 준 호출에만 알린다(기존 호출 응답은 불변).
const ignoredNote = raw => (mode() === 'off' && raw && (String(raw.report_period || '').trim() || String(raw.target_year || '').trim() || String(raw.months || '').trim()))
  ? 'report_period·target_year·months 는 서버 설정 ITEM_FILTER=explicit 이상에서만 적용됩니다(현재 꺼져 있어 무시됨 — 결과는 필터 없이 나온 것).' : null;

/**
 * 호출부 공용 준비. mode=off 면 null(= 아무 것도 하지 않음, 응답에 키 추가 없음).
 * in: {item, period, sort, keyword, corpus}  out: {itemCats, itemCodes, period(parsed, 값이 있는 것만), latest, sortLatest, consumed, forceCorpus, info}
 *   info = item_resolved 응답 객체(감지·명시 흔적이 있을 때만, 없으면 null)
 */
function prepare({ item, period, sort, keyword, corpus = 'all', inst = null, report_period, target_year, months }) {
  const m = mode();
  if (m === 'off') return null;
  const out = { itemCats: null, itemCodes: [], period: null, latest: false, sortLatest: false, consumed: false, forceCorpus: null, info: null };
  const p = period ? parsePeriod(period) : null;
  if (p) { if (p.latest) out.latest = true; else { out.period = p; out.periodWarning = periodWarning(p); } }
  if (months != null && months !== '') {   // MCPdeep: 최근 N개월(제출일 기준) — period 의 «이상(gte)» 판
    if (!/^\d{1,3}$/.test(String(months).trim()) || +months < 1 || +months > 120) throw Object.assign(new Error('months 는 1~120 정수여야 합니다: ' + String(months).slice(0, 10)), { code: 'BAD_PERIOD' });
    if (out.period || out.latest) throw Object.assign(new Error('months 는 period 와 함께 쓸 수 없습니다'), { code: 'BAD_PERIOD' });
    const d = new Date(Date.now() + 9 * 3600e3); d.setUTCMonth(d.getUTCMonth() - +months); const cut = d.toISOString().slice(0, 10);
    out.period = { col: 'sub', op: 'gte', val: cut, text: '최근 ' + +months + '개월(제출일 ≥ ' + cut + ')' };
  }
  const rp = report_period ? parseReportPeriod(report_period) : null;
  if (rp) { out.reportPeriod = rp; out.reportPeriodWarning = (periodWarning(rp) || '').replace(/^period=/, 'report_period=') || null; if (!out.periodWarning) out.periodWarning = out.reportPeriodWarning; }
  const ty = target_year ? parseTargetYear(target_year) : null;
  if (ty) out.targetYear = ty;
  if ((rp || ty) && !appliesTo(corpus)) out.newFilterNote = 'report_period·target_year 는 공시(disclosure) 문서에만 적용됩니다 — corpus=' + corpus + ' 에서는 무시됩니다.';
  if (sort === 'latest') out.sortLatest = true;
  const hasItem = item != null && String(Array.isArray(item) ? item.join('') : item).trim() !== '';
  if (hasItem) {
    const r = resolveExplicit(item);
    const info = { input: Array.isArray(item) ? item : String(item), source: 'explicit', codes: r.codes, matched: r.matched.map(x => x.input + ' → ' + x.as), confidence: r.codes.length ? 'explicit' : 'none', applied: r.codes.length > 0 };
    if (r.unresolved.length) { info.unresolved = r.unresolved; if (r.suggestions.length) info.suggestions = r.suggestions; }
    if (r.matched.some(m => m.how === 'minor' && m.codes && m.codes.length > 1)) info.broad_group = true;   // RC: «환경»·«사회» 처럼 소분류 전체(여러 항목)로 넓게 해석됨을 알린다
    if (r.ambiguous.length) { info.ambiguous = true; info.candidates = r.ambiguous; if (!r.codes.length) info.reason = 'ambiguous_item'; }   // RC: 모호한 항목은 필터를 달지 않고 후보를 알린다
    if (r.codes.length && !appliesTo(corpus)) { info.applied = false; info.reason = 'corpus_not_disclosure'; out.info = info; return out; }   // 항목은 공시에만 있다 — legal·bylaws·ca 만 지정한 호출엔 걸지 않고 이유를 알린다
    if (r.codes.length) {
      out.itemCats = categoriesFor(r.codes); out.itemCodes = r.codes;
      if (corpus === 'all') { out.forceCorpus = 'disclosure'; info.corpus_forced = 'disclosure'; }   // 항목은 공시에만 있다 — 명시한 항목이면 공시만 본다
      const d = keyword ? detect(keyword, { corpus: 'disclosure' }) : null;                         // 키워드가 항목명 그 자체면 «본문 매칭 없이 항목 목록» 모드
      out.consumed = !keyword || !String(keyword).trim() || !!(d && d.consumed && d.codes.length && d.codes.every(c => r.codes.includes(c)) && !(d.strippedInst && !inst))
        || (keyword && r.codes.some(c => ITEMS.has(c) && norm(keyword) === norm(nameOf(ITEMS.get(c)))));   // MCPfix: keyword 가 지정한 항목명과 같으면(감지가 이웃 항목 B1010 도 잡아 every 가 실패하던 경우 포함) 목록 모드 — 제목 매칭 0건 방지
      if (out.consumed && keyword && String(keyword).trim()) info.keyword_note = 'keyword «' + String(keyword).trim().slice(0, 60) + '» 는 항목명과 같아 본문 매칭 없이 항목 목록으로 처리했습니다(항목 안에서 내용을 찾으려면 item 을 빼거나 다른 키워드를 쓰세요).';
    }
    out.info = info;
  } else if (m === 'auto' && keyword) {
    const d = detect(keyword, { corpus });
    if (d.codes.length) {
      out.info = { source: 'auto', codes: d.codes, phrases: d.phrases, confidence: d.confidence, applied: d.applied, ...(d.applied ? {} : { reason: d.reason }) };
      // 문장에서 기관명을 걷어냈는데 inst 필터가 없으면 «목록 모드» 로 가지 않는다(기관을 못 좁힌 채 전 기관 최신순을 주면 오히려 엉뚱하다)
      if (d.applied) { out.itemCats = categoriesFor(d.codes); out.itemCodes = d.codes; out.consumed = false; }   // RC: 자동 감지는 «목록 모드(본문 매칭 없이 항목 나열)» 로 가지 않는다 — 목록 모드는 명시 item 일 때만(경계 질의 오탐 시 결과가 통째로 바뀌는 것 방지)
    }
  }
  if (out.info && out.info.applied) out.info.items = out.itemCodes.map(c => nameOf(ITEMS.get(c)) + '(' + c + ')').slice(0, 12);
  return out;
}

/** period=latest: 계열(기관+항목)마다 가장 최근 공시 1건만. rows 는 submitted_at 내림차순이 아니어도 된다. 공시 외 행은 그대로. */
function latestPerSeries(rows) {
  const best = new Map();
  for (const r of rows) if (r.corpus === 'disclosure') { const k = (r.series_inst || r.inst_name) + '|' + r.category; const b = best.get(k); if (!b || String(r.submitted_at || '') > String(b.submitted_at || '')) best.set(k, r); }
  return rows.filter(r => r.corpus !== 'disclosure' || best.get((r.series_inst || r.inst_name) + '|' + r.category) === r);
}
/** sort=latest: «계열(기관+항목) 안에서만» 제출일(submitted_at) 내림차순으로 재배치 — 계열이 차지한 자리는 그대로 두고 그 자리들 안에서 최신이 앞에 오게 한다(없으면 뒤, 안정).
 *  전역 날짜 정렬은 관련도를 무너뜨려(의미검색 hit@10 0.756→0.512 실측) 쓰지 않는다. 공시 외 행·계열 키가 없는 행은 제자리. */
function sortLatestRows(rows) {
  const key = r => r.corpus === 'disclosure' ? (r.series_inst || r.inst_name) + '|' + r.category : null;
  const groups = new Map();
  rows.forEach((r, i) => { const k = key(r); if (k) (groups.get(k) || groups.set(k, []).get(k)).push(i); });
  const out = rows.slice(), sa = r => String(r.submitted_at || '');
  for (const idxs of groups.values()) {
    const sorted = idxs.map((i, j) => [rows[i], j]).sort((x, y) => (sa(y[0]) < sa(x[0]) ? -1 : sa(y[0]) > sa(x[0]) ? 1 : 0) || x[1] - y[1]).map(x => x[0]);
    idxs.forEach((pos, j) => { out[pos] = sorted[j]; });
  }
  return out;
}

/** 도구 설명에 붙이는 항목 안내(자연어). 길이 상한 내에서 항목명(중복 제거)과 대표 별칭. */
function describeItems() {
  const names = [...new Set(CAT.items.map(nameOf))];
  return '공시 항목 필터(ITEM_FILTER 가 explicit/auto 일 때): item="항목 이름(자연어) 또는 코드" — 코드를 몰라도 된다. ' +
    '예: item="임직원 수", item="수의계약"(=계약정보 B1030+70301), item="노동조합 가입정보", item="소송 및 법률자문 현황", item="21301". 쉼표로 여러 개. ' +
    '항목명: ' + names.join(', ') + '. period="2026Q2"|"2026"|"2026-07"|"latest"(기관·항목별 최신 1건), sort="latest"(같은 기관·항목 계열 안에서 제출일 최신이 앞). ' +
    '항목은 공시(disclosure) 문서에만 적용되고, 이름을 못 찾으면 필터 없이 item_resolved.unresolved/suggestions 로 알려준다. ' +
    '⚠ period 는 공시 «회차(제출) 라벨» 이지 대상 연도가 아니다(1~3월 제출 4분기 보고서는 다음 해 라벨, 회차마다 과거 연도 첨부가 재게시돼 period=2025 에도 2020~2024년 자료가 섞인다). 대상 분기/연도는 report_period, 자료 제목의 연도(«2025년»·«(2025)»)는 target_year 로 거를 것. 연도 첨부형 항목(제목에 연도가 없거나 회차마다 과거 연도가 첨부되는 항목)은 «제출 회차 기준» 으로 해석하고, target_year·report_period 필터는 제목 형식에 따라 문서를 놓칠 수 있으니(0건·적음이 «없음» 이 아님) 필터를 빼고 get_series 로 회차를 확인할 것.';
}

/** 검색 인자 객체(args)에 항목·기간 필드를 얹는다(호출부 공용). off 면 args 불변·null. raw = {item, period, sort} (HTTP 쿼리·MCP 인자 원본) */
function applyTo(args, raw) {
  const ctx = prepare({ item: raw.item, period: raw.period, sort: raw.sort, keyword: args.keyword, corpus: args.corpus, inst: args.inst, report_period: raw.report_period, target_year: raw.target_year, months: raw.months });
  if (!ctx) return null;
  if (ctx.forceCorpus) args.corpus = ctx.forceCorpus;
  if (ctx.itemCats) { args.itemCats = ctx.itemCats; args.itemList = ctx.consumed; }
  if (ctx.period) args.period = ctx.period;
  if (ctx.reportPeriod) args.reportPeriod = ctx.reportPeriod;
  if (ctx.targetYear) args.targetYear = ctx.targetYear;
  if (ctx.sortLatest) args.sortLatest = true;
  if (ctx.latest) args.latestPerSeries = true;
  return ctx;
}
const hasFilterArgs = a => hasPost(a);

module.exports = { hasPost, ignoredNote, parseReportPeriod, parseTargetYear, titleYear, targetYearClause, ADJ_LABEL_SQL, periodWarning, appliesTo, applyTo, hasFilterArgs, mode, norm, detect, resolveExplicit, categoriesFor, parsePeriod, itemClause, periodClause, prepare, latestPerSeries, sortLatestRows, describeItems, ITEMS, PHRASES, CAT };
