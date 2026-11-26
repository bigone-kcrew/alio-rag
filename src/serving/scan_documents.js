'use strict';
/**
 * MCPdeep: scan_documents(서버측 grep) + get_document find.
 * 필터로 정한 «문서 집합» 에서 키워드 묶음을 청크 본문(articles.body)에서 찾아 문서·기관별 발췌를 돌려준다.
 *  - 사전 구조화로 답할 수 없는 장꼬리 질의(«지난해 전파차단기를 구매한 기관?» «경영평가 우수사례»)를 «느려도 정직하게» 답하기 위한 도구.
 *  - 키워드는 «문자열» 로만 취급한다(정규식 비허용 → 정규식 DoS 불가). `|` 는 OR, 공백·대소문자 무시, 한글 조사는 부분일치라 자연 허용.
 *  - 문서 doc_id 순 키셋 페이지: 요청당 시간 예산(budget_sec) 안에서 배치(문서 N건)씩 읽고, 못 끝내면 next_cursor 로 이어받는다.
 *  - READ ONLY·배치별 statement_timeout·동시 실행 상한. 응답에 coverage 와 «찾지 못함 ≠ 없음» 고지를 항상 싣는다.
 */
const IF = require('./item_filter.js');
const S = require('./search.js');
const { resolveInst, isExtraInst } = require('./inst_alias.js');
const QX = require('./query_expand.js');
const SHD = require('./shell_docs.js');
const TH = require('./table_header.js');   // c6: TABLE_HEADER_V2=on 이면 발췌 청크가 표 조각일 때 열 이름 줄 결합

const MAX_TERMS = 12, MAX_PATTERNS = 40, MAX_BYTES = +process.env.MCP_SCAN_MAX_BYTES || 38000;   // 응답 본문 상한(바이트, 들여쓰기 JSON 여유 포함)
const MAX_CONC = +process.env.MCP_SCAN_CONC || 2;
let running = 0;
const intIn = (v, d, lo, hi) => { const n = parseInt(v, 10); return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : d)); };
const likeEsc = s => String(s).replace(/[\\%_]/g, '\\$&');
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bad = m => Object.assign(new Error(m), { code: 'BAD_REQUEST' });
const NOTICE = '«찾지 못함 ≠ 없음»: 이 결과는 수집·변환된 문서 본문(coverage 의 스캔 완료 범위)에서 입력한 표현(과 확장어)이 글자 그대로 나온 곳만이다. 본문 없는 문서·이미지 PDF·변환 실패·수집 범위 밖 첨부·다른 표현/오탈자는 잡히지 않고, 언급이 곧 사실(구매·시행 등)을 뜻하지도 않는다 — 발췌를 읽고 판단할 것. next_cursor 가 있으면 coverage.docs_remaining 만큼 아직 안 본 것이다.';

