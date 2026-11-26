'use strict';
/**
 * ALIO RAG MCP 도구 확장 (2026-10-27) — 모두 «환경 플래그 on» 일 때만 노출·실행. 플래그가 없으면 이 모듈은 아무것도 하지 않아
 * tools/list·응답이 정합안(20261027_mcp_desc)과 바이트 동일하다.
 *   MCP_DOC_OFFSET=on   get_document 에 offset 인자(이어서 가져오기) — 노출은 mcp_server.js(patchDocumentTool), 여기선 스키마만
 *   MCP_LIST_CATALOG=on list_catalog   필터 값 목록(기관·부처·문서유형·활용처·공시항목)
 *   MCP_COMPARE=on      compare_documents  두 문서 조문 대조(JSON)
 *   MCP_SERIES=on       get_series   기관·항목의 회차/판본 연혁 목록(수치 추출 없음)
 *   MCP_RELATED=on      get_related  조문의 인용(outgoing)·피인용(incoming, 근사)
 *   MCP_ITEM_DESC=compact  search_corpus 설명의 항목명 목록을 list_catalog 안내 한 줄로(MCP_LIST_CATALOG=on·ITEM_FILTER 켜짐일 때만)
 *   MCP_STRUCTURED=on   structured_query  rag_ext 구조화 데이터(공시 필드 값·채용·징계·지적·계약) 조회·집계 — 본체는 structured_query.js (STRUCTURED_CONTRACTS=on 이면 contracts 데이터셋 노출)
 *   MCP_RELATED_INCOMING=on  get_related 의 incoming 방향(별도 플래그, 기본 off — off 면 outgoing 만)
 * 모든 DB 접근은 읽기 전용 SELECT + statement_timeout 5s. 응답 키는 maskExtra 가 등급별로 마스킹한다.
 */
const crypto = require('crypto');
const { resolveInst } = require('./inst_alias');
const IF = require('./item_filter.js');
const S = require('./search.js');
const { maskText, maskOptsForTier, ID_KEYS } = require('./mask_pii.js');
let judgeArticle = null; try { ({ judgeArticle } = require('./lib/article_quality.js')); } catch { /* compare 는 이 판정 규칙 없이 열지 않는다 */ }

const on = k => process.env[k] === 'on';
const intIn = (v, def, lo, hi) => { const n = parseInt(v, 10); return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : def)); };
const likeEsc = s => String(s).replace(/[\\%_]/g, '\\$&');
const TIMEOUT = "SET LOCAL statement_timeout='5s'";
const CORPORA = ['all', 'legal', 'bylaws', 'ca', 'disclosure'];

// ── 응답 마스킹 ─────────────────────────────────────────────────────────────
// 기존 maskOut 은 rows·articles·document 만 가린다. 새 도구의 응답 키(items·changes·series·outgoing·incoming·a·b 등)는
// 여기서 «모든 문자열 값»을 등급별 옵션으로 가린다(식별자 키 제외). 대상 값(기관명·부처명·조문 제목·본문 발췌)에 개인정보가 들어올 가능성은 낮지만
// 코드로 배제할 수 없어(본문·제목은 자유 텍스트) 일괄 적용한다.
const EXT_KEYS = ['items', 'changes', 'series', 'outgoing', 'incoming', 'unresolved', 'a', 'b', 'notes', 'results', 'institutions', 'matches'];   // MCPdeep: scan_documents(results·institutions)·get_document find(matches) 의 발췌문
const SKIP = new Set([...ID_KEYS, 'doc_id', 'rel_path', 'hash_a', 'hash_b', 'art_ref', 'status', 'kind', 'period_label', 'period_label_adj', 'target_year', 'submitted_at', 'edition_state', 'category', 'code', 'codes']);
function maskDeepTier(v, mo, key) {
  if (typeof v === 'string') return key && SKIP.has(key) ? v : maskText(v, mo).text;
  if (Array.isArray(v)) return v.map(x => maskDeepTier(x, mo, key));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = maskDeepTier(v[k], mo, k); return o; }
  return v;
}
function maskExtra(out, tier) {
  const mo = maskOptsForTier(tier); const o = { ...out };
  for (const k of EXT_KEYS) if (o[k] != null) o[k] = maskDeepTier(o[k], mo, k);
  return o;
}

// ── 무거운 호출 한도(분당, 프로세스 내) ───────────────────────────────────────
// mcp_http.js 의 전역·키별 한도는 도구 이름을 보지 않고 tools/call 한 건을 1회로 센다 → 새 도구도 그 한도(분당 40·키별 limits)에 자동 편입된다.
// 그에 더해 compare·related 는 DB 부하가 커서 별도 낮은 한도를 둔다. 키 = tier:label(셀프 키 별칭; 익명은 «anon» 한 통). internal·master 는 한도를 높게.
const heavyHits = new Map();
function heavyLimited(name, ctx) {
  if (!ctx) return false;   // 직접 호출(시험)·ctx 없음
  const ext = ctx.tier !== 'internal' && ctx.tier !== 'master';
  const max = intIn(process.env['MCP_' + name.toUpperCase() + '_PER_MIN'], 0, 0, 10000) || ({ compare: ext ? 5 : 30, related: ext ? 10 : 60, structured: ext ? 20 : 120, scan: ext ? 4 : 20 }[name]);
  const k = name + ':' + ctx.tier + ':' + (ctx.label || ''), now = Date.now();
  const a = (heavyHits.get(k) || []).filter(t => now - t < 60000);
  if (a.length >= max) { heavyHits.set(k, a); return { max, retry: Math.max(1, Math.ceil((a[0] + 60000 - now) / 1000)) }; }
  a.push(now); heavyHits.set(k, a);
  if (heavyHits.size > 5000) for (const [kk, v] of heavyHits) if (!v.some(t => now - t < 60000)) heavyHits.delete(kk);
  return false;
}
const limitErr = (name, v) => new Error(`${name} 호출 한도(분당 ${v.max}회)를 넘었습니다. ${v.retry}초 후 다시 시도하세요.`);

// 시간 초과 문구는 «그 도구에 실제로 있는 인자» 만 가리킨다(스키마와 모순 금지).
const isTmo = e => !!e && (e.code === '57014' || /statement timeout/i.test(e.message));
const tmoMsg = (what, hint, sec = 5) => `${what} 조회가 시간 제한(${sec}초)에 걸렸습니다. ${hint || '잠시 후 다시 시도하세요.'}`;
const wrapTmo = (what, e, hint, sec) => (isTmo(e) ? new Error(tmoMsg(what, hint, sec)) : e);
const NOT_FOUND_TAIL = ' — 추측하거나 지어내지 말고, search_corpus 결과의 doc_id 를 그대로 써서 다시 호출하세요.';   // mcp_server.js 와 같은 문구(2026-11-12)
const catHint = (kind, tail) => (process.env.MCP_LIST_CATALOG === 'on' ? ` (list_catalog kind=${kind} ${tail})` : '');

// ═══ list_catalog ═══════════════════════════════════════════════════════════
const CAT_TTL = intIn(process.env.MCP_CATALOG_TTL_SEC, 600, 10, 86400) * 1000;
const catCache = new Map();   // kind|corpus → { t, rows }
const CAT_SQL = {
  institutions: `SELECT i.inst_name AS value, i.ministry, count(*)::int AS count FROM documents d JOIN institutions i USING (inst_code)
                  WHERE ($1::text IS NULL OR d.corpus = $1) AND COALESCE(d.meta->>'scope', '') <> 'extra' GROUP BY i.inst_name, i.ministry ORDER BY count DESC, value LIMIT 5000`,
  ministries: `SELECT i.ministry AS value, count(*)::int AS count FROM documents d JOIN institutions i USING (inst_code)
                WHERE i.ministry IS NOT NULL AND ($1::text IS NULL OR d.corpus = $1) AND COALESCE(d.meta->>'scope', '') <> 'extra' GROUP BY i.ministry ORDER BY count DESC, value LIMIT 5000`,
  doc_types: `SELECT d.doc_type AS value, count(*)::int AS count FROM documents d
               WHERE d.doc_type IS NOT NULL AND ($1::text IS NULL OR d.corpus = $1) AND COALESCE(d.meta->>'scope', '') <> 'extra' GROUP BY d.doc_type ORDER BY count DESC, value LIMIT 5000`,
  usecases: `SELECT u AS value, count(*)::int AS count FROM documents d, unnest(d.usecases) AS u
              WHERE ($1::text IS NULL OR d.corpus = $1) AND COALESCE(d.meta->>'scope', '') <> 'extra' GROUP BY u ORDER BY count DESC, value LIMIT 5000`,
};
const CAT_KINDS = ['institutions', 'ministries', 'doc_types', 'usecases', 'items'];

function itemRows() {   // DB 없이 item_catalog.json 사전(item_filter.js)을 재사용 — 같은 항목명은 한 줄로 합산
  const by = new Map();
  for (const it of IF.CAT.items) {
    const name = it.name || it.minor, e = by.get(name) || { value: name, count: 0, codes: [] };
    e.count += it.n || 0; e.codes.push(it.code); by.set(name, e);
  }
  return [...by.values()].sort((x, y) => y.count - x.count || x.value.localeCompare(y.value));
}

