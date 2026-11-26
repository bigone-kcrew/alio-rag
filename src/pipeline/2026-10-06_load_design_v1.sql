-- 적재·임베딩 설계 v1 스키마 마이그레이션 (2026-10-06) — 멱등(IF NOT EXISTS / OR REPLACE). 데이터 삭제 없음.
--
-- 용도: psql 로 «미리 적용·검토» 할 때. load_pg.js 는 첫 실행(SCHEMA·ensureColumns)에서 같은 변경을 스스로 한다(신규 DB 는 CREATE TABLE 에 이미 들어 있음).
--       그래서 이 파일과 load_pg.js ensureColumns 는 «같은 내용»이어야 한다 — _test_migration.js 가 대조한다.
-- 적용 전 점검:  \d documents   \d articles   \d load_runs   \df+ alio_embed_text      (기대: 아래 신규 칼럼이 «없음»)
-- 적용: psql -v ON_ERROR_STOP=1 -d alio_rag -f rag/migrations/2026-10-06_load_design_v1.sql
-- 적용 후 점검: 같은 \d 에서 신규 칼럼·uq_articles_doc_art_key 확인, SELECT prosrc FROM pg_proc WHERE proname='alio_embed_text' 에 3500 포함.
--
-- 🔴 이 파일을 적용해도 text_hash 는 바뀌지 않는다(함수는 «다음 적재 때» 해시 계산에 쓰인다). 이미 적재된 행의 해시를 새 컷(3500)으로 다시 계산하려면 load_pg 재적재가 필요하다.

CREATE OR REPLACE FUNCTION alio_embed_text(
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
      || E'\n'
    ELSE '' END
    || CASE WHEN p_title IS NOT NULL AND p_title <> '' THEN p_title || E'\n' ELSE '' END
    || coalesce(p_body, '')
  , 3500)
$fn$;

-- 테이블이 아직 없는 DB(신 서버 초기 상태)에서도 통과하도록 존재 확인 뒤에만 ALTER 한다.
DO $mig$
BEGIN
  IF to_regclass('documents') IS NOT NULL THEN
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS parser_ver   text;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS converted_at timestamptz;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS ocr_kind     text;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS body_md5     text;   -- 문서 앵커 = (doc_id, body_md5)
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS src_md5      text;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS origin       text;   -- file-parsed | ocr-converted | crawl4ai-page | stats-sheet
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS anchor_level text;   -- article | document
  END IF;
  IF to_regclass('articles') IS NOT NULL THEN
    ALTER TABLE articles ADD COLUMN IF NOT EXISTS art_key text;         -- 조문 앵커 = (doc_id, art_key)
    CREATE UNIQUE INDEX IF NOT EXISTS uq_articles_doc_art_key ON articles (doc_id, art_key);
  END IF;
  IF to_regclass('article_hash') IS NOT NULL THEN
    ALTER TABLE article_hash ADD COLUMN IF NOT EXISTS base_hash text;   -- 접두 없는 해시: 접두 «고유 판정» 을 DB 전역으로 하기 위한 대조값
    CREATE INDEX IF NOT EXISTS idx_article_hash_base ON article_hash (base_hash);
  END IF;
  IF to_regclass('load_runs') IS NOT NULL THEN
    ALTER TABLE load_runs ADD COLUMN IF NOT EXISTS code_rev   text;
    ALTER TABLE load_runs ADD COLUMN IF NOT EXISTS embed_spec text;
  END IF;
  IF to_regclass('documents') IS NOT NULL AND to_regclass('articles') IS NOT NULL AND to_regclass('article_hash') IS NOT NULL THEN
    EXECUTE $v$CREATE OR REPLACE VIEW v_article_anchor AS
      SELECT a.doc_id, a.art_key, d.anchor_level, d.body_md5, ah.text_hash
      FROM articles a JOIN documents d ON d.doc_id = a.doc_id LEFT JOIN article_hash ah ON ah.id = a.id$v$;
  END IF;
END
$mig$;

-- ── HNSW (여기서 만들지 않는다 — 임베딩 «뒤» 에 _create_hnsw.js 가 만든다) ─────────────────────
-- 정의(참고, embed_spec.js 의 hnswCreateSql 과 같아야 함):
--   CREATE INDEX idx_emb_hnsw ON article_embeddings USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
-- 질의는 반드시  ORDER BY e.embedding::halfvec(1024) <=> ($1::vector(1024))::halfvec(1024)  형태(search.js semanticOrderBy).

-- ── 롤백(필요 시 수동) ──────────────────────────────────────────────────────────────────────
--   DROP VIEW IF EXISTS v_article_anchor;
--   DROP INDEX IF EXISTS uq_articles_doc_art_key;
--   ALTER TABLE articles   DROP COLUMN IF EXISTS art_key;
--   ALTER TABLE documents  DROP COLUMN IF EXISTS body_md5, DROP COLUMN IF EXISTS src_md5, DROP COLUMN IF EXISTS origin, DROP COLUMN IF EXISTS anchor_level;
--   ALTER TABLE load_runs  DROP COLUMN IF EXISTS code_rev, DROP COLUMN IF EXISTS embed_spec;
--   DROP INDEX IF EXISTS idx_article_hash_base;  ALTER TABLE article_hash DROP COLUMN IF EXISTS base_hash;
--   (alio_embed_text 를 4000 컷으로 되돌리면 이후 적재 해시가 달라진다 — 되돌리지 말 것. parser_ver·converted_at·ocr_kind 는 별도 diff 소관이라 롤백 대상에서 제외)