// 검색어 정리: 문자열|배열 → `|` 분리·공백 정리·중복 제거. 2~40자, 최대 MAX_TERMS.
const JSON_ARR_NOTE = '문자열 배열을 배열로 해석했다(terms 는 JSON 문자열이 아니라 배열 또는 «A|B» 로 보내면 된다).';
// «["a","b"]» 형태의 문자열(JSON 배열을 문자열로 보낸 경우)은 배열로 푼다. «[별표 1]» 같은 평범한 대괄호 표현은 그대로 검색어. 따옴표로 시작하는데 파싱이 안 되면 0건으로 속이지 않고 오류.
function unJson(x, notes) {
  if (typeof x !== 'string') return [x];
  const s = x.trim(); if (!/^\[\s*(?:["']|\])/.test(s) || !s.endsWith(']')) return [x];
  let v; try { v = JSON.parse(s); } catch (e) { v = null; }
  if (!Array.isArray(v) || v.some(t => typeof t !== 'string')) throw bad('terms 가 배열처럼 보이지만 JSON 문자열 배열로 읽을 수 없습니다(작은따옴표·끝 쉼표 불가). 배열 [\"전파차단기\",\"재밍\"] 또는 문자열 "전파차단기|재밍" 으로 보내세요.');
  if (notes) notes.push(JSON_ARR_NOTE); return v;
}
function parseTerms(raw, notes) {
  const arr = (Array.isArray(raw) ? raw : [raw]).flatMap(x => unJson(x, notes)).flatMap(x => String(x == null ? '' : x).split('|')).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [...new Set(arr)];
  if (!out.length) throw bad('terms 가 필요합니다(문자열 또는 배열, «A|B» 로 OR). 예: ["전파차단기","재밍"]');
  for (const t of out) if ([...t.replace(/\s/g, '')].length < 2 || [...t].length > 40) throw bad('검색어는 2~40자여야 합니다: «' + t.slice(0, 20) + '»');
  if (out.length > MAX_TERMS) throw bad('검색어는 최대 ' + MAX_TERMS + '개(OR) — 받은 수 ' + out.length);
  return out;
}
// SQL 사전 필터용 LIKE 패턴(lower(body) 의 bigm 인덱스 사용): 원문·공백 제거형, 붙여 쓴 짧은 한글어는 한 칸 띄운 변형 포함.
function likePatterns(terms) {
  const p = new Set();
  for (const t of terms) {
    const l = t.toLowerCase(), ns = l.replace(/\s/g, '');
    p.add(l); p.add(ns);
    if (ns === l && /[가-힣]/.test(ns) && ns.length >= 4 && ns.length <= 8) for (let i = 2; i <= ns.length - 2; i++) p.add(ns.slice(0, i) + ' ' + ns.slice(i));
  }
  return [...p].slice(0, MAX_PATTERNS).map(x => '%' + likeEsc(x) + '%');
}
// 본문 일치용 정규식(글자 사이 공백·개행 허용, 짧은 영문 약어는 단어 경계). 입력은 전부 escape 한 «문자열» 만.
function termRegex(t) {
  const chars = [...t.replace(/\s+/g, '')].map(reEsc), core = chars.join('\\s*');
  const asciiShort = /^[A-Za-z0-9 ]+$/.test(t) && t.replace(/\s/g, '').length <= 4;
  return new RegExp((asciiShort ? '(?<![A-Za-z0-9])' : '') + core + (asciiShort ? '(?![A-Za-z0-9])' : ''), 'gi');
}
// 청크 본문 → 일치 목록 [{s,e,term}] (시작순, 겹침 제거)
function findMatches(body, regs) {
  const m = [];
  for (const [t, re] of regs) { re.lastIndex = 0; let x; while ((x = re.exec(body)) && m.length < 400) { m.push({ s: x.index, e: x.index + x[0].length, term: t }); if (x[0].length === 0) re.lastIndex++; } }
  m.sort((a, b) => a.s - b.s || b.e - a.e);
  const out = []; for (const x of m) if (!out.length || x.s >= out[out.length - 1].e) out.push(x);
  return out;
}
// 일치 하나 + 앞뒤 ctx자 → 발췌(발췌 안의 모든 일치를 【 】 로 강조). 줄바꿈·표 구분자는 공백으로 접는다.
function excerptOf(body, ms, i, ctx) {
  const a = Math.max(0, ms[i].s - ctx);
  let b = Math.min(body.length, ms[i].e + ctx), k = i; while (k + 1 < ms.length && ms[k + 1].s < b) k++;   // 발췌 구간 안의 다음 일치까지 포함
  b = Math.min(body.length, Math.max(b, ms[k].e + Math.min(ctx, 40)));
  let out = '', pos = a;
  for (let j = i; j <= k; j++) { out += body.slice(pos, ms[j].s) + '【' + body.slice(ms[j].s, ms[j].e) + '】'; pos = ms[j].e; }
  out += body.slice(pos, b);
  return { text: (a > 0 ? '…' : '') + out.replace(/\s+/g, ' ').trim() + (b < body.length ? '…' : ''), next: k + 1 };
}
function excerpts(body, regs, per, ctx) {
  const ms = findMatches(body, regs), ex = []; let i = 0;
  while (i < ms.length && ex.length < per) { const e = excerptOf(body, ms, i, ctx); ex.push(e.text); i = e.next; }
  return { n: ms.length, terms: [...new Set(ms.map(x => x.term))], ex };
}

// ── 문서 집합 필터 → SQL(where 조각 + 파라미터) ──
function buildScope(a) {
  const params = [], parts = [], info = {}, notes = [];
  const P = v => { params.push(v); return '$' + params.length; };
  const corpus = a.corpus == null || a.corpus === '' ? 'disclosure' : String(a.corpus);
  if (!['disclosure', 'bylaws', 'ca', 'legal', 'all'].includes(corpus)) throw bad('corpus 는 disclosure|bylaws|ca|legal|all 중 하나(기본 disclosure)');
  info.corpus = corpus;
  if (corpus !== 'all') parts.push('d.corpus = ' + P(corpus));
  let narrowed = corpus !== 'all';
  if (a.item != null && String(Array.isArray(a.item) ? a.item.join('') : a.item).trim()) {
    const r = IF.resolveExplicit(a.item);
    if (!r.codes.length || r.ambiguous.length) throw bad('item 을 하나로 확정하지 못했습니다 — ' + JSON.stringify({ unresolved: r.unresolved, suggestions: r.suggestions, ambiguous: r.ambiguous }).slice(0, 600) + ' (코드를 알면 코드로, 항목명은 list_catalog kind="items" 로 확인)');
    if (!IF.appliesTo(corpus) || corpus === 'all') { if (corpus === 'all') parts.push("d.corpus = 'disclosure'"); else throw bad('item 은 공시(disclosure) 문서에만 적용됩니다'); }
    parts.push('d.category = ANY(' + P(IF.categoriesFor(r.codes)) + '::text[])');
    info.item_resolved = { codes: r.codes, matched: r.matched.map(x => x.input + ' → ' + x.as) }; narrowed = true;
  }
  const pc = (p, col) => { const c = IF.periodClause(P(p.val), p, corpus === 'all' ? 'disclosure' : corpus); if (c) parts.push(c); else params.pop(); return c; };
  if (a.period) { const p = IF.parsePeriod(a.period); if (p.latest) throw bad('scan_documents 는 period="latest" 를 지원하지 않습니다(연·분기·월만)'); pc(p); info.period = p.text; narrowed = true; const w = IF.periodWarning(p); if (w) notes.push(w); }
  if (a.report_period) { const p = IF.parseReportPeriod(a.report_period); pc(p); info.report_period = p.text; narrowed = true; }
  if (a.target_year) { const y = IF.parseTargetYear(a.target_year), c = IF.targetYearClause(P(y), corpus === 'all' ? 'disclosure' : corpus); if (c) parts.push(c); else params.pop(); info.target_year = y; narrowed = true; }
  const today = new Date(Date.now() + 9 * 3600e3);
  const sub = (v, name) => { const s = String(v).trim(); if (!/^20\d{2}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw bad(name + ' 는 YYYY-MM-DD 형식이어야 합니다'); return s; };
  let from = a.submitted_from ? sub(a.submitted_from, 'submitted_from') : null; const to = a.submitted_to ? sub(a.submitted_to, 'submitted_to') : null;
  if (a.months != null && a.months !== '') {
    const m = intIn(a.months, 0, 1, 120); if (!/^\d+$/.test(String(a.months).trim())) throw bad('months 는 1~120 정수');
    const d = new Date(today); d.setUTCMonth(d.getUTCMonth() - m); const c = d.toISOString().slice(0, 10); if (!from || c > from) from = c; info.months = m;
  }
  if (from) { parts.push(`d.meta->>'submitted_at' >= ${P(from)}`); info.submitted_from = from; narrowed = true; }
  if (to) { parts.push(`d.meta->>'submitted_at' <= ${P(to)}`); info.submitted_to = to; narrowed = true; }
  if (from || to) notes.push('제출일(submitted_at) 필터: 제출일 메타가 없는 문서(예: B1030 계약정보 첨부)는 제외됩니다 — 그런 항목은 period·target_year 로 기간을 거세요.');
  let instName = null;
  if (a.inst) { instName = resolveInst(String(a.inst)); if ([...instName.replace(/\s/g, '')].length < 2) throw bad('inst 는 2자 이상'); parts.push(`i.inst_name ILIKE '%'||${P(likeEsc(instName))}||'%'`); info.inst = instName; narrowed = true; }
  const mi = QX.resolveMinistry(a.ministry);
  if (mi.value) { parts.push(`i.ministry ILIKE '%'||${P(likeEsc(String(mi.value)))}||'%'`); info.ministry = mi.value; if (mi.from) info.ministry_resolved = { from: mi.from, to: mi.value, ...(mi.note ? { note: mi.note } : {}) }; narrowed = true; }
  if (a.doc_type) { parts.push(`d.doc_type ILIKE '%'||${P(likeEsc(String(a.doc_type).slice(0, 30)))}||'%'`); narrowed = true; }
  if (corpus !== 'disclosure') {   // 내규·단협·법령은 기본 «현행판만», 출연연(scope=extra)은 기관을 지정했을 때만
    if (a.all_versions !== true) parts.push(S.editionClause(P(false), P(null)).replace(/^\s*AND /, ''));
    if (!(instName && isExtraInst(instName))) parts.push(`COALESCE(d.meta->>'scope', '') <> 'extra'`);
  }
  if (!narrowed) throw bad('corpus 를 all 로 두면 item·기간·inst·ministry 중 하나 이상으로 문서 집합을 좁혀야 합니다');
  return { where: parts.length ? parts.join('\n AND ') : 'TRUE', params, info, notes };
}

const cursorOk = c => c == null || c === '' || (typeof c === 'string' && c.length <= 600);
async function scanDocuments(withPooled, a, opts = {}) {
  a = a && typeof a === 'object' ? a : {};
  const termNotes = [];
  let terms = parseTerms(a.terms != null ? a.terms : a.keyword, termNotes);
  const exp = a.expand === true ? QX.expandTerms(terms) : null;
  if (exp) terms = exp.terms;
  if (terms.length > MAX_TERMS * 2) terms = terms.slice(0, MAX_TERMS * 2);
  const regs = terms.map(t => [t, termRegex(t)]), pats = likePatterns(terms);
  const sc = buildScope(a);
  const limit = intIn(a.limit, 20, 1, 50), per = intIn(a.per_doc, 2, 1, 5), ctx = intIn(a.context, 150, 40, 300), budget = intIn(a.budget_sec, 20, 3, 30) * 1000;
  const distinct = a.distinct_inst === true;
  if (!cursorOk(a.cursor)) throw bad('cursor 가 올바르지 않습니다(직전 응답의 next_cursor 를 그대로)');
  const startCursor = a.cursor ? String(a.cursor) : '';
  if (running >= MAX_CONC) throw Object.assign(new Error('scan_documents 동시 실행 한도(' + MAX_CONC + ')를 넘었습니다. 몇 초 뒤 다시 시도하세요.'), { code: 'BUSY' });
  running++;
  const t0 = Date.now(), deadline = t0 + budget;
  const ro = ms => ["SET LOCAL transaction_read_only = on", `SET LOCAL statement_timeout='${Math.max(500, Math.round(ms))}ms'`];
  try {
    const base = sc.params.slice(), cp = '$' + (base.length + 1);   // 커서 파라미터 번호
    const fromSql = `FROM documents d LEFT JOIN institutions i USING (inst_code) WHERE ${sc.where} AND d.doc_id > ${cp}`;
    // 범위·건너뛴 문서 집계(시작 커서 이후 전체). 실패해도 스캔은 진행(범위 수는 null).
    let tot = null;
    try {
      tot = (await withPooled(ro(8000), async c => (await c.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE COALESCE(d.n_articles,0) = 0 OR d.parse_status IN ('shell_no_body','no_articles','empty'))::int AS no_body,
                count(*) FILTER (WHERE COALESCE(d.n_articles,0) > 0 AND d.parse_status NOT IN ('shell_no_body','no_articles','empty') AND COALESCE(d.content_chars,0) < 50)::int AS very_short,
                count(*) FILTER (WHERE d.parse_status IN ('low_coverage','truncated'))::int AS partial_parse ${fromSql}`, [...base, startCursor])).rows[0]));
    } catch (e) { if (!(e.code === '57014')) throw e; }
    let cursor = startCursor, batchN = 800, batches = 0, timedOut = false, done = false, full = false, modeA = true, bScanned = 0;
    const docs = [], insts = new Map(), firstBody = new Map(), recs = []; let bytes = 0, nDocs = 0;
    const META = `d.doc_id, i.inst_name, d.doc_title, split_part(d.category, '_', 1) AS item, d.meta->>'submitted_at' AS submitted_at, d.meta->>'period_label' AS period_label, d.doc_date, d.content_chars`;
    const A_LIMIT = 1500;
    while (!done && !full) {
      const remain = deadline - Date.now(); if (remain < 1500) break;
      let step;   // {metas(문서 메타, doc_id 순), rows(일치 청크), end(이 단계가 «다 본» 마지막 doc_id), last(범위 끝까지 봤는가)}
      try {
        if (modeA) {
          // A: 본문 bigm 인덱스로 «일치 청크만» 바로 찾는다(드문 표현은 문서 집합이 커도 수 ms~수 초). 시간 초과(흔한 표현·큰 집합)면 B 로 전환.
          step = await withPooled(ro(Math.min(6000, remain)), async c => {
            const rows = (await c.query(
              `SELECT ${META}, a.seq, a.title, a.body FROM articles a JOIN documents d ON d.doc_id = a.doc_id LEFT JOIN institutions i ON i.inst_code = d.inst_code
                WHERE ${sc.where} AND d.doc_id > ${cp} AND lower(a.body) LIKE ANY($${base.length + 2}::text[]) ORDER BY a.doc_id, a.seq LIMIT ${A_LIMIT}`, [...base, cursor, pats])).rows;
            let rs = rows; const last = rows.length < A_LIMIT;
            if (!last) { const lastId = rows[rows.length - 1].doc_id, k = rows.findIndex(r => r.doc_id === lastId); if (k > 0) rs = rows.slice(0, k); }   // 상한에 닿음 — 잘렸을 수 있는 마지막 문서는 다음 쪽에서
            const metas = [], seen = new Set(); for (const r of rs) if (!seen.has(r.doc_id)) { seen.add(r.doc_id); metas.push(r); }
            return { metas, rows: rs, end: last ? null : rs[rs.length - 1].doc_id, last };
          });
        } else {
          step = await withPooled(ro(Math.min(12000, remain)), async c => {
            const ids = (await c.query(`SELECT ${META} ${fromSql} ORDER BY d.doc_id LIMIT ${batchN}`, [...base, cursor])).rows;
            if (!ids.length) return { metas: [], rows: [], end: null, last: true, scannedN: 0 };
            // (lower(body) || '') 는 bigm 인덱스를 못 타게 하는 표기 — 이 배치의 문서만 읽는다(문서별 인덱스 + 본문 LIKE)
            let rows = (await c.query(`SELECT a.doc_id, a.seq, a.title, a.body FROM articles a WHERE a.doc_id = ANY($1::text[]) AND (lower(a.body) || '') LIKE ANY($2::text[]) ORDER BY a.doc_id, a.seq LIMIT 6000`, [ids.map(x => x.doc_id), pats])).rows;
            let metas = ids, last = ids.length < batchN, end = ids[ids.length - 1].doc_id;
            if (rows.length >= 6000) { const lastId = rows[rows.length - 1].doc_id, k = ids.findIndex(x => x.doc_id === lastId); metas = ids.slice(0, k + 1); const keep = new Set(metas.map(m => m.doc_id)); rows = rows.filter(r => keep.has(r.doc_id)); end = lastId; last = false; batchN = Math.max(20, Math.floor(batchN / 2)); }
            return { metas, rows, end, last, scannedN: metas.length };
          });
          bScanned += step.scannedN || 0;
        }
      } catch (e) {
        if (e.code !== '57014') throw e;
        if (modeA) { modeA = false; continue; }                                            // A 시간 초과 → B(문서 배치)로
        if (batchN > 20) { batchN = Math.max(20, Math.floor(batchN / 4)); continue; }     // B 시간 초과 → 배치를 줄여 재시도
        timedOut = true; break;
      }
      batches++;
      const byDoc = new Map(); for (const r of step.rows) (byDoc.get(r.doc_id) || byDoc.set(r.doc_id, []).get(r.doc_id)).push(r);
      for (const d of step.metas) {
        const hits = byDoc.get(d.doc_id);
        let rec = null;
        if (hits) {
          let n = 0; const tset = new Set(), ex = [];
          for (const h of hits) {
            const e = excerpts(String(h.body || ''), regs, per, ctx); if (!e.n) continue;   // LIKE 는 통과했지만 정규식(공백·경계 규칙)엔 안 맞음
            if (h.seq > 1 && !firstBody.has(d.doc_id)) firstBody.set(d.doc_id, String(h.body || '').slice(0, 600));
            n += e.n; e.terms.forEach(t => tset.add(t));
            for (const t of e.ex) if (ex.length < per) ex.push({ seq: h.seq, ...(h.title ? { article: String(h.title).slice(0, 60) } : {}), text: t });
          }
          if (n) rec = { doc_id: d.doc_id, inst_name: d.inst_name, doc_title: String(d.doc_title || '').slice(0, 100), item: d.item, submitted_at: d.submitted_at || undefined, period_label: d.period_label || undefined, doc_date: d.doc_date || undefined, n_matches: n, matched_terms: [...tset], excerpts: ex, ...(SHD.on() && (SHD.parse(d.doc_id) || {}).kind === 'c' && (d.content_chars || 0) < SHD.SHELL_CHARS ? { short_doc: true } : {}) };
        }
        if (rec) {
          if (distinct) rec = { ...rec, excerpts: rec.excerpts.slice(0, 1) };
          const g = distinct ? insts.get(rec.inst_name) : null;
          const keep = !distinct || !g || g.docs.length < 2;   // 기관별 상세는 2문서까지(나머지는 건수만)
          const rb = keep ? Buffer.byteLength(JSON.stringify(rec)) * 1.1 : 0;
          if ((!distinct && docs.length >= limit) || (distinct && !g && insts.size >= limit) || (rb && (docs.length || insts.size) && bytes + rb > MAX_BYTES)) { full = true; break; }   // 꽉 참 — 이 문서는 다음 쪽에서
          if (distinct) { const e = g || insts.set(rec.inst_name, { n_docs: 0, docs: [] }).get(rec.inst_name); e.n_docs++; if (keep) e.docs.push(rec); } else docs.push(rec);
          recs.push(rec); bytes += rb; nDocs++;
        }
        cursor = d.doc_id;
      }
      if (full) break;
      if (step.last) { done = true; break; }
      cursor = step.end;
      if (!modeA && Date.now() - t0 < budget / 2) batchN = Math.min(20000, batchN * 2);
    }
    if (TH.v2On() && firstBody.size && recs.length) {   // c6: 표 조각 발췌에 1번 청크의 열 이름 줄(추정) 결합 — 문서당 1개, 필드로만(발췌 본문 불변)
      try {
        const ids = [...new Set(recs.map(r => r.doc_id))].filter(id => firstBody.has(id));
        const c1 = await withPooled(ro(4000), async c => (await c.query('SELECT doc_id, left(body, 1500) AS b FROM articles WHERE doc_id = ANY($1::text[]) AND seq = 1', [ids])).rows);
        const m = new Map(c1.map(x => [x.doc_id, x.b]));
        for (const r of recs) { const c = m.get(r.doc_id); if (!c) continue; const h = TH.headerFor(c, firstBody.get(r.doc_id)); if (h) { r.table_header = h.text; r.header_source = h.source; r.header_confidence = h.confidence; } }
      } catch { /* 머리글 없이 계속 */ }
    }
    if (SHD.on() && recs.some(r => r.short_doc)) {   // c6: 껍데기 발췌에 같은 공시번호의 첨부 문서 id 연결(대체 문서 안내)
      try {
        const ps = [...new Set(recs.filter(r => r.short_doc).map(r => SHD.parse(r.doc_id)))].filter(Boolean);
        const got = await withPooled(ro(4000), async c => (await c.query(`SELECT s.pre, d.doc_id FROM unnest($1::text[], $2::text[]) AS s(inst, pre) JOIN documents d ON d.inst_code = s.inst AND d.doc_id LIKE s.pre || ':a:%' WHERE d.content_chars >= ${SHD.SHELL_CHARS} ORDER BY d.content_chars DESC`, [ps.map(p => p.inst), ps.map(p => p.pre)])).rows);
        const m = new Map(); for (const g of got) if (!m.has(g.pre)) m.set(g.pre, g.doc_id);
        for (const r of recs) if (r.short_doc) { const l = m.get(SHD.parse(r.doc_id).pre); r.short_note = l ? '본문 없는 공시 껍데기 페이지 — 같은 공시번호의 첨부 문서에 내용이 있음' : '본문 없는 공시 껍데기 페이지(연결된 첨부 없음)'; if (l) r.linked_doc_id = l; }
      } catch { /* 연결 없이 계속 */ }
    }
    // 스캔 완료 문서 수: 끝까지 봤으면 범위 전체, 아니면 시작 커서~현재 커서 사이 문서 수(세지 못하면 B 단계 합계)
    let scanned = tot ? tot.total : bScanned;
    if (!(done && !timedOut)) {
      scanned = bScanned;
      if (cursor !== startCursor) { try { scanned = (await withPooled(ro(5000), async c => (await c.query(`SELECT count(*)::int AS n FROM documents d LEFT JOIN institutions i USING (inst_code) WHERE ${sc.where} AND d.doc_id > ${cp} AND d.doc_id <= $${base.length + 2}`, [...base, startCursor, cursor])).rows[0].n)); } catch { /* 세지 못함 — B 합계 */ } }
    }
    const remaining = tot ? Math.max(0, tot.total - scanned) : null;
    const complete = done && !timedOut;
    const out = {
      tool_note: 'scan_documents — 문서 집합 전수 문자열 검색(서버측 grep). 키워드 묶음은 OR.' + (termNotes.length ? ' ' + termNotes[0] : ''),
      terms_used: terms, ...(exp && exp.expanded.length ? { expanded_terms: exp.expanded } : {}),
      filters_applied: sc.info, ...(sc.notes.length ? { filter_notes: sc.notes } : {}),
      coverage: {
        docs_in_scope: tot ? tot.total + (startCursor ? '(이번 커서 이후)' : '') : null,
        docs_scanned_this_call: scanned, docs_remaining: remaining,
        docs_no_body: tot ? tot.no_body : null, docs_very_short: tot ? tot.very_short : null, docs_partial_parse: tot ? tot.partial_parse : null,
        complete, elapsed_ms: Date.now() - t0, batches, budget_sec: budget / 1000,
        ...(timedOut ? { stopped: 'db_timeout' } : !complete && !full ? { stopped: 'time_budget' } : full ? { stopped: 'result_limit' } : {}),
        note: 'docs_no_body·very_short·partial_parse 는 본문이 없거나 짧거나 일부만 변환된 문서(스캔 대상이지만 내용이 없을 수 있음) 수 — 범위 전체 기준.',
      },
      matched_docs_this_call: nDocs,
    };
    if (distinct) {
      out.distinct_inst = true; out.matched_institutions_this_call = insts.size;
      out.institutions = [...insts].map(([inst_name, e]) => ({ inst_name, n_docs: e.n_docs, docs: e.docs }));
      out.distinct_note = '기관 수는 «이번 호출에서 찾은» 값이다. next_cursor 로 이어 받으면 앞서 나온 기관이 다시 나올 수 있으니 호출자가 합집합으로 센다.';
    } else out.results = docs;
    if (!complete) { out.next_cursor = cursor; out.resume = '같은 인자 + cursor=next_cursor 로 이어서 호출(필터·terms 를 바꾸지 말 것). 끝까지 보려면 next_cursor 가 사라질 때까지 반복.'; }
    out.notice = NOTICE;
    if (!docs.length) out.zero_result = complete ? '스캔한 모든 문서(위 coverage)에서 일치 없음 — «수집 범위 내 확인되지 않음» 으로만 답하고 coverage 의 건너뜀 수를 함께 밝힐 것.' : '지금까지 본 범위에서는 일치 없음(아직 다 보지 않음) — next_cursor 로 계속하세요.';
    return out;
  } finally { running--; }
}

// ── get_document find: 한 문서 안에서 일치 구절만 ──
async function findInDocument(withPooled, resolveDocId, annotateEdition, a) {
  const findNotes = [];
  let terms = parseTerms(a.find, findNotes);
  const exp = a.expand === true ? QX.expandTerms(terms) : null; if (exp) terms = exp.terms;
  const regs = terms.map(t => [t, termRegex(t)]), pats = likePatterns(terms);
  const ctx = intIn(a.context, 150, 40, 400), per = intIn(a.max_matches, 20, 1, 60);
  return withPooled(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='15s'"], async c => {
    const docId = await resolveDocId(c, String(a.doc_id || ''));
    const doc = (await c.query(`SELECT d.doc_id, d.corpus, d.doc_title, d.doc_type, d.doc_date, d.n_articles, i.inst_name, i.ministry, d.meta->>'submitted_at' AS submitted_at, d.meta->>'period_label' AS period_label
                                  FROM documents d LEFT JOIN institutions i USING (inst_code) WHERE d.doc_id = $1`, [docId])).rows[0];
    if (!doc) throw new Error('문서 없음: ' + String(a.doc_id || '').slice(0, 100) + ' — 추측하거나 지어내지 말고, search_corpus 결과의 doc_id 를 그대로 써서 다시 호출하세요.');
    const total = (await c.query('SELECT count(*)::int n, COALESCE(sum(n_chars),0)::bigint chars FROM articles WHERE doc_id = $1', [docId])).rows[0];
    const rows = (await c.query('SELECT seq, title, body FROM articles WHERE doc_id = $1 AND lower(body) LIKE ANY($2::text[]) ORDER BY seq LIMIT 400', [docId, pats])).rows;
    const matches = []; let n = 0, arts = 0, firstRow = null;
    for (const r of rows) {
      const e = excerpts(String(r.body || ''), regs, 3, ctx); if (!e.n) continue;
      arts++; n += e.n; if (r.seq > 1 && firstRow === null) firstRow = String(r.body || '').slice(0, 600);
      for (const t of e.ex) if (matches.length < per) matches.push({ seq: r.seq, ...(r.title ? { article: String(r.title).slice(0, 60) } : {}), text: t });
    }
    let th = null;
    if (TH.v2On() && firstRow) { const c1 = (await c.query('SELECT left(body, 1500) AS b FROM articles WHERE doc_id = $1 AND seq = 1', [docId])).rows[0]; th = c1 ? TH.headerFor(c1.b, firstRow) : null; }
    return {
      ...(th ? { table_header: th.text, header_source: th.source, header_confidence: th.confidence } : {}),
      document: annotateEdition([doc])[0], find: { terms_used: terms, ...(findNotes.length ? { note: findNotes[0] } : {}), ...(exp && exp.expanded.length ? { expanded_terms: exp.expanded } : {}) },
      articles_with_match: arts, total_matches: n, matches_shown: matches.length, ...(matches.length < n ? { more_matches: true } : {}),
      articles_scanned: total.n, doc_chars: Number(total.chars), matches,
      note: matches.length ? '일치 구절만 보여 준 것이다(전후 ' + ctx + '자). 맥락이 필요하면 get_document(include_body)·get_article 로 해당 seq 를 읽을 것.' : '이 문서 본문(청크 ' + total.n + '개)에서 일치 없음 — «이 문서에는 해당 표현이 없다» 는 뜻일 뿐 다른 표현·표/이미지 속 글자는 잡히지 않는다.',
    };
  });
}

function toolDef() {
  return {
    name: 'scan_documents',
    description: '필터한 문서 집합 본문 전체에서 terms("A|B"=OR)를 찾는 느린 서버측 grep(장꼬리 질의용). 문서별 발췌·coverage 반환, next_cursor 는 같은 인자+cursor 로 이어받기. «찾지 못함≠없음»: 0건은 coverage 와 함께 «수집 범위 내 확인되지 않음» 으로만 답할 것.',
    inputSchema: { type: 'object', properties: {
      terms: { type: ['string', 'array'], items: { type: 'string' }, description: '2~40자, 최대 12개' },
      expand: { type: 'boolean', description: '동의어 확장' },
      corpus: { type: 'string', enum: ['disclosure', 'bylaws', 'ca', 'legal', 'all'] },
      item: { type: 'string', description: '공시 항목명·코드' },
      period: { type: 'string' }, report_period: { type: 'string' }, target_year: { type: 'string' },
      months: { type: 'integer', description: '최근 N개월 제출' }, submitted_from: { type: 'string', description: 'YYYY-MM-DD' },
      inst: { type: 'string' }, ministry: { type: 'string' },
      distinct_inst: { type: 'boolean', description: '기관별 묶음' }, limit: { type: 'integer' }, cursor: { type: 'string' },
    }, required: ['terms'] },
  };
}
module.exports = { scanDocuments, findInDocument, toolDef, parseTerms, likePatterns, termRegex, findMatches, excerpts, buildScope, _internal: { MAX_CONC, get running() { return running; } } };