// 데이터 오염 방어: doc_type 에 공시 접수번호형 값(«_2026092903246647»)이 섞여 있다(94종 중 42종, 2026-10-27 실DB 점검). 숫자·밑줄·공백·하이픈만으로 된 값과 30자 초과 값은 목록에서 빼고 건수만 알린다(값 자체는 노출 안 함).
// 기관명·부처·항목에는 적용하지 않는다(정상 값이 걸릴 위험 > 이득). doc_type·usecase 한정.
const NOISE_KINDS = ['doc_types', 'usecases'];
const isNoise = v => !v || /^[_\d\s\-]+$/.test(v) || String(v).length > 30;
async function catalogRows(kind, corpus, ctx) {
  if (kind === 'items') {
    if (IF.mode() === 'off') throw new Error('items 목록은 서버 설정 ITEM_FILTER=explicit(또는 auto)가 필요합니다(관리자 설정 — 현재 꺼져 있음). 다른 kind 는 가능합니다.');
    return { rows: itemRows(), stale: false };
  }
  const key = kind + '|' + corpus, hit = catCache.get(key), now = Date.now();
  if (hit && now - hit.t < CAT_TTL) return { rows: hit.rows, stale: false, excluded: hit.excluded };
  try {
    let rows = await ctx.withPooled([TIMEOUT], async c => (await c.query(CAT_SQL[kind], [corpus === 'all' ? null : corpus])).rows);
    let excluded = 0;
    if (NOISE_KINDS.includes(kind)) { const n0 = rows.length; rows = rows.filter(r => !isNoise(r.value)); excluded = n0 - rows.length; }
    catCache.set(key, { t: now, rows, excluded });
    return { rows, stale: false, excluded };
  } catch (e) {
    process.stderr.write(`[mcp] list_catalog ${key}: ${e.message}\n`);
    if (hit) return { rows: hit.rows, stale: true, excluded: hit.excluded };   // 폴백: 만료된 캐시라도 «오래된 값» 표시와 함께 돌려준다
    throw wrapTmo('목록', e, 'corpus 를 지정하거나 잠시 후 다시 시도하세요.');
  }
}

function makeListCatalog(ctx) {
  return async function toolListCatalog(a) {
    const kind = String(a.kind || '');
    if (!CAT_KINDS.includes(kind)) throw new Error('kind 는 ' + CAT_KINDS.join('|') + ' 중 하나여야 합니다');
    const corpus = a.corpus == null || a.corpus === '' ? 'all' : String(a.corpus);
    if (!CORPORA.includes(corpus)) throw new Error('corpus 는 ' + CORPORA.join('|') + ' 중 하나여야 합니다');
    const limit = intIn(a.limit, 50, 1, 200), offset = intIn(a.offset, 0, 0, 1e6);
    const q = String(a.q || '').slice(0, 100).trim().toLowerCase();
    const { rows, stale, excluded } = await catalogRows(kind, corpus, ctx);
    const hit = q ? rows.filter(r => r.value.toLowerCase().includes(q)) : rows;
    const items = hit.slice(offset, offset + limit);
    return { kind, total: hit.length, items, ...(offset + limit < hit.length ? { next_offset: offset + limit } : {}),
      ...(NOISE_KINDS.includes(kind) ? { meta: { excluded_noise: excluded || 0 } } : {}),
      ...(stale ? { stale: true, note: '조회 실패로 이전에 받아 둔 목록(캐시)을 돌려줍니다.' } : {}),
      ...(kind === 'items' ? { note: 'count 는 항목 사전 스냅샷의 문서 수(근사). search_corpus 의 item 에는 value 를 그대로 쓴다.' } : { count_unit: '문서 수(조문 수 아님)' }) };
  };
}

