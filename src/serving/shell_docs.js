'use strict';
// c8(ShortDocs, QueryStudy 검증 반영): 껍데기 문서·초단문 청크 서빙 처리 — 재임베딩·DB 변경 없음. 기능별 플래그(기본 off):
//   SEARCH_SHELL_REPLACE 껍데기→첨부 대체(확신 있을 때만, 아니면 linked_candidates 안내)  SEARCH_SHELL_MERGE 100자 미만 조각 병합(연락처 맥락 제외)
//   SEARCH_SHELL_HIDE 첨부 없는 껍데기 숨김  SEARCH_SHELL_GUARD 짧은 행 뒤로 보내기.  SEARCH_SHELL_HANDLING=on 은 호환용으로 REPLACE·MERGE·HIDE 를 함께 켠다(GUARD 는 별도).
// 껍데기 = doc_id 의 kind 토큰이 c(본문 페이지)이고 content_chars<60. 같은 «기관:공시번호» 의 kind=a(첨부, content_chars≥60)에 내용이 있다.
const f = k => process.env[k] === 'on', legacy = () => f('SEARCH_SHELL_HANDLING');
const repOn = () => legacy() || f('SEARCH_SHELL_REPLACE'), merOn = () => legacy() || f('SEARCH_SHELL_MERGE'), hidOn = () => legacy() || f('SEARCH_SHELL_HIDE'), guardOn = () => f('SEARCH_SHELL_GUARD');
const on = () => repOn() || merOn() || hidOn();          // 껍데기 처리(대체·병합·숨김) 중 하나라도
const anyOn = () => on() || guardOn();
const SHELL_CHARS = 60, FRAG = 100;
const NO_REPLACE = /^(B1020|B1010)(_|$)/;                // 채용 공고 항목은 첨부가 회차별로 섞여 오대체 위험 — 대체 제외(후보만 안내)
const CONTACT = /(작성자|담당자|직통|연락처|문의|전화|TEL|Tel|FAX|Fax|팩스|감독자|확인자|성명|이메일|E-?mail|내선)/;   // 개인 연락처 맥락 — 병합 제외
const parse = id => { const t = String(id || '').split(':'); return t.length === 5 && t[0] === 'disclosure' ? { inst: t[1], no: t[2], kind: t[3], pre: t.slice(0, 3).join(':') } : null; };

