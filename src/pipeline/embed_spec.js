'use strict';
/**
 * 임베딩 «입력 정의» 단일 출처 (2026-10-06 적재·임베딩 설계 v1).
 *
 * 🔴 EMBED_CUT·접두 형식·모델·차원을 바꾸면 text_hash 가 전부 바뀐다 = 전량 재임베딩(+HNSW 재빌드).
 *    그래서 값은 이 파일 한 곳에만 둔다. load_pg.js(SQL 함수)·embed_articles.js(MAX_CHARS 단언)·
 *    _create_hnsw.js·search.js(질의 SQL)가 전부 여기를 읽는다.
 * 이 파일은 DB·네트워크에 접근하지 않는다(단위시험 가능).
 */

const EMBED_CUT = 3500;                       // 입력 컷(문자 = 코드포인트). 접두+제목+본문 합계에 적용 — 해시 정의에 포함
// 청커의 «짧은 조각 흡수» 한도 = EMBED_CUT - 이 값. 실제 임베딩 입력은 접두+제목이 본문 앞에 붙은 뒤 left(…,EMBED_CUT) 로 잘리므로, 본문만 컷 이내여도 꼬리가 유실된다.
// 값을 바꾸면 청킹이 바뀐다 = RULESET(chunk_doc.js·parse_disclosure.js)도 같이 올릴 것(해시 정의 변경 추적).
const EMBED_PREFIX_ALLOWANCE = 300;
const EMBED_DIM = 1024;
const ALLOWED_MODELS = ['baai/bge-m3', 'bge-m3'];   // OpenRouter 표기 / 로컬 ollama 표기(문자열이 다르다)
const PREFIX_POLICY = (process.env.PREFIX_ALWAYS_CORPORA ?? 'ca').split(',').map(x => x.trim()).filter(Boolean).length ? 'unique-only+always:' + (process.env.PREFIX_ALWAYS_CORPORA ?? 'ca').split(',').map(x => x.trim()).filter(Boolean).join('+') : 'unique-only';          // 접두는 base 해시가 유일한 청크에만(load_pg.hashInsertSql)

// ── alio_embed_text(): 임베딩 입력의 SQL 정의 ──────────────────────────────────
// 주의: JS 템플릿 리터럴이라 SQL 의 E'\n' 은 `E'\\n'` 으로 적는다. 주석에 백틱 금지.
const EMBED_TEXT_FN_SQL = `CREATE OR REPLACE FUNCTION alio_embed_text(
  p_title text, p_body text,
  p_inst text, p_doc text, p_chapter text, p_section text,
  p_concept text, p_prefix boolean
) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT left(
    CASE WHEN p_prefix THEN
      '[' || coalesce(p_inst, '') || '] ' || coalesce(p_doc, '')
      || CASE WHEN coalesce(p_chapter,'') <> '' THEN ' > ' || p_chapter ELSE '' END
      || CASE WHEN coalesce(p_section,'') NOT IN ('', '본칙') THEN ' > ' || p_section ELSE '' END
      || CASE WHEN coalesce(p_concept,'') <> '' THEN ' | ' || p_concept ELSE '' END
      || E'\\n'
    ELSE '' END
    || CASE WHEN p_title IS NOT NULL AND p_title <> '' THEN p_title || E'\\n' ELSE '' END
    || coalesce(p_body, '')
  , ${EMBED_CUT})
$fn$;`;

// SQL 함수와 «같은» 규칙의 JS 참조 구현 — 시험·오프라인 점검용(운영 경로는 SQL 함수만 쓴다).
// left() 는 코드포인트 단위 → Array.from 으로 센다(UTF-16 slice 금지).
function embedTextJs({ title, body, inst, doc, chapter, section, concept, prefix }) {
  let s = '';
  if (prefix) {
    s += '[' + (inst || '') + '] ' + (doc || '');
    if (chapter) s += ' > ' + chapter;
    if (section && section !== '본칙') s += ' > ' + section;
    if (concept) s += ' | ' + concept;
    s += '\n';
  }
  if (title) s += title + '\n';
  s += body || '';
  return Array.from(s).slice(0, EMBED_CUT).join('');
}

// load_runs.embed_spec — 「이 DB 의 벡터가 어떤 입력 정의로 만들어졌나」 한 줄. 모델은 실행 시점 provider 모델명.
function embedSpecString({ model = 'bge-m3', chunker = 'unknown', index = 'halfvec-rescore' } = {}) {
  return `${model}|${EMBED_DIM}|prefix=${PREFIX_POLICY}|cut=${EMBED_CUT}|chunker=${chunker}|index=${index}`;
}

// ── HNSW: 저장은 vector(1024) 전정밀도, 인덱스는 halfvec 표현식 ────────────────
const HNSW_INDEX_NAME = 'idx_emb_hnsw';
const HNSW_EXPR = `(embedding::halfvec(${EMBED_DIM}))`;
function hnswCreateSql({ m = 16, efc = 64, type = 'halfvec', name = HNSW_INDEX_NAME } = {}) {
  const target = type === 'halfvec' ? `${HNSW_EXPR} halfvec_cosine_ops` : 'embedding vector_cosine_ops';
  return `CREATE INDEX ${name} ON article_embeddings USING hnsw (${target}) WITH (m = ${m}, ef_construction = ${efc})`;
}
// 질의 쪽 ORDER BY 식 — 인덱스 표현식과 «글자 그대로» 같은 형태여야 플래너가 인덱스를 쓴다.
// 인자는 SQL 조각(예: 'e.embedding', '$1::vector(1024)').
function halfvecOrder(colExpr, vecExpr) {
  return `${colExpr}::halfvec(${EMBED_DIM}) <=> (${vecExpr})::halfvec(${EMBED_DIM})`;
}

module.exports = { EMBED_CUT, EMBED_PREFIX_ALLOWANCE, EMBED_DIM, ALLOWED_MODELS, PREFIX_POLICY, EMBED_TEXT_FN_SQL, embedTextJs, embedSpecString,
  HNSW_INDEX_NAME, HNSW_EXPR, hnswCreateSql, halfvecOrder };