// ═══ compare_documents ══════════════════════════════════════════════════════
// REST /api/singudaejo(api_server.js sgdMarkdown) 의 판정 규칙을 그대로 쓴다: 조 번호로 짝짓기 → 판정 보류(경계 불확실, judgeArticle) → 삭제·신설 → 본문(sgdFlat)·제목 일치 → 개정.
// 차이: ① rel_path 대신 doc_id ② hwpx 대신 JSON ③ 부칙 조문은 «부칙 제N조» 로 키를 분리(REST 는 본칙·부칙이 같은 키로 덮어써진다).
const sgdFlat = t => String(t || '').replace(/#{2,}/g, ' ').replace(/\s*\n+\s*/g, ' / ').replace(/[ \t]+/g, ' ').replace(/^\s*\/\s*|\s*\/\s*$/g, '').trim();
const artKey = r => (r.section === '부칙' ? '부칙 ' : '') + '제' + r.art_no + '조' + (r.art_sub ? '의' + r.art_sub : '');
const sha8 = t => crypto.createHash('sha1').update(t).digest('hex').slice(0, 8);
const CMP_ROWS = 3000, CMP_BODY = 20000, CMP_OUT = 60000;   // 문서당 조문 상한 · 조문당 읽는 본문 상한 · 응답 문자 상한
const CMP_SQL = `SELECT a.section, a.art_no, a.art_sub, a.title, left(a.body, ${CMP_BODY}) AS body, a.n_chars
                   FROM articles a WHERE a.doc_id = $1 AND a.art_no IS NOT NULL ORDER BY a.section DESC NULLS LAST, a.art_no, COALESCE(a.art_sub, 0), a.seq LIMIT ${CMP_ROWS + 1}`;
const DOC_SQL = `SELECT d.doc_id, d.corpus, d.doc_title, d.doc_type, d.doc_date, d.n_articles, i.inst_name,
                        d.meta->>'edition_status' AS edition_status, COALESCE(d.meta->>'repealed','') = 'true' AS repealed,
                        COALESCE(d.meta->>'lineage_closed','') = 'true' AS lineage_closed,
                        COALESCE(NULLIF(d.meta->>'effective_from',''), CASE WHEN d.corpus='bylaws' AND d.doc_date ~ '^[0-9]{8}$' THEN d.doc_date END) AS effective_from,
                        NULLIF(d.meta->>'effective_to','') AS effective_to, d.meta->>'edition_basis' AS edition_basis
                   FROM documents d LEFT JOIN institutions i USING (inst_code) WHERE d.doc_id = $1`;

// 두 본문에서 공통 앞·뒤를 걷어낸 «달라진 구간» (간단 요약). 둘 다 짧게 자른다.
function changeSpan(x, y, max) {
  let p = 0; const n = Math.min(x.length, y.length);
  while (p < n && x[p] === y[p]) p++;
  let s = 0; while (s < n - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const cut = t => (t.length > max ? t.slice(0, max) + '…' : t);
  return { before: cut(x.slice(p, x.length - s)), after: cut(y.slice(p, y.length - s)), at: p };
}

function compareArticles(rowsA, rowsB, { includeBody, onlyChanged, spanMax, bodyMax }) {
  const A = new Map(), B = new Map();
  for (const r of rowsA) A.set(artKey(r), r);
  for (const r of rowsB) B.set(artKey(r), r);
  const num = k => parseInt(k.match(/\d+/)[0], 10);
  const keys = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => (x.startsWith('부칙') - y.startsWith('부칙')) || (num(x) - num(y)) || x.localeCompare(y));
  const sum = { keys: keys.length, amended: 0, added: 0, removed: 0, same: 0, unsure: 0 }, changes = [];
  for (const k of keys) {
    const a = A.get(k), b = B.get(k), ja = a ? judgeArticle(a.body) : null, jb = b ? judgeArticle(b.body) : null;
    const fa = a ? sgdFlat(a.body) : '', fb = b ? sgdFlat(b.body) : '';
    let status;
    if ((ja && !ja.boundaryOk) || (jb && !jb.boundaryOk)) { status = 'unsure'; sum.unsure++; }
    else if (a && !b) { status = 'removed'; sum.removed++; }
    else if (!a && b) { status = 'added'; sum.added++; }
    else if (fa === fb && (a.title || '') === (b.title || '')) { status = 'same'; sum.same++; }
    else { status = 'amended'; sum.amended++; }
    if (status === 'same' && onlyChanged) continue;
    const e = { art_ref: k, status };
    if (a) { e.title_a = a.title || ''; e.chars_a = fa.length; }
    if (b) { e.title_b = b.title || ''; e.chars_b = fb.length; }
    if (status === 'amended') {
      e.hash_a = sha8(fa); e.hash_b = sha8(fb); e.delta_chars = fb.length - fa.length;
      if (e.title_a !== e.title_b) e.title_changed = true;
      e.span = changeSpan(fa, fb, spanMax);
    }
    if (status === 'unsure') e.reason = '조문 경계 불확실(변환 품질) — 개정 판정 보류';
    if (includeBody && status !== 'same') {
      const cut = t => (t.length > bodyMax ? { body: t.slice(0, bodyMax), truncated: true } : { body: t });
      if (a) { const c = cut(fa); e.body_a = c.body; if (c.truncated) e.body_a_truncated = true; }
      if (b) { const c = cut(fb); e.body_b = c.body; if (c.truncated) e.body_b_truncated = true; }
    }
    changes.push(e);
  }
  return { summary: sum, changes };
}

function makeCompare(ctx) {
  return async function toolCompare(a, cctx) {
    const lim = heavyLimited('compare', cctx); if (lim) throw limitErr('compare_documents', lim);
    const ia = String(a.a || '').slice(0, 500), ib = String(a.b || '').slice(0, 500);
    if (!ia || !ib) throw new Error('a, b(doc_id 두 개)가 필요합니다');
    if (ia === ib) throw new Error('a 와 b 가 같은 문서입니다');
    const includeBody = a.include_body === true, onlyChanged = a.only_changed !== false;
    const maxChanges = intIn(a.max_changes, 30, 1, 100), offset = intIn(a.offset, 0, 0, 1e6);
    const bodyMax = includeBody ? intIn(a.body_chars, 300, 50, 700) : 0;
    return ctx.withPooled([TIMEOUT], async c => {
      const da = await ctx.resolveDocId(c, ia), db = await ctx.resolveDocId(c, ib);
      const [ma, mb] = [(await c.query(DOC_SQL, [da])).rows[0], (await c.query(DOC_SQL, [db])).rows[0]];
      if (!ma) throw new Error('문서 없음: ' + ia + NOT_FOUND_TAIL);
      if (!mb) throw new Error('문서 없음: ' + ib + NOT_FOUND_TAIL);
      const ra = (await c.query(CMP_SQL, [da])).rows, rb = (await c.query(CMP_SQL, [db])).rows;
      if (!ra.length && !rb.length) throw new Error('두 문서 모두 번호 있는 조문을 찾지 못했습니다(적재 전이거나 별표 위주 문서).');
      const notes = [];
      for (const [r, m] of [[ra, ma], [rb, mb]]) if (r.length > CMP_ROWS) { r.length = CMP_ROWS; notes.push(`${m.doc_id}: 조문이 ${CMP_ROWS}개를 넘어 앞부분만 비교했다.`); }
      const { summary, changes } = compareArticles(ra, rb, { includeBody, onlyChanged, spanMax: 150, bodyMax });
      const ea = S.annotateEdition([ma])[0], eb = S.annotateEdition([mb])[0];
      const meta = m => ({ doc_id: m.doc_id, corpus: m.corpus, doc_title: m.doc_title, inst_name: m.inst_name, doc_type: m.doc_type, doc_date: m.doc_date, n_articles: m.n_articles,
        edition_state: m.edition_state, ...(m.edition_warning ? { edition_warning: m.edition_warning } : {}), effective_from: m.effective_from, effective_to: m.effective_to });
      // 응답 크기 상한: 페이지(offset·max_changes) 안에서도 문자 수 상한을 넘으면 거기서 자른다.
      let page = changes.slice(offset, offset + maxChanges), size = 0, cutAt = page.length;
      for (let i = 0; i < page.length; i++) { size += JSON.stringify(page[i]).length; if (size > CMP_OUT) { cutAt = Math.max(1, i); break; } }
      const truncatedBySize = cutAt < page.length; page = page.slice(0, cutAt);
      const end = offset + page.length;
      if (ma.inst_name !== mb.inst_name) notes.push('서로 다른 기관의 문서를 비교했다(기관 간 비교).');
      if (ma.corpus === 'ca' || mb.corpus === 'ca') notes.push('단체협약의 판본·현행 판정은 폴더 연도 근사(edition_basis=folder_year_approx)이니 단정하지 말 것.');
      notes.push('조 번호를 키로 짝지은 기계 비교이며 자구 수정과 실질 개정을 구분하지 않는다. 별표·번호 없는 조문은 제외. hash 는 정규화한 본문의 SHA-1 앞 8자.');
      return { a: meta(ea), b: meta(eb), summary, ...(onlyChanged ? { listed: 'changed_only' } : { listed: 'all' }), total_changes: changes.length, shown: page.length,
        ...(end < changes.length ? { next_offset: end } : {}), ...(truncatedBySize ? { truncated_by_size: true } : {}), changes: page, notes };
    }).catch(e => { throw wrapTmo('문서 비교', e, '두 문서의 조문 수가 많으면 시간이 걸립니다. 잠시 후 다시 시도하세요.'); });
  };
}

// ═══ get_series ═════════════════════════════════════════════════════════════
const SER_MAX = 400, SER_FETCH = 5000;   // MCPfix: 응답 크기 때문에 표시는 400 유지하되 «최신 400건» 을 남기고 omitted_oldest 로 알린다(종전은 오래된 쪽 400건만 남기고 최신을 잘랐음). 정렬은 JS 에서 한다(DB 정렬은 submitted_at 이 없는 행을 어긋나게 둠)
const DISC_RE = /^\d{4}(Q[1-4])?$/, DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
async function pickInst(c, inst) {
  const q = String(resolveInst(inst) || '').trim().slice(0, 100);   // 약칭(창진원 등) → 정식명(search_corpus 와 같은 표)
  if (!q) throw new Error('inst(기관명)가 필요합니다');
  const names = (await c.query(`SELECT DISTINCT inst_name FROM institutions WHERE inst_name ILIKE '%' || $1 || '%' ORDER BY inst_name LIMIT 11`, [likeEsc(q)])).rows.map(r => r.inst_name);
  if (names.includes(q)) return q;
  if (names.length === 1) return names[0];
  if (!names.length) throw new Error('기관을 찾지 못했습니다: ' + q + catHint('institutions', '로 정확한 이름 확인'));
  throw new Error('기관명이 모호합니다. 정확한 이름으로 다시 호출하세요: ' + names.slice(0, 10).join(', ') + (names.length > 10 ? ' …' : ''));
}
const inRange = (key, from, to) => (!from || key.slice(0, from.length) >= from) && (!to || key.slice(0, to.length) <= to);

function makeSeries(ctx) {
  return async function toolSeries(a) {
    const corpus = a.corpus == null || a.corpus === '' ? 'disclosure' : String(a.corpus);
    if (!['legal', 'bylaws', 'ca', 'disclosure'].includes(corpus)) throw new Error('corpus 는 disclosure|bylaws|ca|legal 중 하나여야 합니다');
    const item = String(a.item || '').trim().slice(0, 200);
    if (!item) throw new Error('item 이 필요합니다(공시는 항목명, 법령·내규·단체협약은 문서명 일부)');
    const from = a.from == null ? '' : String(a.from).trim(), to = a.to == null ? '' : String(a.to).trim();
    const re = corpus === 'disclosure' ? DISC_RE : DATE_RE;
    for (const [n, v] of [['from', from], ['to', to]]) if (v && !re.test(v)) throw new Error(`${n} 형식 오류: ` + (corpus === 'disclosure' ? '"2025" 또는 "2025Q3"' : '"2025" 또는 "2025-07-01"'));
    if (from && to && from > to) throw new Error(`from(${from}) 이 to(${to}) 보다 늦습니다 — 기간이 역순입니다. 순서를 바꿔 다시 호출하세요.`);
    const base = { corpus, ...(from ? { from } : {}), ...(to ? { to } : {}),
      notes: ['시점·판본 목록만 제공하며 수치는 추출·집계하지 않는다. 값은 해당 doc_id 를 get_document/get_article 또는 search_corpus(body=true) 로 읽을 것.'] };

    if (corpus === 'disclosure') {
      if (IF.mode() === 'off') throw new Error((a.corpus == null || a.corpus === '' ? 'corpus 를 지정하세요. ' : '') + '공시 계열 조회는 서버 설정 ITEM_FILTER=explicit(또는 auto)가 필요합니다(관리자 설정 — 현재 꺼져 있음). 법령·내규·단체협약은 corpus=legal|bylaws|ca 로 가능합니다.');
      const r = IF.resolveExplicit(item);
      if (!r.codes.length) throw new Error('공시 항목을 찾지 못했습니다' + (r.ambiguous.length ? ': 모호함 ' + JSON.stringify(r.ambiguous[0].candidates.map(x => x.name)) : r.suggestions.length ? ': 혹시 ' + r.suggestions.join(', ') : '') + (process.env.MCP_LIST_CATALOG === 'on' ? ' — list_catalog kind=items 로 항목명을 확인하세요.' : ''));
      const cats = IF.categoriesFor(r.codes);
      return ctx.withPooled([TIMEOUT], async c => {
        const inst = await pickInst(c, a.inst);
        const rows = (await c.query(
          `SELECT d.doc_id, d.doc_title, d.category, d.doc_date, d.meta->>'period_label' AS period_label, d.meta->>'submitted_at' AS submitted_at, d.meta->>'dup_group' AS dup_group, d.body_md5, d.meta->>'doc_date_src' AS date_src
             FROM documents d WHERE d.corpus = 'disclosure' AND d.category = ANY($1::text[]) AND d.inst_code IN (SELECT inst_code FROM institutions WHERE inst_name = $2)
            LIMIT ${SER_FETCH + 1}`, [cats, inst])).rows;
        const srcTrunc = rows.length > SER_FETCH; if (srcTrunc) rows.length = SER_FETCH;
        const HV2 = process.env.SERIES_HASH_V2 === 'on';   // c6: 본문 해시(body_md5) 대조·folder_year 연말 정렬·날짜 근거 표시
        const dkey = x => { const raw = String(x.submitted_at || x.doc_date || '').replace(/\D/g, ''); if (HV2 && !x.submitted_at && raw.length === 4) return raw + '1231';   // folder_year(연도만) 행이 연초(YYYY0000)로 정렬돼 같은 해 제출일 있는 행보다 앞서던 어긋남
          const d = raw.padEnd(8, '0').slice(0, 8); return d === '00000000' ? '99999999' : d; };   // 제출일(없으면 doc_date) 숫자 8자리 — 날짜가 전혀 없는 행은 맨 뒤(date_missing)
        const isoD = v => { const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(v || '')); return m ? `${m[1]}-${m[2]}-${m[3]}` : v; };   // doc_date 가 «20250724» 형식이면 submitted_at 과 같은 ISO 로(문자열 비교 어긋남 방지)
        rows.sort((x, y) => dkey(x) < dkey(y) ? -1 : dkey(x) > dkey(y) ? 1 : String(x.period_label || '') < String(y.period_label || '') ? -1 : String(x.period_label || '') > String(y.period_label || '') ? 1 : x.doc_id < y.doc_id ? -1 : 1);
        const noDate = rows.filter(x => !x.submitted_at).length, hasDup = rows.some(x => x.dup_group);
        const prev = new Map(), series = [], grp = new Map();   // grp: category → {k: 현재 제출일 키, cur: 현재 일자 행들의 해시, prev: 직전 일자 행들의 해시}
        for (const x of rows) {
          const adj = x.period_label ? S.adjPeriodLabel(x.period_label, x.submitted_at) : null;
          const key = adj || (x.submitted_at || x.doc_date || '').replace(/\D/g, '');
          let same = !!x.dup_group && prev.get(x.category) === x.dup_group; prev.set(x.category, x.dup_group);
          if (HV2) {   // 직전 «제출일 묶음» 의 행과 같은 본문(dup_group 또는 body_md5 일치)이면 재게시 — 첨부 여러 행이 같은 날 올라오는 항목도 회차 단위로 비교
            const hs = [x.dup_group, x.body_md5].filter(Boolean), dk = dkey(x); let g = grp.get(x.category);
            if (!g) grp.set(x.category, g = { k: dk, cur: new Set(), prev: new Set() }); else if (g.k !== dk) { g.prev = g.cur; g.cur = new Set(); g.k = dk; }
            same = same || hs.some(h => g.prev.has(h)); hs.forEach(h => g.cur.add(h));   // 기존 판정(직전 행과 dup_group 동일)도 유지 — 합집합
          }
          if (!inRange(DISC_RE.test(key) ? key : key.slice(0, 4), from, to)) continue;
          const al = S.SERIES_ALLOW[x.category];
          const ty = IF.titleYear(x.doc_title);   // G2-B: 제목의 20XX년(있을 때만)
          series.push({ doc_id: x.doc_id, category: x.category, ...(ty ? { target_year: ty } : {}), ...(x.period_label ? { period_label: x.period_label } : {}), ...(adj ? { period_label_adj: adj } : {}),
            ...(x.submitted_at ? { submitted_at: x.submitted_at } : x.doc_date ? { doc_date: isoD(x.doc_date), ...(HV2 ? { date_basis: x.date_src === 'folder_year' ? 'folder_year(연도만·연말로 정렬)' : x.date_src === 'folder_mmdd' ? 'folder_mmdd(폴더명 날짜 — 제출일과 다를 수 있음)' : 'doc_date' } : {}) } : { date_missing: true }), ...(same ? { same_content_as_prev: true } : {}), ...(al ? { cadence: al.k === 'Q' ? 'quarterly' : 'yearly' } : {}) });
        }
        const over = series.length > SER_MAX, omitted = over ? series.length - SER_MAX : 0; if (over) series.splice(0, omitted);   // 넘치면 «오래된 쪽» 을 덜어낸다(최신 회차 우선) — from/to 로 구간을 좁히면 다 볼 수 있다
        const notes = [...base.notes, 'same_content_as_prev=true 는 직전 회차와 본문이 같은 재게시(dup_group 동일' + (HV2 ? ' 또는 본문 해시 body_md5 일치 — 직전 «제출일 묶음» 의 어느 행과 같으면 표시' : '') + '). period_label_adj 는 공시 회차 라벨의 «보고 대상 분기» 보정값(1~3월 공시 4분기 보고서는 전년 4분기). 정렬은 제출일(submitted_at, 없으면 doc_date) 오름차순.'];
        if (!hasDup) notes.push('이 항목은 dup_group 메타가 없어 same_content_as_prev 가 표시되지 않는다 — 표식이 없다고 내용이 다르다는 뜻이 아니다(첨부 파일 단위 행은 회차마다 같은 파일이 반복될 수 있음).');
        if (noDate) notes.push(`submitted_at 이 없는 행 ${noDate}건은 doc_date(ISO 로 정규화해 표시)로 정렬했고, 날짜가 전혀 없는 행(date_missing=true)은 맨 뒤에 둔다 — 그 행들의 시점은 period_label 로만 가늠할 것.`);
        return { inst, item: r.matched.map(m => m.as), ...base, total: series.length, ...(over ? { truncated: true, cap: SER_MAX, omitted_oldest: omitted } : {}), ...(srcTrunc ? { source_truncated: true, source_cap: SER_FETCH } : {}), series,
          notes: over || srcTrunc ? [...notes, `행이 많아 ${over ? '오래된 ' + omitted + '건을 뺐다' : ''}${srcTrunc ? ' 원천 ' + SER_FETCH + '건 상한에서 잘렸다' : ''} — from·to 로 구간을 나눠 조회하라(전체 이력이 아님).`] : notes };
      }).catch(e => { throw wrapTmo('시계열', e, 'inst·from·to 로 범위를 좁히거나 잠시 후 다시 시도하세요.'); });
    }
    // legal·bylaws·ca: item = 문서명 일부, 판본 연혁 목록
    if (item.length < 2) throw new Error('문서명(item)은 2자 이상이어야 합니다');
    return ctx.withPooled([TIMEOUT], async c => {
      const inst = a.inst ? await pickInst(c, a.inst) : null;
      if (!inst && corpus !== 'legal') throw new Error('bylaws·ca 는 inst(기관명)가 필요합니다');
      const rows = (await c.query(
        `SELECT d.doc_id, d.corpus, d.doc_title, d.alias, d.doc_type, d.doc_date, i.inst_name,
                d.meta->>'edition_group' AS edition_group, d.meta->>'edition_status' AS edition_status, d.meta->>'edition_basis' AS edition_basis,
                COALESCE(NULLIF(d.meta->>'effective_from',''), CASE WHEN d.corpus='bylaws' AND d.doc_date ~ '^[0-9]{8}$' THEN d.doc_date END) AS effective_from,
                NULLIF(d.meta->>'effective_to','') AS effective_to, COALESCE(d.meta->>'repealed','') = 'true' AS repealed,
                COALESCE(d.meta->>'lineage_closed','') = 'true' AS lineage_closed, NULLIF(d.meta->>'lineage_successor','') AS lineage_successor
           FROM documents d LEFT JOIN institutions i USING (inst_code)
          WHERE d.corpus = $1 AND (d.doc_title ILIKE '%' || $2 || '%' OR d.alias = $3) AND ($4::text IS NULL OR i.inst_name = $4)
          ORDER BY COALESCE(NULLIF(d.meta->>'effective_from',''), d.doc_date), d.doc_id LIMIT ${SER_MAX + 1}`, [corpus, likeEsc(item), item, inst])).rows;
      const trunc = rows.length > SER_MAX; if (trunc) rows.length = SER_MAX;
      const digits = x => String(x || '').replace(/\D/g, '');
      const toB = v => v.replace(/\D/g, '');
      const series = S.annotateEdition(rows).filter(x => inRange(digits(x.effective_from || x.doc_date), toB(from), toB(to))).map(x => ({
        doc_id: x.doc_id, doc_title: x.doc_title, ...(x.inst_name ? { inst_name: x.inst_name } : {}), doc_type: x.doc_type, doc_date: x.doc_date, effective_from: x.effective_from, effective_to: x.effective_to,
        edition_state: x.edition_state, ...(x.edition_warning ? { edition_warning: x.edition_warning } : {}), ...(x.edition_group ? { edition_group: x.edition_group } : {}) }));
      const notes = [...base.notes, '여러 규정이 부분일치로 함께 잡힐 수 있다 — 같은 규정의 판본은 edition_group 이 같다.'];
      if (corpus === 'ca') notes.push('단체협약의 현행·연혁 판정은 폴더 연도 근사(edition_basis=folder_year_approx)이니 단정하지 말 것.');
      return { ...(inst ? { inst } : {}), item, ...base, total: series.length, ...(trunc ? { truncated: true, cap: SER_MAX } : {}), series, notes };
    }).catch(e => { throw wrapTmo('판본 연혁', e, 'inst·item(문서명을 더 구체적으로)·from·to 로 범위를 좁혀 다시 시도하세요.'); });
  };
}