// ── 대체 첨부 선택: 제목 유사도(문자 2-gram)·회차 일치 ──
const norm = s => String(s || '').toLowerCase().replace(/[\s\-_.,·()\[\]{}'"~:]/g, '');
const bg = s => { const t = norm(s), o = new Set(); for (let i = 0; i < t.length - 1; i++) o.add(t.slice(i, i + 2)); return o; };
const sim = (a, b) => { const x = bg(a), y = bg(b); if (!x.size || !y.size) return 0; let i = 0; for (const k of x) if (y.has(k)) i++; return i / (x.size + y.size - i); };
const ordinals = s => new Set([...String(s || '').matchAll(/제\s*(\d+)\s*[회차]|(\d+)\s*[회차]/g)].map(m => m[1] || m[2]));
const conflict = (a, b) => { const x = ordinals(a), y = ordinals(b); if (!x.size || !y.size) return false; for (const k of x) if (y.has(k)) return false; return true; };   // 둘 다 회차가 있는데 겹치지 않음
/** 껍데기 행 + 첨부 목록 → {pick, candidates, confident}. 확신 없으면 pick=null. */
function choose(shellTitle, category, atts) {
  const cands = atts.map(a => ({ a, s: sim(shellTitle, a.doc_title), c: conflict(shellTitle, a.doc_title) })).sort((x, y) => y.s - x.s);
  const ok = cands.filter(x => !x.c), list = cands.slice(0, 5).map(x => ({ doc_id: x.a.doc_id, doc_title: x.a.doc_title, ...(x.c ? { note: '회차 불일치' } : {}) }));
  if (NO_REPLACE.test(category || '') || !ok.length) return { pick: null, candidates: list, reason: NO_REPLACE.test(category || '') ? 'excluded_code' : 'ordinal_conflict' };
  if (atts.length === 1) return { pick: ok[0].a, candidates: list };
  const best = ok[0], second = ok[1];
  if (best.s >= 0.35 && (!second || best.s - second.s >= 0.15)) return { pick: best.a, candidates: list };
  return { pick: null, candidates: list, reason: 'ambiguous' };
}

/** rows(공시 행 포함) → {rows, notes}. run(sql, params) → rows. opts: {includeShort, filtered(기관+항목 지정)} */
async function handle(run, rows, opts = {}) {
  rows = rows.map(r => ({ ...r }));   // 입력 행을 바꾸지 않는다
  const disc = rows.filter(r => r.corpus === 'disclosure' && parse(r.doc_id));
  if (!disc.length) return { rows, notes: {} };
  // 정보 조회는 껍데기 후보(kind c)·조각 후보(본문 100자 미만)만 — 쿼리·시간 절약
  const need = [...new Set(disc.filter(r => parse(r.doc_id).kind === 'c' || (typeof r.body === 'string' && r.body.length < FRAG)).map(r => r.doc_id))];
  const info = new Map((need.length ? await run('SELECT doc_id, content_chars, n_articles FROM documents WHERE doc_id = ANY($1::text[])', [need]) : []).map(x => [x.doc_id, x]));
  const isShell = r => { const p = parse(r.doc_id), i = info.get(r.doc_id); return !!(r.corpus === 'disclosure' && p && p.kind === 'c' && i && (i.content_chars || 0) < SHELL_CHARS); };
  const shells = disc.filter(isShell), notes = {};
  // 같은 기관:공시번호 의 첨부(kind=a, content_chars≥60) 전부(대체·숨김 판정용)
  const att = new Map();
  if (shells.length && (repOn() || hidOn())) {
    const ps = [...new Map(shells.map(r => [parse(r.doc_id).pre, parse(r.doc_id)])).values()];
    const got = await run(`SELECT s.pre, d.doc_id, d.doc_title, d.rel_path, d.content_chars FROM unnest($1::text[], $2::text[]) AS s(inst, pre) JOIN documents d ON d.inst_code = s.inst AND d.doc_id LIKE s.pre || ':a:%' WHERE d.content_chars >= ${SHELL_CHARS} ORDER BY d.content_chars DESC`, [ps.map(p => p.inst), ps.map(p => p.pre)]);
    for (const g of got) { const l = att.get(g.pre) || att.set(g.pre, []).get(g.pre); if (l.length < 12) l.push(g); }
  }
  const choice = new Map();   // pre → choose 결과(껍데기 제목별이 아니라 행별로 계산)
  const picks = [];
  for (const r of shells) { const l = att.get(parse(r.doc_id).pre); if (l && l.length) { const c = repOn() ? choose(r.doc_title, r.category, l) : { pick: null, candidates: l.slice(0, 5).map(a => ({ doc_id: a.doc_id, doc_title: a.doc_title })), reason: 'replace_off' }; choice.set(r.doc_id, c); if (c.pick) picks.push(c.pick.doc_id); } }
  const firsts = picks.length ? await run('SELECT doc_id, left(body, 600) AS body, title FROM articles WHERE doc_id = ANY($1::text[]) AND seq = 1', [[...new Set(picks)]]) : [];
  const fmap = new Map(firsts.map(x => [x.doc_id, x]));
  // ④ 병합 후보 조회(대체와 독립 — 한 번의 조인 쿼리)
  const frag = merOn() ? disc.filter(r => !isShell(r) && typeof r.body === 'string' && r.body.length < FRAG && (info.get(r.doc_id) || {}).n_articles > 1 && !CONTACT.test(r.body) && !CONTACT.test(r.art_title || '')) : [];
  const nextMap = new Map();
  if (frag.length) {
    const got = await run('SELECT a.doc_id, a.body AS cur, left(n.body, 400) AS next FROM articles a JOIN articles n ON n.doc_id = a.doc_id AND n.seq = a.seq + 1 WHERE a.doc_id = ANY($1::text[]) AND a.body = ANY($2::text[])', [[...new Set(frag.map(r => r.doc_id))], [...new Set(frag.map(r => r.body))]]);
    for (const g of got) nextMap.set(g.doc_id + '\u0000' + g.cur, g.next);
  }
  const have = new Set(rows.map(r => r.doc_id)), seenRep = new Set();
  let replaced = 0, folded = 0, hidden = 0, marked = 0, ambiguous = 0, merged = 0; const out = [];
  for (const r of rows) {
    if (!isShell(r)) {
      if (merOn() && r.corpus === 'disclosure' && typeof r.body === 'string' && r.body.length < FRAG && frag.includes(r)) {   // frag 는 복사본 rows 의 원소
        const nx = nextMap.get(r.doc_id + '\u0000' + r.body); if (nx && !CONTACT.test(nx.slice(0, 120))) { r.body = r.body + '\n' + nx; r.merged_with_next = true; merged++; } else r.short_chunk = true;
      } else if (merOn() && r.corpus === 'disclosure' && typeof r.body === 'string' && r.body.length < FRAG && parse(r.doc_id)) r.short_chunk = true;
      out.push(r); continue;
    }
    if (!anyOn()) { out.push({ ...r, short_doc: true }); marked++; continue; }
    const c = choice.get(r.doc_id), l = att.get(parse(r.doc_id).pre);
    if (c && c.pick) {   // ② 확신 있는 대체(이미 결과에 있으면 접기)
      const a = c.pick;
      if (have.has(a.doc_id) || seenRep.has(a.doc_id)) { folded++; continue; }
      seenRep.add(a.doc_id); replaced++; const fb = fmap.get(a.doc_id) || {};
      out.push({ ...r, doc_id: a.doc_id, doc_title: a.doc_title, rel_path: a.rel_path, art_title: fb.title || a.doc_title, body: fb.body != null ? fb.body : r.body, replaced_from: r.doc_id, replaced_note: '본문 없는 공시 껍데기 페이지라 같은 공시번호의 첨부 문서로 바꿨습니다' });
    } else if (l && l.length) {   // 첨부는 있으나 확신 없음/대체 제외 — 그대로 두고 후보 안내
      ambiguous++; out.push({ ...r, short_doc: true, linked_candidates: c ? c.candidates : l.slice(0, 5).map(a => ({ doc_id: a.doc_id, doc_title: a.doc_title })), ...(c && c.reason && c.reason !== 'replace_off' ? { linked_note: c.reason === 'excluded_code' ? '채용 공고 항목은 첨부가 회차별로 섞여 자동 대체하지 않았습니다 — linked_candidates 를 확인하세요' : '같은 공시번호의 첨부가 여러 개라 어느 것이 이 페이지의 내용인지 확신할 수 없어 대체하지 않았습니다 — linked_candidates 를 확인하세요' } : {}) }); marked++;
    } else if (!hidOn() || opts.includeShort || opts.filtered) { out.push({ ...r, short_doc: true }); marked++; }   // 첨부 없는 껍데기: HIDE off·include_short·기관+항목 필터에서는 노출
    else hidden++;
  }
  if (replaced) notes.shell_replaced = replaced;
  if (ambiguous) notes.shell_ambiguous = ambiguous;
  if (folded) notes.shell_folded = folded;
  if (hidden) notes.shell_hidden = hidden;
  if (marked) notes.short_doc_marked = marked;
  if (merged) notes.merged_fragments = merged;
  let res = out;
  if (guardOn()) { const bad = r => r.short_doc || r.short_chunk || (typeof r.body === 'string' && r.body.length < FRAG && !r.merged_with_next); res = [...out.filter(r => !bad(r)), ...out.filter(bad)]; if (res.some((r, i) => r !== out[i])) notes.shell_guard = '본문이 짧은 껍데기·조각 행을 뒤로 보냈습니다(제목 일치 상위 점유 완화)'; }
  return { rows: res, notes };
}
module.exports = { on, anyOn, repOn, merOn, hidOn, guardOn, parse, handle, choose, sim, ordinals, CONTACT, SHELL_CHARS, FRAG };
