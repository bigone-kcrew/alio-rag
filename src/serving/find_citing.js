'use strict';
/**
 * find_citing(법령 기준 역조회): «이 법령(·조문)을 인용하는 기관 내규·단체협약 조문». rag_ext.bylaw_cite_link(kind='law')만 읽는다.
 * 플래그: MCP_FIND_CITING=on(기본 off, 마운트는 mcp_server.js) · MCP_FIND_CITING_EXTERNAL=on(기본 off — external·미지정 tier 비노출).
 * 규칙: READ ONLY·값 바인딩·limit≤50·기관 접기(기관·문서 계열·조문 단위 최신 판 1건)·statement_timeout 5s·동시 4·응답 문자열 마스킹.
 * 한계는 응답에 항상 싣는다: 링크는 규칙 기반 추출(LLM 없음)·legal 코퍼스에 있는 법령만 해소(없는 법령은 인용이 있어도 여기 안 나옴)·
 * 인용 당시의 법 «판» 은 ed_conf 로만 표시(조 번호가 판 사이에서 이동했는지는 확인하지 않음)·기관 수는 «수록 코퍼스 기준 하한».
 */
const { resolveInst } = require('./inst_alias.js');
const { maskText, maskOptsForTier } = require('./mask_pii.js');
const norm = t => String(t == null ? '' : t).replace(/[·ㆍ‧・∙･]/g, '').replace(/\s+/g, '');
const bad = m => Object.assign(new Error(m), { code: 'BAD_REQUEST' });
const ALIAS = Object.fromEntries(Object.entries({   // 규칙 사전(MANUAL)과 같은 약칭
  노조법: '노동조합 및 노동관계조정법', 근기법: '근로기준법', 공운법: '공공기관의 운영에 관한 법률', 근참법: '근로자참여 및 협력증진에 관한 법률',
  남녀고용평등법: '남녀고용평등과 일·가정 양립 지원에 관한 법률', 산안법: '산업안전보건법', 청탁금지법: '부정청탁 및 금품등 수수의 금지에 관한 법률',
  중대재해처벌법: '중대재해 처벌 등에 관한 법률', 중처법: '중대재해 처벌 등에 관한 법률', 고령자고용촉진법: '고용상 연령차별금지 및 고령자고용촉진에 관한 법률',
  국가계약법: '국가를 당사자로 하는 계약에 관한 법률', 지방계약법: '지방자치단체를 당사자로 하는 계약에 관한 법률', 개인정보법: '개인정보 보호법',
}).map(([k, v]) => [norm(k), norm(v)]));
const NOTE = '이 목록은 내규·단체협약 조문 본문의 «법령명 + 제N조» 표기를 규칙으로 추출한 결과입니다(LLM 아님). ① legal 코퍼스에 수록된 법령만 연결되며 미수록 법령은 인용이 있어도 나오지 않습니다 ② 인용 당시의 법 «판» 은 ed_conf 로만 표시하고 조 번호가 개정으로 옮겨졌는지는 확인하지 않습니다 ③ «같은 법·동법 제N조» 는 같은 조문 안 직전 법령을 이어받아 해소하고, 앞 법령이 명시되지 않은 맨 «법 제N조» 는 연결하지 않습니다(누락 가능) ④ 기관 수·건수는 수록 문서 기준 하한이며 순위·비율 근거로 쓰지 마세요. 원문은 get_article(doc_id, seq) 로 확인하세요.';
const ED_NOTE = '시점 판 확인 불가';