// ═══ get_related ═════════════════════════════════════════════════════════════
// 조문 «본문 문자열» 에서 인용 패턴만 뽑는다(구조화된 참조 DB 는 없다). 정규식 추출 + 법령명 매칭 — 근사이며 전수가 아니다.
const ART_RE = '제\\s*(\\d+)\\s*조(?:\\s*의\\s*(\\d+))?';
const NOT_LAW = /^(?:이|그|동|본|같은|해당|관계|다른|타|각종|구|상위|하위|모)?(?:법률|법|시행령|시행규칙|영|령|규정|규칙|세칙|지침|요령)$/;
const MASTER = new RegExp([
  '[「『｢]([^」』｣]{2,60})[」』｣](?:\\s*(시행령|시행규칙))?(?:\\s*' + ART_RE + ')?',                           // 1 name · 2 suffix · 3 no · 4 sub
  '(?<![가-힣])(?:같은|동)\\s*법(?:\\s*(시행령|시행규칙))?\\s*' + ART_RE,                                              // 5 suffix · 6 no · 7 sub
  '(?<![가-힣])이\\s*(?:법|영|규칙|규정|지침|세칙|협약|협정|조례)\\s*' + ART_RE,                                       // 8 no · 9 sub
  '((?:[가-힣·]+\\s+){0,6}[가-힣·]*에\\s*관한\\s*(?:[가-힣]+\\s+)?(?:법률|특별법|법))(?:\\s*(시행령|시행규칙))?\\s*' + ART_RE,   // 10 긴 이름(앞 단어는 후보로 줄여 본다) · 11 suffix · 12 no · 13 sub
  '([가-힣][가-힣·]{0,28}?(?:법률|법))(?:\\s*(시행령|시행규칙))?\\s*' + ART_RE,                            // 14 name · 15 suffix · 16 no · 17 sub
  '([가-힣][가-힣·]{1,28}?(?:규정|규칙|세칙|지침|요령))\\s*' + ART_RE,                                     // 18 name(내규·규칙명) · 19 no · 20 sub
  '(?<![가-힣])(?:법|영|시행령|시행규칙)\\s*' + ART_RE,                                                    // 21 no · 22 sub   (법 제N조: 어느 법인지 문맥 필요 → ambiguous)
  '(?<![가-힣「『｢])' + ART_RE,                                                                             // 23 no · 24 sub   (같은 문서 내 인용)
].join('|'), 'g');
const artRef = (no, sub) => '제' + no + '조' + (sub ? '의' + sub : '');
const CONNECT = /^(?:\s*제\s*\d+\s*[항호](?:\s*의\s*\d+)?)*\s*(?:(?:,|·|및|또는|내지|부터|까지|와|과)\s*)+$/;   // «제5조 및 제7조» «제5조부터 제7조까지»: 뒤 조문은 앞 인용과 같은 대상

