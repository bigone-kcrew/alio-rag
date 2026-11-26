'use strict';
// REST 문서 조회(2026-11-09): MCP get_document 와 같은 질의로 문서 메타 + 조문(청크) 전체를 순서대로 돌려준다 — 표 청크의 열 머리글까지 포함.
// withPooled·annotateEdition 은 호출부(api_server.js)가 넘긴다(시험에서 가짜로 교체). 본문 합계가 max_chars 를 넘으면 거기서 자르고 next_offset 을 준다.
async function resolveDocId(c, docId) {
  if ((await c.query('SELECT 1 FROM documents WHERE doc_id = $1', [docId])).rowCount) return docId;
  const i = docId.indexOf(':');
  if (i < 0) return docId;
  const r = await c.query('SELECT doc_id FROM documents WHERE corpus = $1 AND rel_path = $2 ORDER BY doc_id LIMIT 1', [docId.slice(0, i), docId.slice(i + 1)]);
  return r.rows[0] ? r.rows[0].doc_id : docId;
}
async function readDocument(withPooled, annotateEdition, a) {
  const docIn = String(a.doc_id || '').slice(0, 300);
  if (!docIn) throw Object.assign(new Error('doc_id 가 필요합니다'), { code: 'BAD_REQUEST' });
  const maxArts = Math.min(200, Math.max(1, parseInt(a.max_articles, 10) || 200));
  const maxChars = Math.min(200000, Math.max(2000, parseInt(a.max_chars, 10) || 60000));
  const off = Math.min(1e6, Math.max(0, parseInt(a.offset, 10) || 0));
  return withPooled(["SET LOCAL statement_timeout='15s'"], async c => {
    const docId = await resolveDocId(c, docIn);
    const doc = (await c.query(
      `SELECT d.doc_id, d.corpus, d.doc_title, d.alias, d.doc_type, d.doc_date, d.rel_path, d.n_articles, i.inst_name, i.ministry,
              d.meta->>'edition_group' AS edition_group, d.meta->>'edition_status' AS edition_status, d.meta->>'edition_basis' AS edition_basis,
              COALESCE(NULLIF(d.meta->>'effective_from', ''), CASE WHEN d.corpus = 'bylaws' AND d.doc_date ~ '^[0-9]{8}$' THEN d.doc_date END) AS effective_from,
              NULLIF(d.meta->>'effective_to', '') AS effective_to, COALESCE(d.meta->>'repealed', '') = 'true' AS repealed,
              COALESCE(d.meta->>'lineage_closed', '') = 'true' AS lineage_closed, NULLIF(d.meta->>'lineage_successor', '') AS lineage_successor, d.created_at, d.updated_at
         FROM documents d LEFT JOIN institutions i USING (inst_code) WHERE d.doc_id = $1`, [docId])).rows[0];
    if (!doc) throw Object.assign(new Error('문서 없음'), { code: 'DOC_NOT_FOUND' });
    const rows = (await c.query(
      `SELECT seq, section, chapter, art_no, art_sub, title, n_chars, body FROM articles WHERE doc_id = $1 ORDER BY seq LIMIT $2 OFFSET $3`, [docId, maxArts, off])).rows;
    const total = (await c.query('SELECT count(*)::int AS n FROM articles WHERE doc_id = $1', [docId])).rows[0].n;
    const articles = []; let chars = 0;
    for (const r of rows) { if (articles.length && chars + String(r.body || '').length > maxChars) break; chars += String(r.body || '').length; articles.push(r); }
    const out = { document: annotateEdition([doc])[0], articles, articles_shown: articles.length, total_articles: total, offset: off };
    if (off + articles.length < total) out.next_offset = off + articles.length;
    return out;
  });
}
module.exports = { readDocument, resolveDocId };