let lawCache = { t: 0, v: null }, unmCache = { t: 0, v: null };
async function laws(wp) {   // law_key → 링크 수 (10분 캐시)
  if (lawCache.v && Date.now() - lawCache.t < 600000) return lawCache.v;
  const rows = await wp(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='5s'"], async c => (await c.query("SELECT law_key, count(*)::int n FROM rag_ext.bylaw_cite_link WHERE kind='law' GROUP BY 1")).rows);
  lawCache = { t: Date.now(), v: new Map(rows.map(r => [r.law_key, r.n])) }; return lawCache.v;
}
async function unmatched(wp) {   // 정규화한 미해소 법령명 → 건수 상위 3000 (30분 캐시) — «코퍼스에 없는 법령» 안내용
  if (unmCache.v && Date.now() - unmCache.t < 1800000) return unmCache.v;
  const rows = await wp(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='5s'"], async c => (await c.query("SELECT regexp_replace(name_raw,'[[:space:]·ㆍ]','','g') k, count(*)::int n FROM rag_ext.bylaw_cite_link WHERE kind='unmatched' AND name_raw ~ '(법|법률|령|규칙)$' GROUP BY 1 ORDER BY 2 DESC LIMIT 3000")).rows);
  unmCache = { t: Date.now(), v: new Map(rows.map(r => [r.k, r.n])) }; return unmCache.v;
}
function parseArt(s) {   // '제60조' '60' '18의2' '제18조의2' → {no, sub}
  if (s == null || s === '') return null;
  const m = String(s).replace(/\s+/g, '').match(/^제?(\d{1,4})(?:조)?(?:의(\d{1,3}))?(?:조)?$/);
  if (!m) throw bad('art: «제60조»·«60»·«18의2» 형식으로 주세요.');
  return { no: +m[1], sub: m[2] ? +m[2] : null };
}
function normalize(a) {
  a = a && typeof a === 'object' && !Array.isArray(a) ? a : {};
  const law = String(a.law == null ? '' : a.law).trim();
  if (law.length < 2 || law.length > 80) throw bad('law: 법령명(2~80자)을 주세요. 예: 근로기준법 · 산업안전보건법 시행령');
  const corpus = a.corpus == null || a.corpus === '' || a.corpus === 'all' ? null : String(a.corpus);
  if (corpus && !['bylaws', 'ca'].includes(corpus)) throw bad('corpus: bylaws(기관 내규) 또는 ca(단체협약) 만 가능합니다.');
  const lim = parseInt(a.limit, 10), per = parseInt(a.per_inst, 10);
  return { law, art: parseArt(a.art), corpus, inst: a.inst ? String(a.inst).slice(0, 60) : null,
    limit: Math.min(50, Math.max(1, Number.isFinite(lim) ? lim : 20)), perInst: Math.min(3, Math.max(1, Number.isFinite(per) ? per : 1)) };
}
const famTitle = t => norm(String(t || '').replace(/\(.*?\)|（.*?）|_?\d{8}|\d{4}[.\-]\d{1,2}[.\-]\d{1,2}/g, ''));
const docDate = r => (String(r.src_doc_id).match(/_(\d{8})\.md$/) || [])[1] || String(r.doc_date || '').replace(/-/g, '');
const artRef = (no, sub) => '제' + no + '조' + (sub ? '의' + sub : '');
let running = 0;
async function findCiting(wp, a, ctx) {
  const o = normalize(a), tier = ctx && ctx.tier, mo = maskOptsForTier(tier);
  if (running >= 4) throw Object.assign(new Error('find_citing 동시 실행 한도(4)를 넘었습니다. 몇 초 뒤 다시 시도하세요.'), { code: 'BUSY' });
  running++;
  try {
    const known = await laws(wp);
    let k = norm(o.law); k = ALIAS[k] || k;
    let lawKey = known.has(k) ? k : null;
    if (!lawKey && k.length >= 3) {
      const cand = [...known.entries()].filter(([key]) => key.includes(k)).sort((x, y) => y[1] - x[1]);
      if (cand.length === 1) lawKey = cand[0][0];
      else if (cand.length > 1) return { law: o.law, resolved: false, ambiguous: true, candidates: cand.slice(0, 10).map(([key, n]) => ({ law_key: key, links: n })), count: 0, rows: [], note: '법령명이 여러 개와 맞습니다. candidates 의 law_key 중 하나(공백 없는 정식명)로 다시 호출하세요.' };
    }
    if (!lawKey) {
      const u = await unmatched(wp), n = u.get(k) || 0;
      return { law: o.law, resolved: false, count: 0, rows: [], law_in_corpus: false,
        note: n ? `«${o.law}» 는 legal 코퍼스에 수록되지 않아 인용이 법령 문서와 연결되지 않았습니다(내규·단협 본문에서 이름만 ${n}건 확인). 연결된 조문 목록은 제공할 수 없습니다 — search_corpus 로 법령명 키워드 검색을 하세요.` : '이 법령명으로 연결된 인용이 없습니다(법령명 표기를 바꾸거나 search_corpus 로 확인하세요). 0건은 «인용 없음» 확정이 아닙니다.' };
    }
    const w = ["l.kind='law'", 'l.law_key = $1', 'l.art_no >= 1', "COALESCE(d.meta->>'edition_status','current') = 'current'", "COALESCE(d.meta->>'scope','') <> 'extra'"], p = [lawKey];
    if (o.art) { p.push(o.art.no); w.push(`l.art_no = $${p.length}`); if (o.art.sub) { p.push(o.art.sub); w.push(`l.art_sub = $${p.length}`); } else w.push('l.art_sub IS NULL'); }
    if (o.corpus) { p.push(o.corpus); w.push(`l.src_corpus = $${p.length}`); }
    let instName = null;
    if (o.inst) { instName = resolveInst(o.inst); p.push('%' + String(instName).replace(/[\\%_]/g, '\\$&') + '%'); w.push(`i.inst_name ILIKE $${p.length}`); }
    const rows = await wp(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='5s'"], async c => (await c.query(
      `SELECT l.src_doc_id, l.src_seq, l.src_corpus, l.src_inst_code, l.src_art_no, l.src_art_sub, l.ev_text, l.locator, l.art_no, l.art_sub, l.ed_conf, l.edition_ef, l.ref_basis,
              d.doc_title, d.doc_date, i.inst_name
         FROM rag_ext.bylaw_cite_link l JOIN documents d ON d.doc_id = l.src_doc_id LEFT JOIN institutions i ON i.inst_code = l.src_inst_code
        WHERE ${w.join(' AND ')} ORDER BY l.src_inst_code, d.doc_title, l.src_doc_id, l.src_seq LIMIT 4000`, p)).rows);
    // 같은 기관·같은 문서 계열·같은 조문은 최신 판 1건으로 접는다
    const fold = new Map();
    for (const r of rows) {
      const key = [r.src_inst_code, r.src_corpus, famTitle(r.doc_title), r.src_art_no == null ? 's' + r.src_seq : r.src_art_no + '/' + (r.src_art_sub || '')].join('|'), cur = fold.get(key);
      if (!cur || docDate(r) > docDate(cur)) fold.set(key, r);
    }
    const byInst = new Map();
    for (const r of fold.values()) { if (!byInst.has(r.src_inst_code)) byInst.set(r.src_inst_code, []); byInst.get(r.src_inst_code).push(r); }
    const out = [];   // 기관 다양성: 기관별 최대 perInst 건을 라운드로빈
    for (let round = 0; round < o.perInst && out.length < o.limit; round++)
      for (const list of byInst.values()) { if (list[round] && out.length < o.limit) out.push(list[round]); }
    const mk = s => s == null ? s : maskText(String(s), mo).text;
    const items = out.map(r => ({ doc_id: r.src_doc_id, seq: r.src_seq, corpus: r.src_corpus, inst_code: r.src_inst_code, inst_name: r.inst_name, doc_title: mk(r.doc_title),
      art_ref: r.src_art_no == null ? null : artRef(r.src_art_no, r.src_art_sub), cited: mk(r.ev_text), cited_art: artRef(r.art_no, r.art_sub) + String(r.locator || '').replace(/^제\d+조(의\d+)?/, ''),
      ed_conf: r.ed_conf || null, ...(r.ed_conf === 'ok' ? {} : { ed_note: ED_NOTE }) }));
    const res = { law: o.law, law_key: lawKey, resolved: true, ...(o.art ? { art: artRef(o.art.no, o.art.sub) } : {}), ...(o.corpus ? { corpus: o.corpus } : {}), ...(instName ? { inst: instName } : {}),
      units_total: fold.size, institutions_total: byInst.size, truncated_scan: rows.length >= 4000, count: items.length, per_inst: o.perInst, rows: items,
      coverage: { scope: '현행 내규·단체협약(연혁 판·출연연 scope=extra 제외, 맨 «법 제N조» 미연결), 기관·문서 계열·조문 단위로 접음', law_links_total: known.get(lawKey), law_in_corpus: true }, note: NOTE };
    if (!items.length) res.hint = '0건은 «인용 없음» 확정이 아닙니다(법령명을 줄여 쓴 표기·미수록 표기는 연결되지 않을 수 있음). art·inst 조건을 빼 보거나 search_corpus 키워드 검색을 병행하세요.';
    return res;
  } finally { running--; }
}
const toolDef = () => ({ name: 'find_citing', description: '법령(·조문)을 인용하는 기관 내규·단체협약 조문 역조회(기관 단위 목록, 순위·빈도 아님).',
  inputSchema: { type: 'object', properties: { law: { type: 'string', description: '법령명(약칭 가능)' }, art: { type: 'string', description: '예: 제60조·18의2' },
    corpus: { type: 'string', enum: ['bylaws', 'ca'] }, inst: { type: 'string' }, limit: { type: 'integer' } }, required: ['law'] } });
module.exports = { findCiting, toolDef, normalize, parseArt, norm, famTitle, ALIAS, _internal: { resetCache: () => { lawCache = { t: 0, v: null }; unmCache = { t: 0, v: null }; }, get running() { return running; } } };