const SELF_RULE = { resolved_by: 'self_or_parent_rule', confidence: 'low' };   // 내규의 «규정 제N조» 약칭 — 자기 문서일 수도 상위 규정일 수도 있어 자기 문서로 두되 근거를 표시
const selfRule = (src, idx, ctx) => (ctx && ctx.corpus === 'bylaws' && /(?:^|[^가-힣])(규정|세칙|지침|기준|요령|규칙)\s*$/.test(src.slice(Math.max(0, idx - 6), idx)) ? SELF_RULE : {});
/** 시행령·시행규칙 조문의 «법 제N조»(모법)·«영 제N조»(시행규칙 안에서 모법 시행령) 해석. 제목이 «○○법 시행령/시행규칙» 일 때만. 확정 인용과 구분하려고 resolved_by·confidence 를 붙인다. */
function interpretAbbr(r, title) {
  if (r.kind !== 'ambiguous') return r;
  const t = String(title).replace(/\s*[(（].*$/, '').trim(), m = /^(.*\S)\s*(시행령|시행규칙)$/.exec(t);
  if (!m) return r;
  const stem = m[1], isRule = m[2] === '시행규칙', { abbr, ...rest } = r;
  if (/법(률)?$/.test(abbr || '')) return { ...rest, kind: 'law', law: stem, resolved_by: 'parent_law', confidence: 'medium' };
  if (isRule && /^(영|령|시행령)$/.test(abbr || '')) return { ...rest, kind: 'law', law: stem, suffix: '시행령', resolved_by: 'parent_law', confidence: 'medium' };
  return r;
}

/** 반환 [{kind:'same_doc'|'law'|'ambiguous', law?, alts?, suffix?, art_no?, art_sub?, text}] — 순서 유지·중복 제거. self={art_no,art_sub} 면 자기 자신 인용은 뺀다.
 *  law = 법령명(긴 이름은 앞 단어를 줄인 후보 alts 도 함께 — DB 제목과 맞는 가장 긴 것을 고른다). ambiguous = «법 제N조»·«같은 법»(앞 법령 없음) 등 대상 불명. */
function extractRefs(text, self, ctx) {   // ctx={title,corpus}: 대상 문서 제목으로 «법 제N조» 약칭을 해석(없으면 해석 안 함 — 종전 동작)
  let out = [], seen = new Set(); let lastLaw = null, prev = null;
  const isSelf = (no, sub) => self && String(self.art_no) === String(no) && String(self.art_sub || '') === String(sub || '');
  const add = (r, end) => {
    prev = { end, r };
    if (r.kind === 'same_doc' && isSelf(r.art_no, r.art_sub)) return;
    const k = [r.kind, r.law || '', r.suffix || '', r.art_no || '', r.art_sub || ''].join('|'); if (seen.has(k)) return; seen.add(k); out.push(r);
  };
  const art = (no, sub) => ({ art_no: +no, ...(sub ? { art_sub: +sub } : {}) });
  MASTER.lastIndex = 0; let m;
  const src = String(text || '').slice(0, 30000);
  while ((m = MASTER.exec(src))) {
    const end = m.index + m[0].length, t = m[0].replace(/\s+/g, ' ').slice(0, 80);
    if (m[1] != null) { lastLaw = m[1].replace(/\s+/g, ' ').trim(); add({ kind: 'law', law: lastLaw, ...(m[2] ? { suffix: m[2] } : {}), ...(m[3] ? art(m[3], m[4]) : {}), text: t }, end); }
    else if (m[6] != null) add(lastLaw ? { kind: 'law', law: lastLaw, ...(m[5] ? { suffix: m[5] } : {}), ...art(m[6], m[7]), text: t } : { kind: 'ambiguous', abbr: m[5] || '법', ...art(m[6], m[7]), text: t }, end);
    else if (m[8] != null) add({ kind: 'same_doc', ...art(m[8], m[9]), text: t }, end);
    else if (m[10] != null) {
      const w = m[10].replace(/\s+/g, ' ').trim().split(' '); while (w.length > 1 && /^(및|또는|그리고|와|과|등|각|이|그|의)$/.test(w[0])) w.shift();
      const alts = w.map((_, i) => w.slice(i).join(' ')).filter(x => x.length >= 6);
      lastLaw = alts[0] || w.join(' ');
      add({ kind: 'law', law: lastLaw, ...(alts.length > 1 ? { alts: alts.slice(1) } : {}), ...(m[11] ? { suffix: m[11] } : {}), ...art(m[12], m[13]), text: t }, end);
    }
    else if (m[14] != null) {
      if (NOT_LAW.test(m[14])) add({ kind: 'ambiguous', abbr: (/(법률|법|시행령|시행규칙|영|령)$/.exec(m[14]) || [, ''])[1], ...art(m[16], m[17]), text: t }, end);
      else { lastLaw = m[14]; add({ kind: 'law', law: m[14], ...(m[15] ? { suffix: m[15] } : {}), ...art(m[16], m[17]), text: t }, end); }
    }
    else if (m[18] != null) {
      if (m[18] === '시행규칙') add({ kind: 'ambiguous', abbr: '시행규칙', ...art(m[19], m[20]), text: t }, end);
      else if (NOT_LAW.test(m[18])) add({ kind: 'same_doc', ...art(m[19], m[20]), text: t, ...(ctx && ctx.corpus === 'bylaws' ? SELF_RULE : {}) }, end);   // «본규정 제N조» 류는 같은 문서
      else { lastLaw = m[18]; add({ kind: 'law', law: m[18], ...art(m[19], m[20]), text: t }, end); }
    }
    else if (m[21] != null) add({ kind: 'ambiguous', abbr: /^(시행규칙|시행령|법|영)/.exec(m[0])[1], ...art(m[21], m[22]), text: t }, end);
    else if (m[23] != null) {
      if (/^\s*에서\s*이동/.test(src.slice(end, end + 8))) { prev = { end, r: prev && prev.r }; continue; }   // «[제7조에서 이동]» 같은 편집 표지는 인용이 아니다
      const between = src.slice(prev ? prev.end : 0, m.index).replace(/^\s*[(（][^)）]{0,80}[)）]/, '');   // «「법」(이하 '법'이라 한다) 제N조» 정의 괄호는 건너뛴다
      const inh = prev && prev.r && (CONNECT.test(between) || (prev.r.kind === 'law' && !prev.r.art_no && between.trim() === '')) ? prev.r : null;   // 앞 인용에 «및·부터» 로 이어졌거나 정의 괄호 뒤 조문은 같은 대상
      if (inh && inh.kind !== 'same_doc') add({ kind: inh.kind, ...(inh.law ? { law: inh.law } : {}), ...(inh.alts ? { alts: inh.alts } : {}), ...(inh.suffix ? { suffix: inh.suffix } : {}), ...art(m[23], m[24]), text: t }, end);
      else add({ kind: 'same_doc', ...art(m[23], m[24]), text: t, ...selfRule(src, m.index, ctx) }, end);
    }
  }
  if (ctx && ctx.corpus === 'legal' && ctx.title) { const seen2 = new Set(); out = out.map(r => interpretAbbr(r, ctx.title)).filter(r => { const k = [r.kind, r.law || '', r.suffix || '', r.art_no || '', r.art_sub || ''].join('|'); if (seen2.has(k)) return false; seen2.add(k); return true; }); }
  const withArt = new Set(out.filter(r => r.kind === 'law' && r.art_no).map(r => r.law + '|' + (r.suffix || '')));   // 같은 법령의 조문 인용이 있으면 법령만 언급한 중복 항목은 뺀다
  return out.filter(r => !(r.kind === 'law' && !r.art_no && withArt.has(r.law + '|' + (r.suffix || ''))));
}

const stripTitle = t => String(t || '').replace(/\s*[(（].*$/, '').replace(/\s+/g, '');
const EDRANK = r => (r.repealed ? 3 : r.es === 'superseded' ? 2 : r.es === 'scheduled' ? 1 : 0);
const REL_TTL = 600000, relCache = new Map();

function makeRelated(ctx) {
  return async function toolRelated(a, cctx) {
    const docIn = String(a.doc_id || '').slice(0, 500), artNo = parseInt(a.art_no, 10);
    if (!docIn || !Number.isFinite(artNo)) throw new Error('doc_id와 art_no(정수)가 필요합니다');
    const dir = a.direction == null ? 'outgoing' : String(a.direction);
    const INC = process.env.MCP_RELATED_INCOMING === 'on';
    if (!['outgoing', 'incoming', 'both'].includes(dir)) throw new Error('direction 은 ' + (INC ? 'outgoing|incoming|both' : 'outgoing') + ' 중 하나여야 합니다');
    if (dir !== 'outgoing' && !INC) throw new Error('incoming 은 현재 비활성입니다(서버 설정 MCP_RELATED_INCOMING=off). direction="outgoing" 으로 호출하세요.');
    const artSub = a.art_sub == null ? null : parseInt(a.art_sub, 10);
    if (a.art_sub != null && !Number.isFinite(artSub)) throw new Error('art_sub 는 정수여야 합니다');
    const limit = intIn(a.limit, 20, 1, 50);
    const allowed = String(process.env.MCP_RELATED_CORPORA || 'legal,bylaws').split(',').map(x => x.trim()).filter(Boolean);
    const scopeCorpus = a.corpus == null || a.corpus === '' ? null : String(a.corpus), instQ = a.inst == null ? '' : String(a.inst).trim().slice(0, 100);
    if (scopeCorpus && (!['legal', 'bylaws'].includes(scopeCorpus) || !allowed.includes(scopeCorpus))) throw new Error('corpus 는 ' + allowed.filter(x => ['legal', 'bylaws'].includes(x)).join('|') + ' 중 하나여야 합니다');
    if (dir !== 'outgoing' && scopeCorpus === 'bylaws' && !instQ) throw new Error('범위를 지정하세요: corpus=bylaws 의 피인용 조회는 inst(기관명)를 함께 지정해야 합니다(전 기관 내규 전체 검색은 5초 안에 끝나지 않을 수 있습니다). 법령끼리는 corpus=legal.');
    const incMs = intIn(process.env.MCP_RELATED_INCOMING_TIMEOUT_MS, 5000, 1000, 20000);
    const lim = heavyLimited('related', cctx); if (lim) throw limitErr('get_related', lim);
    const ck = [docIn, artNo, artSub, dir, limit, allowed.join(), scopeCorpus, instQ, incMs].join('|'), hit = relCache.get(ck);
    if (hit && Date.now() - hit.t < REL_TTL) return hit.out;
    const out = await ctx.withPooled([TIMEOUT], async c => {
      const docId = await ctx.resolveDocId(c, docIn);
      const meta = (await c.query(`SELECT d.corpus, d.doc_title, d.alias, d.inst_code FROM documents d WHERE d.doc_id = $1`, [docId])).rows[0];
      if (!meta) throw new Error('문서 없음: ' + docIn + NOT_FOUND_TAIL);
      if (!allowed.includes(meta.corpus)) throw new Error(JSON.stringify({ error: 'corpus_not_supported', supported: allowed, hint: '단체협약·공시 문서는 search_corpus 로 인용 문구를 검색하세요.' }));
      const arts = (await c.query(`SELECT seq, section, art_no, art_sub, title, left(body, 20000) AS body FROM articles
                                    WHERE doc_id = $1 AND art_no = $2 AND ($3::int IS NULL OR art_sub = $3) ORDER BY seq LIMIT 5`, [docId, artNo, artSub])).rows;
      if (!arts.length) throw new Error(`조문 없음: ${docId} ${artRef(artNo, artSub)}` + NOT_FOUND_TAIL);
      const res = { doc_id: docId, art_ref: artRef(artNo, artSub), approximate: true, scope: allowed,
        notes: ['근사 결과다: 조문 본문의 인용 문자열을 규칙으로 추출·매칭한 것이며 전수·정확을 보장하지 않는다(누락·오탐 가능). 법령명 없는 «법 제N조»·«영 제N조» 는 unresolved 로 남긴다.'] };
      if (meta.corpus === 'ca' || meta.corpus === 'disclosure') res.notes.push('단체협약·공시 본문은 띄어쓰기·표기 편차가 커 인용 추출 정확도가 낮다(누락·오탐이 더 많다).');
      if (dir !== 'incoming') await outgoing(c, res, meta, arts, { artNo, artSub }, limit);
      if (dir !== 'outgoing') {
        try { await incoming(c, res, meta, docId, { artNo, artSub }, limit, allowed, { corpus: scopeCorpus, inst: instQ, ms: incMs }); }
        catch (e) {
          if (!isTmo(e)) throw e;
          const msg = tmoMsg('피인용(incoming)', 'corpus(legal|bylaws)·inst(기관명)·limit 으로 범위를 좁히세요.' + (dir === 'both' ? ' outgoing 결과는 함께 돌려줍니다.' : ''), Math.round(incMs / 1000));
          if (dir === 'incoming') throw new Error(msg);
          res.incoming = null; res.incoming_error = 'timeout'; res.notes.push(msg);   // 트랜잭션은 중단됐지만 outgoing 결과는 이미 메모리에 있다
        }
      }
      return res;
    }).catch(e => { throw wrapTmo('참조', e); });
    if (relCache.size > 500) relCache.clear();
    relCache.set(ck, { t: Date.now(), out });
    return out;
  };
}

async function outgoing(c, res, meta, arts, self, limit) {
  const refs = extractRefs(arts.map(x => x.body).join('\n'), self, { title: meta.doc_title, corpus: meta.corpus });
  const laws = refs.filter(r => r.kind === 'law'), unresolved = refs.filter(r => r.kind === 'ambiguous').map(r => r.text);
  const names = [...new Set(laws.flatMap(r => [r.law, ...(r.alts || [])]))].slice(0, 60);
  const found = new Map();   // 정규화 법령명(+시행령) → 후보 문서들
  if (names.length) {
    const cand = (await c.query(
      `SELECT d.doc_id, d.corpus, d.doc_title, d.alias, d.meta->>'edition_status' AS es, COALESCE(d.meta->>'repealed','') = 'true' AS repealed,
              COALESCE(NULLIF(d.meta->>'effective_from',''), d.doc_date) AS ef
         FROM documents d WHERE (d.corpus = 'legal' OR (d.corpus = 'bylaws' AND d.inst_code = $3))
          AND (d.doc_title LIKE ANY($1::text[]) OR d.alias = ANY($2::text[])) LIMIT 200`,
      [names.map(n => likeEsc(n) + '%'), names, meta.inst_code || ''])).rows;
    for (const d of cand) for (const k of new Set([stripTitle(d.doc_title), stripTitle(d.alias)])) if (k) (found.get(k) || found.set(k, []).get(k)).push(d);
  }
  const pick1 = (name, suffix) => (found.get(name.replace(/\s+/g, '') + (suffix || '')) || []).slice().sort((x, y) => EDRANK(x) - EDRANK(y) || String(y.ef).localeCompare(String(x.ef)))[0] || null;
  const pick = (r) => { for (const n of [r.law, ...(r.alts || [])]) { const d = pick1(n, r.suffix); if (d) return d; } return null; };
  const resolved = [], un = [...unresolved];
  const toCheck = [];
  for (const r of refs) {
    if (r.kind === 'same_doc') { resolved.push({ doc_id: res.doc_id, art_ref: artRef(r.art_no, r.art_sub), scope: 'same_doc', text: r.text, ...(r.resolved_by ? { resolved_by: r.resolved_by, confidence: r.confidence } : {}) }); continue; }
    if (r.kind !== 'law') continue;
    const d = pick(r);
    if (!d) { un.push(r.text); continue; }
    const e = { doc_id: d.doc_id, doc_title: d.doc_title, ...(r.art_no ? { art_ref: artRef(r.art_no, r.art_sub) } : {}), scope: 'law', text: r.text, ...(r.resolved_by ? { resolved_by: r.resolved_by, confidence: r.confidence } : {}) };
    if (d.repealed || (d.es && d.es !== 'current')) e.edition_note = '인용 대상 문서의 판본이 현행이 아닐 수 있음(' + (d.repealed ? 'repealed' : d.es) + ')';
    resolved.push(e); if (r.art_no) toCheck.push(e);
  }
  if (toCheck.length) {   // 인용한 조문이 실제로 있는지 확인(없으면 exists=false — 법령 개정으로 번호가 달라졌을 수 있음)
    const ex = (await c.query(`SELECT doc_id, art_no, art_sub FROM articles WHERE doc_id = ANY($1::text[]) AND art_no = ANY($2::int[])`,
      [[...new Set(toCheck.map(e => e.doc_id))], [...new Set(toCheck.map(e => +/\d+/.exec(e.art_ref)[0]))]])).rows;
    const have = new Set(ex.map(x => x.doc_id + '|' + artRef(x.art_no, x.art_sub)));
    for (const e of toCheck) e.exists = have.has(e.doc_id + '|' + e.art_ref);
  }
  res.outgoing = resolved.slice(0, limit);
  if (resolved.length > limit) res.outgoing_truncated = true;
  res.unresolved = [...new Set(un)].slice(0, limit);
}

async function incoming(c, res, meta, docId, self, limit, allowed, opt) {
  await c.query(`SET LOCAL statement_timeout=${opt.ms}`);   // incoming 만 별도 시간 제한(MCP_RELATED_INCOMING_TIMEOUT_MS, 기본 5000·상한 20000)
  const inc = [];
  // (1) 같은 문서 안: 다른 조문이 «제N조» 로 이 조문을 인용(앞에 「법령」·같은 법 이 붙은 것은 제외)
  const noRe = '제\\s*' + self.artNo + '\\s*조' + (self.artSub ? '\\s*의\\s*' + self.artSub + '(?![0-9])' : '(?!\\s*의\\s*[0-9])(?![0-9])');
  const same = (await c.query(`SELECT seq, art_no, art_sub, title, left(body, 20000) AS body FROM articles WHERE doc_id = $1 AND body ~ $2 AND NOT (art_no IS NOT DISTINCT FROM $3 AND art_sub IS NOT DISTINCT FROM $4) ORDER BY seq LIMIT 200`,
    [docId, noRe, self.artNo, self.artSub])).rows;
  for (const r of same) {
    const hit = extractRefs(r.body).some(x => x.kind === 'same_doc' && x.art_no === self.artNo && (x.art_sub || null) === (self.artSub || null));
    if (hit) inc.push({ doc_id: docId, art_ref: r.art_no ? artRef(r.art_no, r.art_sub) : '(번호 없음 seq ' + r.seq + ')', title: r.title, scope: 'same_doc' });
  }
  // (2) 다른 문서: 법령 문서만 — 「법령명」 제N조 / 법령명 제N조 문자열을 본문에서 찾는 근사(trigram LIKE 후보 → 규칙 재검증).
  //   범위(설계 근거): 후보 SQL 이 articles 전체(법령 약 31만·내규 약 194만 청크)를 훑으면 5초를 넘으므로 «한 코퍼스씩» 좁힌다.
  //   corpus 미지정 기본 = 법령 문서 대상이면 legal(청크가 적고 시행령·시행규칙이 모법을 인용), 내규 대상이면 bylaws + 같은 기관(inst_code)만(자기 기관 내규 안의 인용).
  //   내규가 법령을 인용하는 것(corpus=bylaws)은 inst 필수 — 기관 하나로 좁혀야 5초 안에 끝난다. prefilter = 법령명 LIKE + «N조» LIKE 두 조건(인덱스 친화) 후 정규식 재검증.
  let capped = false;
  if (meta.corpus === 'legal' && meta.doc_title) {
    const title = String(meta.doc_title).replace(/\s*[(（].*$/, '').trim(), want = new Set([title.replace(/\s+/g, ''), stripTitle(meta.alias)].filter(Boolean));
    const scope = opt.corpus || 'legal', CAND = 300;
    const rows = (await c.query(
      `SELECT a.doc_id, a.art_no, a.art_sub, a.title, d.corpus, d.doc_title, i.inst_name, left(a.body, 6000) AS body
         FROM articles a JOIN documents d USING (doc_id) LEFT JOIN institutions i USING (inst_code)
        WHERE a.body LIKE '%' || $1 || '%' AND a.body LIKE '%' || $5 || '%' AND a.body ~ $2 AND a.doc_id <> $3 AND d.corpus = $4
          AND ($6::text IS NULL OR i.inst_name ILIKE '%' || $6 || '%') LIMIT ${CAND}`, [likeEsc(title), noRe, docId, scope, self.artNo + '조', opt.inst ? likeEsc(opt.inst) : null])).rows;
    capped = rows.length >= CAND;
    const rank = r => (/시행규칙$/.test(stripTitle(r.doc_title)) ? 1 : /시행령$/.test(stripTitle(r.doc_title)) ? 0 : 2);
    const hits = [];
    for (const r of rows) {
      const ok = extractRefs(r.body, undefined, { title: r.doc_title, corpus: r.corpus }).some(x => x.kind === 'law' && !x.suffix && want.has(x.law.replace(/\s+/g, '')) && x.art_no === self.artNo && (x.art_sub || null) === (self.artSub || null));
      if (ok && allowed.includes(r.corpus)) hits.push({ doc_id: r.doc_id, doc_title: r.doc_title, ...(r.inst_name ? { inst_name: r.inst_name } : {}), corpus: r.corpus, art_ref: r.art_no ? artRef(r.art_no, r.art_sub) : null, title: r.title, scope: 'other_doc' });
    }
    hits.sort((x, y) => rank(x) - rank(y));
    inc.push(...hits);
    res.incoming_scope = { corpus: scope, ...(opt.inst ? { inst: opt.inst } : {}), timeout_ms: opt.ms };
    if (!opt.corpus) res.notes.push('기본 범위는 법령 문서(legal)다. 내규의 인용은 corpus="bylaws" 와 inst(기관명)를 지정해 조회하세요.');
  } else if (meta.corpus === 'bylaws' && meta.doc_title) {
    // 내규 조문의 피인용: 같은 기관(또는 inst 로 지정한 기관) 내규에서 «이 내규명 제N조» 로 인용한 것
    const title = String(meta.doc_title).replace(/\s*[(（].*$/, '').trim(), want = new Set([title.replace(/\s+/g, '')]);
    const CAND = 300;
    const rows = (await c.query(
      `SELECT a.doc_id, a.art_no, a.art_sub, a.title, d.corpus, d.doc_title, i.inst_name, left(a.body, 6000) AS body
         FROM articles a JOIN documents d USING (doc_id) LEFT JOIN institutions i USING (inst_code)
        WHERE a.body LIKE '%' || $1 || '%' AND a.body LIKE '%' || $4 || '%' AND a.body ~ $2 AND a.doc_id <> $3 AND d.corpus = 'bylaws'
          AND ($5::text IS NULL OR d.inst_code = $5) AND ($6::text IS NULL OR i.inst_name ILIKE '%' || $6 || '%') LIMIT ${CAND}`,
      [likeEsc(title), noRe, docId, self.artNo + '조', opt.inst ? null : meta.inst_code || null, opt.inst ? likeEsc(opt.inst) : null])).rows;
    capped = rows.length >= CAND;
    for (const r of rows) {
      const ok = extractRefs(r.body, undefined, { title: r.doc_title, corpus: r.corpus }).some(x => x.kind === 'law' && !x.suffix && want.has(x.law.replace(/\s+/g, '')) && x.art_no === self.artNo && (x.art_sub || null) === (self.artSub || null));
      if (ok) inc.push({ doc_id: r.doc_id, doc_title: r.doc_title, ...(r.inst_name ? { inst_name: r.inst_name } : {}), corpus: r.corpus, art_ref: r.art_no ? artRef(r.art_no, r.art_sub) : null, title: r.title, scope: 'other_doc' });
    }
    res.incoming_scope = { corpus: 'bylaws', ...(opt.inst ? { inst: opt.inst } : { inst_code: 'same_institution' }), timeout_ms: opt.ms };
    if (!opt.inst) res.notes.push('기본 범위는 같은 기관의 내규다. 다른 기관은 inst(기관명)로 지정하세요.');
  } else res.notes.push('다른 문서에서의 피인용(incoming)은 법령·내규 문서에만 제공한다. 이 문서는 같은 문서 안의 인용만 찾았다.');
  res.incoming = inc.slice(0, limit);
  if (inc.length > limit) res.incoming_truncated = true;
  if (capped) { res.candidates_capped = true; res.notes.push('다른 문서 후보가 조회 상한(300)에 닿아 일부만 검사했다 — incoming 은 하한이다.'); }
  res.notes.push('incoming 은 «법령명 + 제N조» 가 본문에 그대로 쓰인 경우만 잡는다(약칭·«같은 법»·시행령 위임 표현 누락).');
}

// ═══ 설치 ════════════════════════════════════════════════════════════════════
const D = {
  list_catalog: {
    name: 'list_catalog',
    description: 'search_corpus 의 필터에 넣을 값 목록(기관명·부처·문서유형·활용처·공시항목)과 문서 수를 조회. 정확한 값을 모를 때 search_corpus 보다 먼저 쓸 것(부분일치 q, 전수 검색 도구가 아님).',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: CAT_KINDS, description: '목록 종류: institutions(기관, ministry 포함)|ministries|doc_types|usecases|items(공시 항목명)' },
      corpus: { type: 'string', enum: CORPORA, description: '문서 수를 셀 코퍼스 (기본 all, items 는 무관)' },
      q: { type: 'string', description: '값에 포함된 글자로 거르기 (부분일치)' },
      limit: { type: 'integer', description: '1~200 (기본 50)' },
      offset: { type: 'integer', description: '이어서 가져오기 (응답의 next_offset)' } }, required: ['kind'] },
  },
  compare_documents: {
    name: 'compare_documents',
    description: '두 문서(doc_id a·b)의 조문을 조 번호로 짝지어 개정·신설·삭제·판정보류를 JSON 으로 비교(판본 간·기관 간). doc_id 는 search_corpus(구판은 all_versions=true)에서 먼저 얻을 것. 기계 비교라 자구 수정과 실질 개정을 구분하지 않으며, 기본은 변경 조문만·본문 대신 길이·해시·달라진 구간.',
    inputSchema: { type: 'object', properties: {
      a: { type: 'string', description: '기준(이전) 문서 doc_id' },
      b: { type: 'string', description: '비교(이후) 문서 doc_id' },
      include_body: { type: 'boolean', description: '변경 조문의 본문 일부 포함 (기본 false)' },
      only_changed: { type: 'boolean', description: '변동 없는 조문 제외 (기본 true)' },
      max_changes: { type: 'integer', description: '한 번에 돌려줄 조문 수 1~100 (기본 30). 이어서는 offset' },
      offset: { type: 'integer', description: '변경 조문 목록 이어서 (응답의 next_offset)' },
      body_chars: { type: 'integer', description: 'include_body 일 때 조문당 본문 길이 50~700 (기본 300)' } }, required: ['a', 'b'] },
  },
  get_series: {
    name: 'get_series',
    description: '한 기관·항목의 공시 회차(분기·연) 또는 법령·내규·단체협약의 판본 연혁을 시간순 목록으로 조회(수치는 추출하지 않음). 시점별 변화를 볼 때 쓰고, 값은 목록의 doc_id 를 get_article/search_corpus 로 읽을 것. 공시는 from/to·정렬이 보고 대상 분기(period_label_adj)이고 period_label 은 제출 회차 라벨이며, target_year 는 문서 제목의 20XX년이다. 항목명·기관명이 불확실하면 list_catalog 를 먼저.',
    inputSchema: { type: 'object', properties: {
      inst: { type: 'string', description: '기관명 (정확하지 않으면 후보를 알려 줌). legal 은 생략 가능' },
      item: { type: 'string', description: '공시: 항목명(예 "임직원 수"). 법령·내규·단체협약: 문서명 일부(예 "인사규정")' },
      corpus: { type: 'string', enum: ['disclosure', 'bylaws', 'ca', 'legal'], description: '기본 disclosure' },
      from: { type: 'string', description: '시작 — 공시 "2024" 또는 "2024Q3"(보고 대상 분기: period_label_adj 기준), 그 외 "2024" 또는 "2024-07-01"' },
      to: { type: 'string', description: '끝 (형식 같음)' } }, required: ['item'] },
  },
  get_related: {
    name: 'get_related',
    description: '법령·기관내규 문서의 한 조문이 인용하는 조문(outgoing)·이 조문을 인용하는 조문(incoming)을 조회(단체협약·공시 문서는 미지원). 근사 결과(approximate=true)로 전수가 아니며 법령명이 본문에 적힌 경우만 잡는다. 조문 본문은 get_article 로 먼저 확인하고, 근거 법령 추적·영향 범위 확인에 쓸 것.',
    inputSchema: { type: 'object', properties: {
      doc_id: { type: 'string', description: '문서 ID (search_corpus/get_document 결과의 doc_id)' },
      art_no: { type: 'integer', description: '조 번호 (제N조의 N)' },
      art_sub: { type: 'integer', description: '가지조문 번호 (제N조의M의 M, 선택)' },
      direction: { type: 'string', enum: ['outgoing', 'incoming', 'both'], description: '기본 outgoing. incoming 은 법령 문서에서만 다른 문서까지 찾음' },
      limit: { type: 'integer', description: '방향별 최대 1~50 (기본 20)' } }, required: ['doc_id', 'art_no'] },
  },
};

/** get_document 의 offset 노출(MCP_DOC_OFFSET=on). 설명문 «offset 이 없다» 문장을 사용법으로 바꾼다(문장이 바뀌어 있으면 아무것도 안 하고 false). */
const DOC_OLD = '조문은 seq 순 최대 max_articles(기본 50·상한 200)개이고 offset 이 없다 — 조문이 200개를 넘는 긴 문서의 뒷부분은 목록으로 볼 수 없으니(전체 개수는 document.n_articles) search_corpus 로 조문을 좁히거나 get_article 로 번호를 지정할 것. ';
const DOC_NEW = '조문은 seq 순 최대 max_articles(기본 50·상한 200)개 — 더 있으면 offset 으로 이어서 가져온다(응답의 total_articles·next_offset). 번호를 알면 get_article 이 빠르다. ';
function patchDocumentTool(t) {
  if (!t.description.includes(DOC_OLD)) throw new Error('get_document 설명문이 예상과 달라 offset 안내를 바꿀 수 없다');
  t.description = t.description.replace(DOC_OLD, DOC_NEW);
  t.inputSchema.properties.max_articles.description = '조문 수 상한 1~200 (기본 50)';
  t.inputSchema.properties.offset = { type: 'integer', description: '앞에서 건너뛸 조문 수 (기본 0). 응답의 next_offset 으로 이어서' };
}

// ── 설치 시점 스키마 정합: 서버 설정에 따라 «실제로 되는 것만» 스키마·설명에 둔다(오류 문구·스키마·설명 모순 방지) ──
const catOn = () => on('MCP_LIST_CATALOG');
function tuneCatalog(d) {
  if (IF.mode() === 'off') {   // 항목 사전은 ITEM_FILTER 가 꺼지면 오류 → 스키마에서 제거
    d.inputSchema.properties.kind.enum = CAT_KINDS.filter(k => k !== 'items');
    d.inputSchema.properties.kind.description = '목록 종류: institutions(기관, ministry 포함)|ministries|doc_types|usecases';
    d.description = d.description.replace('·공시항목)', ')');
  }
  return d;
}
function tuneSeries(d) {
  const P = d.inputSchema.properties, itemOn = IF.mode() !== 'off';
  if (!itemOn) {   // 공시 계열은 ITEM_FILTER 필요 — 꺼져 있으면 스키마에서 공시를 뺀다
    P.corpus = { type: 'string', enum: ['bylaws', 'ca', 'legal'], description: '대상 코퍼스(필수)' };
    P.item = { type: 'string', description: '문서명 일부(예 "인사규정")' };
    P.from = { type: 'string', description: '시작 — "2024" 또는 "2024-07-01"' };
    P.to = { type: 'string', description: '끝 (형식 같음)' };
    P.inst = { type: 'string', description: '기관명 (정확하지 않으면 후보를 알려 줌). bylaws·ca 는 필수, legal 은 생략 가능' };
    d.inputSchema.required = ['item', 'corpus'];
    d.description = '한 기관의 법령·내규·단체협약 판본 연혁을 시간순 목록으로 조회(수치는 추출하지 않음). 시점별 변화를 볼 때 쓰고, 값은 목록의 doc_id 를 get_article/search_corpus 로 읽을 것.';
  }
  if (!catOn()) d.description = d.description.replace(' 항목명·기관명이 불확실하면 list_catalog 를 먼저.', '');
  return d;
}
function tuneRelated(d) {
  const P = d.inputSchema.properties, inc = on('MCP_RELATED_INCOMING');
  if (!inc) {   // incoming 이 꺼져 있으면 outgoing 만
    P.direction = { type: 'string', enum: ['outgoing'], description: '인용 방향 (현재 outgoing 만 제공)' };
    d.description = '법령·기관내규 문서의 한 조문이 인용하는 조문(outgoing)을 조회(단체협약·공시 문서는 미지원). 근사 결과(approximate=true)로 전수가 아니며 법령명이 본문에 적힌 경우만 잡는다. 조문 본문은 get_article 로 먼저 확인하고, 근거 법령 추적에 쓸 것.';
  } else {
    const al = String(process.env.MCP_RELATED_CORPORA || 'legal,bylaws').split(',').map(x => x.trim()).filter(x => ['legal', 'bylaws'].includes(x));
    P.direction.description = '기본 outgoing. incoming 은 범위(corpus·inst)가 좁을수록 빠르다 — 기본 범위: 법령 문서는 legal, 내규 문서는 같은 기관 내규';
    P.corpus = { type: 'string', enum: al, description: 'incoming 에서 인용 문서를 찾을 코퍼스. 법령 문서 대상 기본 legal. bylaws 는 inst 와 함께 지정' };
    P.inst = { type: 'string', description: 'incoming 에서 인용 문서의 기관명 필터(부분일치). 법령 문서의 내규 피인용(corpus=bylaws)에는 필수' };
  }
  return d;
}

function install(ctx) {
  const { TOOLS, HANDLERS } = ctx, added = [];
  const add = (def, fn) => { TOOLS.push(JSON.parse(JSON.stringify(def))); HANDLERS[def.name] = fn; added.push(def.name); };
  if (on('MCP_DOC_OFFSET')) patchDocumentTool(TOOLS.find(t => t.name === 'get_document'));
  if (on('MCP_LIST_CATALOG')) {
    add(tuneCatalog(JSON.parse(JSON.stringify(D.list_catalog))), makeListCatalog(ctx));
    TOOLS[0].description += IF.mode() === 'off' ? ' 필터 값(기관명·부처·type·usecase)을 모르면 먼저 list_catalog.' : ' 필터 값(기관명·부처·type·usecase·item)을 모르면 먼저 list_catalog.';   // search_corpus 선택 지침(on 일 때만)
  }
  // 항목명 목록 컴팩트(MCP_ITEM_DESC=compact): item_filter.js 의 describeItems 가 만든 «항목명: …» 목록(약 1,500자)을 한 줄 안내로 바꾼다.
  //   list_catalog 가 켜져 있고(안내 대상이 존재) ITEM_FILTER 가 켜진 경우에만 — 아니면 값을 무시하고 목록을 그대로 둔다. 스키마(item 인자)는 불변, 설명 문자열만 후처리(item_filter.js 수정 없음).
  if (process.env.MCP_ITEM_DESC === 'compact' && on('MCP_LIST_CATALOG') && IF.mode() !== 'off') {
    const d = TOOLS[0].description, i = d.indexOf('항목명: '), j = d.indexOf('. period=', i);
    if (i > 0 && j > i) TOOLS[0].description = d.slice(0, i) + '항목명은 list_catalog(kind="items")로 확인' + d.slice(j);
    else process.stderr.write('[mcp] MCP_ITEM_DESC=compact 이지만 항목명 목록 문구를 찾지 못해 적용하지 않는다\n');
  }
  if (on('MCP_COMPARE')) {
    if (judgeArticle) add(D.compare_documents, makeCompare(ctx));
    else process.stderr.write('[mcp] MCP_COMPARE=on 이지만 lib/article_quality.js 가 없어 compare_documents 를 열지 않는다\n');
  }
  if (on('MCP_SERIES')) add(tuneSeries(JSON.parse(JSON.stringify(D.get_series))), makeSeries(ctx));
  if (on('MCP_STRUCTURED')) {
    const SQ = require('./structured_query.js'), run = SQ.makeRunner(ctx.withPooled);
    add(SQ.toolDef(), async (a, cctx) => { const lim = heavyLimited('structured', cctx); if (lim) throw limitErr('structured_query', lim); try { return SQ.maskResult(await run(a, cctx && cctx.tier), cctx && cctx.tier); } catch (e) { const w = wrapTmo('구조화 데이터', e, 'inst·year·limit 등으로 조건을 좁히거나 잠시 후 다시 시도하세요.', 8); if (w !== e || ['BAD_REQUEST', 'BUSY', 'NOT_READY'].includes(e.code)) throw w; process.stderr.write('[structured_query] ' + (e.code || '') + ' ' + e.message + '\n'); throw new Error('조회 실패(잠시 후 다시 시도)'); } });
  }
  if (on('MCP_RELATED')) add(tuneRelated(JSON.parse(JSON.stringify(D.get_related))), makeRelated(ctx));
  return added;
}

module.exports = { install, maskExtra, extractRefs, compareArticles, changeSpan, heavyLimited, _internal: { heavyHits, catCache, relCache, artKey, sgdFlat } };
