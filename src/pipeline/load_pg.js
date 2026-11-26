#!/usr/bin/env node
/**
 * 2단계: _rag_staging JSONL → PostgreSQL(alio_rag) 적재
 *
 * 사용법: node rag/load_pg.js          # 스키마 생성 + 전체 적재 + 인덱스
 * 접속정보: 리포 루트 .env.api 의 POSTGRES_USER / POSTGRES_PASSWORD (host=postgres)
 * 재실행 안전: TRUNCATE 후 다시 적재 (멱등)
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Client } = require('pg');
const { EMBED_CUT, EMBED_TEXT_FN_SQL, embedSpecString } = require('./embed_spec');
const { keyedArticles, anchorLevel } = require('./art_key');
const gate = require('./load_gate');

const ROOT = path.join(__dirname, '..');
// 스테이징 경로도 바꿀 수 있어야 재적재 코드를 운영 데이터 건드리지 않고 검증할 수 있다(2026-08-02).
const STAGING = process.env.RAG_STAGING || path.join(ROOT, 'ops', '_rag_staging');
const CORPORA = ['legal', 'bylaws', 'ca'];
const BATCH = 2000;

// 적재 대상 DB. 기본은 운영 DB이고, 재적재 전 코드 검증 때만 PGDATABASE로 스크래치 DB를 가리킨다.
// (하드코딩이 4곳에 흩어져 있어 검증 실행 자체가 불가능했다 — 2026-08-02)
const DB = process.env.PGDATABASE || 'alio_rag';

// ALIO_PGHOST: 프로세스 환경변수로 접속 호스트만 덮어쓴다(.env.api 는 건드리지 않는다 — 리허설·alio-pg 적재 시험용, 컷오버 때는 .env.api 의 PGHOST 를 바꾼다).
function loadEnv() {
  const env = {};
  for (const l of fs.readFileSync(path.join(ROOT, '.env.api'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- pg_bigm: 2그램 색인. trgm(3그램)은 «2글자 한글»로 인덱스 키를 못 만들어 순차스캔으로 떨어진다
-- (2026-09-19 실측: 「연차」·「병가」·「징계」가 2.2초 = 무인덱스와 동일). bigm 은 같은 질의를 2~15ms.
CREATE EXTENSION IF NOT EXISTS pg_bigm;
-- vector도 스키마가 보장해야 한다 — article_embeddings(vector(1024))가 이걸 전제로 한다.
-- 종전엔 수동 설치에 의존해 신규 DB에서 적재가 성립하지 않았다(2026-08-02).
CREATE EXTENSION IF NOT EXISTS vector;

-- ── 임베딩 입력 텍스트: 단일 출처 (2026-08-01 신설) ──────────────────────────
-- 종전엔 같은 규칙을 load_pg(SQL)와 embed_articles(JS) 두 벌로 구현해 어긋날 수 있었다.
--   SQL: md5(title||E'\\n' || left(body,4000))   ← 본문만 4000 컷
--   JS : (title+'\\n'+body).slice(0,4000)        ← 전체 4000 컷
-- 이제 이 함수 하나만 쓰고 embed_articles는 조립하지 않는다(SELECT로 받아 그대로 전송).
--
-- 문맥 접두(p_prefix=true)를 붙이는 이유: 내규 청크 중앙값이 116자라 짧은 조각이
--   맥락 없이 벡터가 되면 기관·문서를 구별하지 못한다. 접두로 기관/문서/장/절을 벡터에 싣는다.
-- ⚠️ 접두는 **고유 청크에만** 붙인다. 전 청크에 붙이면 보일러플레이트(부칙 7자 등)의
--   중복제거가 깨져 벡터 1,899개가 190,463개로 불어난다(실측). 고유분에만 붙이면 증가 0.
-- 온톨로지 확장 자리: 아래 p_concept 자리에 개념경로(예: 복무>휴가>육아휴직)를 넣으면
--   재임베딩 없이 붙일 수 없으므로, 도입한다면 반드시 이 재임베딩 창에서 함께 넣어야 한다.
${EMBED_TEXT_FN_SQL}

CREATE TABLE IF NOT EXISTS institutions (
  inst_code text PRIMARY KEY,
  inst_name text NOT NULL,
  ministry  text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  doc_id       text PRIMARY KEY,
  corpus       text NOT NULL,            -- legal | bylaws | ca
  rel_path     text NOT NULL,
  inst_code    text REFERENCES institutions,
  category     text,                     -- legal 하위분류
  doc_title    text,
  alias        text,                     -- 법령 공식 약칭(law.go.kr 법령명약칭, legal 코퍼스만)
  doc_type     text,                     -- 규정/지침/규칙/세칙/단체협약/법률...
  doc_date     text,                     -- YYYYMMDD 또는 YYYY
  n_articles   int,
  coverage     real,
  parse_status text,                     -- ok | low_coverage | no_articles
  -- 아래 3필드는 파서가 만드는데 종전 INSERT 컬럼 목록에 없어 **통째로 버려졌다**(2026-08-02 확인).
  --   meta          : legal 코퍼스 frontmatter(시행일·공포일·소관부처 등) 전량
  --   content_chars : 본문 총 문자수. 없으면 **절단 규모를 DB만으로 산출할 수 없다**
  --                   (공시 7,918건이 40청크에서 잘렸는데 몇 자가 잘렸는지 알 수 없었다)
  --   covered_chars : 조문으로 덮인 문자수. coverage(비율)만으로는 절대량 복원 불가
  meta          jsonb,
  content_chars int,
  covered_chars int,
  -- 회차 구분 경로(2026Q2 등)에서 파서가 알아낸 분기. 분기 추이 조회의 유일한 출처다.
  period_quarter text,
  -- 🔴 내부 감사용(2026-10-06) — API·MCP·검색 응답·임베딩 입력·text_hash 에 «들어가지 않는다»(SELECT 목록에 없음).
  --    출처=md 매니페스트 B/장부(parser·converted_at·parse_mode). 구세대 md(약 20%)는 NULL.
  parser_ver   text,
  converted_at timestamptz,
  ocr_kind     text,
  -- 🔴 내부 감사·앵커(2026-10-06 적재 설계 v1) — 응답에 노출하지 않는다. 출처=정리 후 매니페스트(build_md_stamps_tsv.js).
  --    문서 앵커 = (doc_id, body_md5). 외부 연결 테이블은 연결 시점의 body_md5 를 같이 저장해 낡음을 검출한다.
  body_md5     text,                      -- 본문(머리말·꼬리 주석 제외) md5 — 재변환 대조 정본
  src_md5      text,                      -- 원본 파일(hwp/pdf 등) md5
  origin       text,                      -- file-parsed | ocr-converted | crawl4ai-page | stats-sheet
  anchor_level text,                      -- article(조문 앵커 유효) | document(청크 순번 앵커 — 문서 수준만 쓸 것)
  -- 🔴 활용처 태그 — 스키마 정본으로 이관(2026-09-20).
  --    종전엔 backfill_usecase.js:59 와 knn_tag_untagged.js:87 이 각자 ALTER 로 만들었다.
  --    그런데 search.js 는 4개 질의 경로에서 d.usecases 겹침연산을 «항상» 쓴다.
  --    → 재적재 직후 백필을 돌리기 전까지 모든 검색이 undefined_column(42703) 이다.
  --      그리고 api_server 가 그 오류를 흡수해 200 + 0건으로 보였다(2026-09-20 실측).
  --    컬럼이 비어(NULL) 있어도 파라미터 NULL 가드 덕에 필터 미지정 검색은 정상 동작한다.
  --    ⚠️ 이 블록은 JS 템플릿 리터럴 안이다 — 주석에 백틱을 쓰면 문자열이 끊긴다.
  usecases        text[],
  usecases_source text,                   -- 'dict' | 'knn' — 섞으면 재평가·롤백이 불가능하다
  -- 감사(audit): created_*=적재 시점(원본 날짜는 doc_date), updated_*=backfill 등 후속 수정
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,                     -- 기록 주체(스크립트 식별자, 예: load_pg@append)
  updated_at   timestamptz,              -- 트리거(set_updated_at)가 UPDATE 시 자동 기록
  updated_by   text,
  load_run_id  bigint                    -- load_runs.id — 어느 적재 배치에서 왔는지
);

CREATE TABLE IF NOT EXISTS articles (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id  text NOT NULL REFERENCES documents,
  seq     int  NOT NULL,
  section text,                          -- 본칙 | 부칙
  chapter text,
  art_no  int,
  art_sub int,
  title   text,
  body    text NOT NULL,
  n_chars int,
  -- 원문 md에서 이 조문이 차지하는 문자 오프셋 [시작, 끝]. 파서가 만드는데 종전 INSERT에 없었다.
  -- 뷰어가 원문을 그대로 잘라 보여주거나 온톨로지 증거 스팬을 걸 때 필요하다.
  -- ⚠️ articles.id 는 재적재마다 전부 바뀐다(TRUNCATE + IDENTITY 계속 증가) — 외부 앵커로 쓸 수 없다.
  --    안정 앵커는 (doc_id, seq), 파서 변경으로 seq 가 이동하면 text_hash 로 재정렬한다.
  "off"   int[],
  -- 조문 앵커: (doc_id, art_key) 유일(art_key.js 규칙). articles.id 는 재적재마다 바뀌므로 외부 키로 쓰지 말 것.
  art_key text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  load_run_id bigint,
  UNIQUE (doc_id, seq)
);

-- 적재 실행 이력(감사 단위): 어느 스크립트가 언제 무엇을 몇 건 적재했나
CREATE TABLE IF NOT EXISTS load_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  script      text NOT NULL,
  mode        text,                      -- full | append
  corpus      text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  n_docs      int,
  n_articles  int,
  code_rev    text,                      -- git 리비전(+dirty) 또는 CODE_REV
  embed_spec  text                       -- 예: bge-m3|1024|prefix=unique-only|cut=3500|chunker=<RULESET>|index=halfvec-rescore
);

-- documents UPDATE 시 updated_at 자동 기록 (라이터가 updated_by만 세팅하면 됨)
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $fn$
BEGIN NEW.updated_at = now(); RETURN NEW; END
$fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_documents_updated ON documents;
CREATE TRIGGER trg_documents_updated BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_articles_doc ON articles(doc_id)`,
  `CREATE INDEX IF NOT EXISTS idx_docs_inst ON documents(inst_code)`,
  `CREATE INDEX IF NOT EXISTS idx_docs_type ON documents(doc_type)`,
  `CREATE INDEX IF NOT EXISTS idx_docs_corpus ON documents(corpus)`,
  // 🔴 title trgm 은 «유지한다» — 기본 검색 경로가 `a.title % $1`(trgm 유사도 연산자)이고
  //    bigm 의 `=%` 는 의미가 다르다. 이걸 지우면 기본 검색이 통째로 순차스캔이 된다.
  `CREATE INDEX IF NOT EXISTS idx_articles_title_trgm ON articles USING gin (title gin_trgm_ops)`,
  // ── `--body` 경로(부분문자열 검색)용 bigm — 2026-09-19 교체 ──────────────────
  // 왜 bigm 인가: trgm 은 3그램이라 **2글자 한글에서 인덱스를 못 탄다**. 실측(파일럿 789,883행)
  //   「연차」 trgm 2,241ms(Seq Scan) → bigm 4ms · 「병가」 2,121ms → 2ms · 「징계」 2,191ms → 15ms.
  //   4자 이상은 동률(±3ms)이고 인덱스는 27% 작다(403MB → 293MB).
  // 🔴 왜 `lower()` 인가: `gin_bigm_ops` 가 지원하는 연산자는 `~~`(LIKE)와 `=%` 뿐이라
  //   **`ILIKE`(`~~*`)를 가속하지 못한다**. 인덱스를 만들어도 플래너가 안 쓴다(실측 8/8 Seq Scan).
  //   `lower(col) LIKE lower($1)` 로 쓰면 ILIKE 와 의미가 같으면서 인덱스를 탄다.
  //   → search.js 의 `artHitAt` 이 같은 형태여야 한다. 한쪽만 바꾸면 조용히 순차스캔으로 돌아간다.
  // 🔴 title 도 함께 거는 이유: `--body` 조건이 `(title … OR body …)` 라 한쪽만 bigm 이면
  //   2글자에서 title 쪽이 순차스캔을 유발해 이득이 사라진다.
  `CREATE INDEX IF NOT EXISTS idx_articles_title_bigm ON articles USING gin (lower(title) gin_bigm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_articles_body_bigm ON articles USING gin (lower(body) gin_bigm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_docs_title_trgm ON documents USING gin (doc_title gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_docs_alias_trgm ON documents USING gin (alias gin_trgm_ops)`,
  // 조번호 정확검색(제N조)용 — 없으면 코퍼스당 전수스캔이라 전체검색이 15s 타임아웃
  `CREATE INDEX IF NOT EXISTS idx_articles_artno ON articles(art_no) WHERE art_no IS NOT NULL`,
  // 활용처 필터(`d.usecases && $N`)용 — 종전엔 backfill_usecase.js 가 만들었다(2026-09-20 이관).
  `CREATE INDEX IF NOT EXISTS idx_docs_usecases ON documents USING gin (usecases)`,
];

async function* jsonlLines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line);
}

// ── append 모드: TRUNCATE 없이 특정 코퍼스만 추가 (기존 조문·임베딩 보존) ──────
// 새 청크 행에 대해서만 article_hash/embed_queue를 채워 embed_articles.js가
// 신규 벡터만 생성하게 함. text_hash는 임베딩 입력과 동일한 문자열의 md5.
// ── 2패스 해시 SQL (2026-08-02: 세 경로 통일) ────────────────────────────────
// 종전엔 full·delta가 구 인라인식(md5(title||개행||left(body,4000)))을, appendCorpus만
// alio_embed_text()를 썼다. 그 결과 **접두가 가장 필요한 내규(청크 중앙값 116자)는 접두를
// 못 받고 공시만 받는** 상태가 됐다(실측: 표본 10,001 중 함수식 일치 16건).
// 또 두 식은 left() 적용 위치가 달라 35,094건이 어긋난다(구식=body만 4000컷 / 함수=title+body 합계컷).
// → 해시 계산은 이 함수 하나로만 만든다. 두 벌로 두면 임베딩 텍스트와 해시가 어긋난다.
//
// 2패스: ① 접두 없는 base 해시로 중복 여부 판정 → ② 고유(1건)면 접두 붙인 해시, 공유면 base.
//   고유분에만 접두를 붙이므로 **벡터 증가 0**(전량 접두 시 보일러플레이트 1,899벡터가 190,463개로 불어난다).
//   prefixed 플래그를 저장해 embed_articles가 같은 판정을 재현할 필요가 없게 한다.
// ⚠️ unnest()는 다차원 배열을 **평탄화**한다. $10::int[][] 로 넘기면 int[] 컬럼에
//    정수가 들어가 "column \"off\" is of type integer[] but expression is of type integer"로 죽는다.
//    (2026-08-02 스크래치 DB E2E에서 검출 — 실제 재적재였다면 창을 통째로 날렸다)
//    배열 리터럴 문자열로 넘기고 행마다 ::int[] 로 캐스팅한다.
function offLit(v) { return Array.isArray(v) && v.length ? `{${v.join(',')}}` : null; }

// 🔴 2026-10-06 «고유 판정 범위 = DB 전역» 통일 (full·append·delta 동일 규칙)
//   종전: 판정 범위가 이번 적재 범위(full=3코퍼스 / append=그 코퍼스 / delta=그 문서들)라 같은 청크가 경로에 따라
//         접두를 받기도 하고 안 받기도 했다(= 다른 text_hash·다른 벡터).
//   규칙: 이번 범위의 base 해시 수 + 범위 «밖» article_hash 의 같은 base_hash 수 = 1 일 때만 접두(= 전역에서 유일).
//   base_hash 칼럼(접두 없는 해시)을 article_hash 에 저장해 범위 밖과 대조한다.
//   경계 ① 이미 접두 붙어 적재된 행(X)과 같은 base 가 이번에 새로 생기면 → X 도 접두를 뗀다(hashFlip*: text_hash=base_hash,
//          prefixed=false, 구 해시의 embed_queue 항목 삭제 — 구 접두 벡터는 고아가 되어 _cleanup_orphans 대상). 신규 행은 base 해시.
//   경계 ② 반대(공유였던 base 가 삭제·교체로 1건만 남음) → 남은 행을 «다시 접두 붙이지 않는다»(단조 규칙: 접두는 떼기만 한다.
//          다시 붙이면 새 임베딩이 필요하고 델타마다 해시가 요동친다). 완전 정규화는 full 재적재에서만 일어난다.
// 🔴 2026-10-07 접두 정책: 기본은 «전역 유일 청크에만»(unique) 이고, **단체협약(ca)만 항상(always)** 붙인다.
//   근거(리허설 `docs/reports/2026-10-07_rehearsal_prefix_result.md`): 단협은 기관마다 같은 문구라 unique 에서는 접두가 거의 안 붙어
//   «기관명이 든 질의»가 다른 기관 사본에 밀린다(hit@1 always−unique +18%p·p=0.002·MRR +0.17). 공시·내규·법령은 always 의 추가 이득이 작거나 없다.
//   PREFIX_ALWAYS_CORPORA="" 로 끄면 종전(unique-only) 동작. 바꾸면 해시가 달라지므로 전량 임베딩 전에 확정한다.
const ALWAYS_CORPORA = (process.env.PREFIX_ALWAYS_CORPORA ?? 'ca').split(',').map(x => x.trim()).filter(Boolean);
if (ALWAYS_CORPORA.some(x => !/^[a-z_]+$/.test(x))) { console.error('PREFIX_ALWAYS_CORPORA 형식 오류: ' + ALWAYS_CORPORA.join(',')); process.exit(2); }
const ALWAYS_LIST = ALWAYS_CORPORA.map(x => `'${x}'`).join(',');
const PREFIX_EXPR = ALWAYS_CORPORA.length ? `(u.is_unique OR d.corpus IN (${ALWAYS_LIST}))` : 'u.is_unique';
function baseCte(whereClause) {
  return `base AS (
      SELECT a.id,
             md5(alio_embed_text(a.title, a.body, i.inst_name, d.doc_title, a.chapter, a.section, NULL, false)) AS bh
      FROM articles a
      JOIN documents d ON d.doc_id = a.doc_id
      LEFT JOIN institutions i ON i.inst_code = d.inst_code
      ${whereClause}
    )`;
}
function hashInsertSql(whereClause) {
  return `
    WITH ${baseCte(whereClause)}, cnt AS (
      SELECT bh, COUNT(*) AS n FROM base GROUP BY bh
    ), ext AS (
      SELECT ah.base_hash AS bh, COUNT(*) AS n FROM article_hash ah
      WHERE ah.base_hash IN (SELECT bh FROM cnt) AND NOT EXISTS (SELECT 1 FROM base b2 WHERE b2.id = ah.id)
      GROUP BY ah.base_hash
    ), uniq AS (
      SELECT c.bh, (c.n + COALESCE(e.n, 0)) = 1 AS is_unique FROM cnt c LEFT JOIN ext e ON e.bh = c.bh
    )
    INSERT INTO article_hash (id, text_hash, prefixed, base_hash)
    SELECT b.id,
           md5(alio_embed_text(a.title, a.body, i.inst_name, d.doc_title, a.chapter, a.section, NULL, ${PREFIX_EXPR})),
           ${PREFIX_EXPR}, b.bh
    FROM base b
    JOIN uniq u ON u.bh = b.bh
    JOIN articles a ON a.id = b.id
    JOIN documents d ON d.doc_id = a.doc_id
    LEFT JOIN institutions i ON i.inst_code = d.inst_code
    ON CONFLICT (id) DO NOTHING`;
}
// 범위 «밖» 에서 접두를 달고 있는데 이번 범위에 같은 base 가 생긴 행 → 접두를 뗀다(경계 ①)
const FLIP_COND = `ah.prefixed AND ah.base_hash IN (SELECT bh FROM base) AND NOT EXISTS (SELECT 1 FROM base b WHERE b.id = ah.id)` +
  (ALWAYS_CORPORA.length ? ` AND NOT EXISTS (SELECT 1 FROM articles fa JOIN documents fd ON fd.doc_id = fa.doc_id WHERE fa.id = ah.id AND fd.corpus IN (${ALWAYS_LIST}))` : '');
const hashFlipSelectSql = w => `WITH ${baseCte(w)} SELECT ah.id, ah.text_hash AS old_hash FROM article_hash ah WHERE ${FLIP_COND}`;
const hashFlipUpdateSql = w => `WITH ${baseCte(w)} UPDATE article_hash SET text_hash = base_hash, prefixed = false
    WHERE id IN (SELECT ah.id FROM article_hash ah WHERE ${FLIP_COND})`;
// 세 경로 공용: 해시 삽입 → 접두 떼기 → 구 해시의 embed_queue 항목 삭제. embed_queue 신규 항목은 호출자가 이어서 채운다.
async function hashStep(c, whereClause, params) {
  const inserted = (await c.query(hashInsertSql(whereClause), params)).rowCount;
  // 범위가 «전부»(where 없음)면 범위 밖 행이 없어 접두를 뗄 대상도 없다 — base 재계산(수백만 md5)을 아낀다.
  const old = whereClause ? (await c.query(hashFlipSelectSql(whereClause), params)).rows.map(r => r.old_hash) : [];
  if (old.length) {
    await c.query(hashFlipUpdateSql(whereClause), params);
    await c.query('DELETE FROM embed_queue WHERE text_hash = ANY($1)', [old]);
  }
  return { inserted, flipped: old.length };
}

// ── institutions 배치 upsert (2026-08-02) ────────────────────────────────────
// 종전엔 **문서 1건당 쿼리 1회**였다. disclosure append에서 155,113회 왕복이 발생했고
// 실제 기관은 355개뿐이다(0.23%). 중복 제거 후 한 번에 넣는다.
// ⚠️ ON CONFLICT DO NOTHING 이므로 기존 행은 건드리지 않는다 — 종전 동작과 동일하다.
// ── 기존 DB 대비 멱등 컬럼 보강 (2026-08-02) ──────────────────────────────────
// ⚠️ 이 보강이 append 경로에만 있었다. `CREATE TABLE IF NOT EXISTS`는 **테이블이 이미 있으면
//    컬럼을 추가하지 않는다** — 운영 DB에는 아래 6개가 전부 없어서(실측) full만 돌리면
//    documents INSERT가 "column ... does not exist"로 즉사한다.
//    스크래치 DB는 매번 새로 만들기 때문에 E2E 게이트가 이 사각을 못 본다.
//    세 경로(full·append·delta)가 같은 함수를 쓰게 해서 다시는 갈리지 않게 한다.
async function ensureColumns(c) {
  // 부수 테이블부터 보장한다. full 경로는 이 테이블들을 파일 끝에서 만들었는데,
  // 컬럼 보강을 앞으로 당기니 `relation "article_hash" does not exist`로 터졌다(게이트가 잡음).
  await c.query(`CREATE TABLE IF NOT EXISTS article_hash (id bigint PRIMARY KEY, text_hash text NOT NULL, prefixed boolean NOT NULL DEFAULT false, base_hash text)`);
  await c.query(`CREATE TABLE IF NOT EXISTS embed_queue (text_hash text PRIMARY KEY, id bigint NOT NULL)`);
  await c.query(`CREATE TABLE IF NOT EXISTS article_embeddings (
    text_hash  text PRIMARY KEY,
    embedding  vector(1024) NOT NULL,
    model      text NOT NULL DEFAULT 'baai/bge-m3',   -- 종전 기본값(구 NVIDIA 모델명)이 남아 있었다
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await c.query(`ALTER TABLE article_hash ADD COLUMN IF NOT EXISTS prefixed boolean NOT NULL DEFAULT false`);
  await c.query(`ALTER TABLE article_hash ADD COLUMN IF NOT EXISTS base_hash text`);   // 접두 없는 해시 — 전역 유일 판정용(2026-10-06)
  await c.query(`CREATE INDEX IF NOT EXISTS idx_article_hash_base ON article_hash (base_hash)`);
  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS meta jsonb`);
  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_chars int`);
  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS covered_chars int`);
  // 회차 구분 경로 도입으로 파서가 분기를 알아낸다. 컬럼이 없으면 또 조용히 버려진다.
  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS period_quarter text`);
  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS parser_ver text`);
  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS converted_at timestamptz`);
  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS ocr_kind text`);
  await c.query(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS "off" int[]`);
  // 🔴 «이미 존재하는» DB 에는 CREATE TABLE 이 컬럼을 추가하지 않는다 — 여기서도 보강한다.
  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS usecases text[]`);
  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS usecases_source text`);
  // ── 적재 설계 v1(2026-10-06): 감사·앵커 칼럼 — 전부 NULL 허용, 응답에 노출하지 않는다 ──
  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS body_md5 text`);
  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS src_md5 text`);
  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS origin text`);
  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS anchor_level text`);
  await c.query(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS art_key text`);
  // (doc_id, art_key) 유일 — INDEXES 목록에 넣지 않는다(full 경로가 INDEXES 를 전부 DROP 하는데, 이건 적재 «중» 에도 살아 있어야 중복을 즉시 잡는다).
  //   기존 행(art_key NULL)은 유일성 대상이 아니다(NULL 은 서로 다르다).
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_articles_doc_art_key ON articles (doc_id, art_key)`);
  await c.query(`ALTER TABLE load_runs ADD COLUMN IF NOT EXISTS code_rev text`);
  await c.query(`ALTER TABLE load_runs ADD COLUMN IF NOT EXISTS embed_spec text`);
  // 앵커 조회용 내부 뷰 — 연결 테이블이 (doc_id, art_key, 연결 시점 body_md5·text_hash) 와 대조해 낡음을 찾는다. API/MCP 는 쓰지 않는다.
  await c.query(`CREATE OR REPLACE VIEW v_article_anchor AS
    SELECT a.doc_id, a.art_key, d.anchor_level, d.body_md5, ah.text_hash
    FROM articles a JOIN documents d ON d.doc_id = a.doc_id LEFT JOIN article_hash ah ON ah.id = a.id`);
}

async function upsertInstitutionsBatch(c, rows) {
  const m = new Map();
  for (const d of rows) if (d.inst_code && !m.has(d.inst_code)) m.set(d.inst_code, [d.inst_code, d.inst_name ?? null, d.ministry ?? null]);
  if (!m.size) return 0;
  const v = [...m.values()];
  await c.query(
    `INSERT INTO institutions (inst_code, inst_name, ministry)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) ON CONFLICT DO NOTHING`,
    [v.map(x => x[0]), v.map(x => x[1]), v.map(x => x[2])]);
  return m.size;
}

// ── documents/articles INSERT — 세 경로(full·append·delta)가 같은 정의를 쓴다(종전엔 3곳에 복제돼 «한 곳만 고치면 적재 즉사» 였다) ──
const DOC_COLS = 'doc_id,corpus,rel_path,inst_code,category,doc_title,doc_type,doc_date,n_articles,coverage,parse_status,meta,content_chars,covered_chars,period_quarter,parser_ver,converted_at,ocr_kind,body_md5,src_md5,origin,anchor_level';
const DOC_TYPES = ['text','text','text','text','text','text','text','text','int','real','text','jsonb','int','int','text','text','timestamptz','text','text','text','text','text'];
const docInsertSql = (by, runId) => `INSERT INTO documents (${DOC_COLS},created_by,load_run_id)
        SELECT u.*, '${by}'::text, ${runId}::bigint FROM unnest(${DOC_TYPES.map((t, i) => `$${i + 1}::${t}[]`).join(',')}) AS u`;
function docRow(d, docLevel) {
  const lv = anchorLevel(d);
  if (lv === 'document') docLevel.add(d.doc_id);
  return [d.doc_id, d.corpus, d.rel_path, d.inst_code, d.category, d.doc_title, d.doc_type, d.doc_date, d.n_articles, d.coverage, d.parse_status,
    d.meta ? JSON.stringify(d.meta) : null, d.content_chars, d.covered_chars, d.period_quarter, d.parser_ver, d.converted_at, d.ocr_kind,
    d.body_md5, d.src_md5, d.origin, lv];
}
const artInsertSql = (by, runId) => `INSERT INTO articles (doc_id,seq,section,chapter,art_no,art_sub,title,body,n_chars,"off",art_key,created_by,load_run_id)
        SELECT u.c1,u.c2,u.c3,u.c4,u.c5,u.c6,u.c7,u.c8,u.c9,u.c10::int[],u.c11, '${by}'::text, ${runId}::bigint FROM unnest($1::text[],$2::int[],$3::text[],$4::text[],$5::int[],$6::int[],$7::text[],$8::text[],$9::int[],$10::text[],$11::text[]) AS u(c1,c2,c3,c4,c5,c6,c7,c8,c9,c10,c11)`;
// 스테이징 조문 → [행 배열]. art_key 부여 + 빈 본문 조문 제외(거부 로그). 빈 본문은 «내용 없는 벡터»가 되므로 적재하지 않는다.
async function* loadableArticles(file, docLevel, blankLog) {
  for await (const { a, key } of keyedArticles(jsonlLines(file), id => (docLevel.has(id) ? 'document' : 'article'))) {
    if (!String(a.text == null ? '' : a.text).trim()) { blankLog.write([a.doc_id, a.seq, key]); continue; }
    yield [a.doc_id, a.seq, a.section, a.chapter, a.art_no, a.art_sub, a.title, a.text, a.n_chars, offLit(a.off), key];
  }
}

// ── 적재 전 게이트(load_gate.js) 글루 ──────────────────────────────────────────
//  LOAD_GATE=off 면 전부 건너뜀(리허설용). EXPECT_UNIQUE(고유 해시 수 사전 산정값)·EXPECT_UNIQUE_TOL(기본 0.05).
//  full(TRUNCATE) 은 EXPECT_UNIQUE 필수 — DB 를 건드리기 «전에» 중단한다.
//  delta 는 EXPECT_UNIQUE 를 거부한다(전역 embed_queue 건수와 비교되어 무의미 — 2026-10-06 코드 리뷰 #5).
const GATE_OFF = process.env.LOAD_GATE === 'off';
const EXPECT = parseInt(process.env.EXPECT_UNIQUE || '0', 10);
const GATE_DIR = process.env.GATE_OUT_DIR || path.join(ROOT, 'ops', 'logs', 'load_gate_' + new Date().toISOString().replace(/[:.]/g, '-'));
async function gateStart(mode, corpora, dir) {
  if (GATE_OFF) { console.log('[GATE] LOAD_GATE=off — 게이트 건너뜀'); return { chunker: 'gate-off' }; }
  if (mode === 'full' && !EXPECT) { console.error('[GATE] full(TRUNCATE) 적재는 EXPECT_UNIQUE=<고유 해시 수 사전 산정값> 필수(리허설은 LOAD_GATE=off)'); process.exit(2); }
  if (mode === 'delta' && EXPECT) { console.error('[GATE] delta 에서는 EXPECT_UNIQUE 를 쓸 수 없다 — 이 검사는 «DB 전역 embed_queue 건수»와 비교하므로 변경분 적재에는 의미가 없다. 환경변수를 제거할 것(일일 증분은 EXPECT_UNIQUE 불필요)'); process.exit(2); }
  const rep = await gate.scanStaging(dir, corpora, GATE_DIR);
  for (const [co, st] of Object.entries(rep.corpora))
    console.log(`[GATE] ${co}: 문서 ${st.docs} · 청크0 ${st.zero_chunk} (${(st.zero_ratio * 100).toFixed(1)}%) · truncated ${st.truncated} · low_coverage ${st.low_coverage} · 제외 ${st.excluded}`);
  console.log(`[GATE] chunker=${rep.chunker}${rep.ruleset.missing.length ? ' (ruleset 미기록: ' + rep.ruleset.missing.join(',') + ')' : ''} · 거부 로그 ${GATE_DIR}`);
  if (rep.problems.length) throw new Error('[GATE] ' + rep.problems.join(' / '));
  return rep;
}
// append/delta: 같은 DB 에 이미 다른 «해시 정의»로 적재된 게 있으면 섞지 않는다(컷·접두·청커·차원 비교).
// 기준 = «성공 완료한»(finished_at) 가장 최근 실행 — load_runs INSERT 는 트랜잭션 밖이라 실패·롤백한 실행의 행도 남는다.
async function gateSpec(c, spec) {
  if (GATE_OFF) return;
  const prev = (await c.query(`SELECT embed_spec FROM load_runs WHERE embed_spec IS NOT NULL AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`)).rows[0];
  if (!prev) return;
  const r = gate.specCompatible(prev.embed_spec, spec);
  if (!r.ok) throw new Error(`[GATE] embed_spec 불일치(${r.diff.join(',')}): 이전 ${prev.embed_spec} ≠ 이번 ${spec}`);
}
// append/delta: base_hash 가 NULL 인 article_hash 행(칼럼 추가 전에 적재된 행)이 있으면 거부 — 접두 «전역 유일 판정»(범위 밖 base_hash 대조)이 그 행들을 «없는 것»으로 봐서 깨진다.
// full 은 TRUNCATE 후 전부 새로 만들므로 해당 없음. LOAD_GATE=off(리허설)는 건너뜀. idx_article_hash_base 로 IS NULL 조회(btree 는 NULL 도 색인).
async function gateBaseHash(c) {
  if (GATE_OFF) return;
  if ((await c.query(`SELECT 1 FROM article_hash WHERE base_hash IS NULL LIMIT 1`)).rowCount)
    throw new Error('[GATE] article_hash 에 base_hash 미백필 행이 있다 — full 재적재 또는 base_hash 백필 후 실행(append/delta 의 접두 전역 유일 판정이 깨진다)');
}
// 해시·대기열을 채운 «뒤» 트랜잭션 안에서 호출 — 실패하면 던져서 롤백.
async function gateUnique(c, whereClause, params) {
  const n = +(await c.query('SELECT count(*) n FROM embed_queue')).rows[0].n;
  // 컷(EMBED_CUT)으로 «잘려 임베딩되는» 청크 목록 — 제목+본문만으로 이미 컷을 넘는 것(접두는 더 얹힌다). 거부가 아니라 알림.
  const log = gate.openRejectLog(GATE_DIR, 'cut_truncated_chunks.tsv', ['doc_id', 'art_key', 'n_chars']);
  const r = await c.query(`SELECT a.doc_id, a.art_key, a.n_chars FROM articles a ${whereClause}
      ${whereClause ? 'AND' : 'WHERE'} char_length(coalesce(a.title,'')) + 1 + char_length(a.body) > ${EMBED_CUT}`, params);
  for (const x of r.rows) log.write([x.doc_id, x.art_key, x.n_chars]);
  await log.end();
  console.log(`[GATE] 고유 해시(embed_queue) ${n.toLocaleString()} · 컷(${EMBED_CUT}자) 초과 청크 ${r.rowCount}`);
  if (GATE_OFF || !EXPECT) { if (!GATE_OFF) console.log('[GATE] EXPECT_UNIQUE 없음 — 고유 해시 수 검사 생략'); return n; }
  const k = gate.checkUnique(n, EXPECT, parseFloat(process.env.EXPECT_UNIQUE_TOL || '0.05'));
  console.log(`[GATE] 기대 ${EXPECT.toLocaleString()} (허용 ${k.lo.toLocaleString()}~${k.hi.toLocaleString()}) · 실제/기대 ${k.ratio}`);
  if (!k.ok) throw new Error(`[GATE] 고유 해시 수 ${n} 가 기대 ${EXPECT} 의 허용 범위 밖 — 롤백. 스테이징·청커·컷을 확인하라`);
  return n;
}

async function appendCorpus(co) {
  const rep = await gateStart('append', [co], STAGING);   // DB 를 건드리기 전에 스테이징 점검·거부 로그
  const env = loadEnv();
  const c = new Client({
    host: process.env.ALIO_PGHOST || env.PGHOST || 'postgres', port: +(env.PGPORT || 5432),
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: DB,
  });
  await c.connect();
  await c.query(SCHEMA);
  // ⚠️ INDEXES보다 먼저여야 한다 — 기존 DB엔 CREATE TABLE이 컬럼을 안 붙이므로
  //    usecases 등 신규 컬럼 없이 GIN 인덱스를 걸면 42703으로 즉사한다(레드팀 재현, 2026-09-20).
  await ensureColumns(c);
  for (const sql of INDEXES) await c.query(sql);

  // 적재 실행 이력 시작(감사) — code_rev·embed_spec(해시 정의 한 줄)을 같이 남긴다
  const spec = embedSpecString({ chunker: rep.chunker });
  await gateSpec(c, spec);
  await gateBaseHash(c);
  const runId = (await c.query(
    `INSERT INTO load_runs (script, mode, corpus, code_rev, embed_spec) VALUES ('load_pg', 'append', $1, $2, $3) RETURNING id`,
    [co, gate.codeRev(ROOT), spec])).rows[0].id;
  const BY = 'load_pg@append';
  // 삭제→재적재→게이트를 한 트랜잭션으로: 게이트 실패·오류 시 기존 코퍼스가 그대로 남는다(프로세스가 죽어도 연결 종료로 롤백).
  await c.query('BEGIN');
  const docLevel = new Set();
  const blankLog = gate.openRejectLog(GATE_DIR, 'blank_body_articles.tsv', ['doc_id', 'seq', 'art_key']);

  // 재실행 안전: 이 코퍼스 기존 데이터 제거 후 재적재 (조문 코퍼스는 불변)
  await c.query(`DELETE FROM article_hash ah USING articles a WHERE ah.id=a.id AND a.doc_id LIKE $1`, [co + ':%']);
  await c.query(`DELETE FROM articles WHERE doc_id LIKE $1`, [co + ':%']);
  await c.query(`DELETE FROM documents WHERE doc_id LIKE $1`, [co + ':%']);

  // institutions upsert — 문서 수가 아니라 **기관 수**만큼만 왕복한다(종전 155,113회 → 355회)
  { const buf = [];
    for await (const d of jsonlLines(path.join(STAGING, `docs_${co}.jsonl`))) if (d.inst_code) buf.push(d);
    const n = await upsertInstitutionsBatch(c, buf);
    console.log(`institutions(${co}): 고유 ${n}개 (문서 ${buf.length}건에서)`); }

  // documents
  let nDocs = 0;
  { const cols = DOC_TYPES.map(() => []);
    const flush = async () => { if (!cols[0].length) return;
      await c.query(docInsertSql(BY, runId), cols);
      cols.forEach(a => a.length = 0); };
    for await (const d of jsonlLines(path.join(STAGING, `docs_${co}.jsonl`))) {
      docRow(d, docLevel).forEach((v, i) => cols[i].push(v ?? null));
      if (++nDocs % BATCH === 0) await flush();
    }
    await flush(); }
  console.log(`documents(${co}):`, nDocs);

  // articles
  let nArts = 0;
  { const cols = Array.from({ length: 11 }, () => []);
    const flush = async () => { if (!cols[0].length) return;
      await c.query(artInsertSql(BY, runId), cols);
      cols.forEach(a => a.length = 0); };
    for await (const row of loadableArticles(path.join(STAGING, `articles_${co}.jsonl`), docLevel, blankLog)) {
      row.forEach((v, i) => cols[i].push(v ?? null));
      if (++nArts % BATCH === 0) await flush();
      if (nArts % 200000 === 0) console.log('  articles...', nArts);
    }
    await flush(); }
  console.log(`articles(${co}):`, nArts);

  // article_hash / embed_queue — 이 코퍼스 신규 행만.
  // text_hash = md5( (title? title||E'\n' : '') || left(body,4000) )  ← embed_articles.js 입력과 동일
  // 2패스 해시(2026-08-01): ① 접두 없는 base 텍스트로 중복 여부 판정 →
  //   ② 고유(1건)면 문맥 접두를 붙인 텍스트로, 공유면 base 그대로 최종 해시.
  //   embed_articles가 같은 판정을 재현할 필요가 없도록 prefixed 플래그를 저장한다.
  await ensureColumns(c);
  const hs = await hashStep(c, 'WHERE a.doc_id LIKE $1', [co + ':%']);   // 접두 적용(전역 유일 판정·공용)
  console.log(`article_hash: 신규 ${hs.inserted} · 접두 뗌(기존 행) ${hs.flipped}`);
  const eq = await c.query(`
    INSERT INTO embed_queue (text_hash, id)
    SELECT DISTINCT ON (ah.text_hash) ah.text_hash, ah.id
    FROM article_hash ah JOIN articles a ON a.id=ah.id
    WHERE a.doc_id LIKE $1
    ON CONFLICT (text_hash) DO NOTHING`, [co + ':%']);
  console.log(`embed_queue 신규:`, eq.rowCount);
  await blankLog.end();
  if (blankLog.n) console.log(`[GATE] 빈 본문 조문 ${blankLog.n}건 제외 → blank_body_articles.tsv`);
  await gateUnique(c, 'WHERE a.doc_id LIKE $1', [co + ':%']);   // 실패하면 던진다 → BEGIN 이후 전부 롤백
  await c.query('COMMIT');
  // 성공 완료 표시 — COMMIT «직후». gateSpec 은 finished_at 이 있는 실행만 기준으로 삼는다(실패·롤백한 실행의 spec 이 기준이 되지 않게). 뒤의 ANALYZE·인덱스가 실패해도 커밋된 적재는 «완료».
  await c.query(`UPDATE load_runs SET finished_at=now(), n_docs=$1, n_articles=$2 WHERE id=$3`, [nDocs, nArts, runId]);

  await c.query('ANALYZE articles, documents');
  const s = await c.query(`SELECT (SELECT count(*) FROM documents WHERE corpus=$1) d,
    (SELECT count(*) FROM articles a JOIN documents dd USING(doc_id) WHERE dd.corpus=$1) a,
    (SELECT count(*) FROM embed_queue) q, (SELECT count(*) FROM article_embeddings) e,
    pg_size_pretty(pg_database_size('${DB}')) size`, [co]);
  console.log('append 완료:', JSON.stringify(s.rows[0]), `(load_run ${runId})`);
  await c.end();
}

// ── delta 모드: 스테이징에 있는 doc_id만 정확히 교체(다른 문서 불가침) ─────────
//   수시 증분(recruit) 전용. parse_disclosure --under <cat> --out <dir> 부분 스테이징을 받아
//   그 doc_id들만 삭제→재삽입 + 신규 해시만 embed_queue. append(전체 코퍼스 교체)와 달리 범위 한정.
async function appendCorpusDelta(co, stagingDir) {
  const dir = stagingDir || STAGING;
  const dry = process.argv.includes('--dry-run');
  const rep = dry ? { chunker: 'dry-run' } : await gateStart('delta', [co], dir);
  const ids = [];
  for await (const d of jsonlLines(path.join(dir, `docs_${co}.jsonl`))) ids.push(d.doc_id);
  if (!ids.length) { console.log(`delta(${co}): 스테이징 문서 0건 — 변경 없음`); return; }
  // 안전장치: 전 doc_id가 'co:' 접두라야 함(범위 이탈 삭제 방지)
  const bad = ids.filter(id => !String(id).startsWith(co + ':'));
  if (bad.length) throw new Error(`delta(${co}): 접두 불일치 ${bad.length}건 — 중단(예: ${bad[0]})`);
  console.log(`delta(${co}): 대상 문서 ${ids.length}건${dry ? ' [DRY-RUN]' : ''}`);

  const env = loadEnv();
  const c = new Client({ host: process.env.ALIO_PGHOST || env.PGHOST || 'postgres', port: +(env.PGPORT || 5432),
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: DB });
  await c.connect();
  if (dry) {
    const d = (await c.query(`SELECT count(*) n FROM documents WHERE doc_id = ANY($1)`, [ids])).rows[0].n;
    const a = (await c.query(`SELECT count(*) n FROM articles  WHERE doc_id = ANY($1)`, [ids])).rows[0].n;
    console.log(`  [DRY] 기존 매칭 documents ${d} · articles ${a} → 이 doc_id들만 삭제 후 재삽입 예정(다른 공시 무영향)`);
    await c.end(); return;
  }
  await c.query(SCHEMA);
  // ⚠️ article_embeddings는 어느 스크립트에도 생성문이 없어 **수동 생성에 의존**하고 있었다.
  //    운영 DB엔 있으니 재적재는 통과하지만, 신규 DB에서는 append가
  //    'relation "article_embeddings" does not exist'로 죽는다(2026-08-02 E2E에서 검출).
  //    재해복구·검증이 불가능해지므로 여기서 보장한다. HNSW 인덱스는 만들지 않는다 — 24시간짜리라
  //    암묵적으로 걸면 안 되고, 드롭 여부는 신규 벡터 수를 보고 사람이 정한다.
  // ⚠️ 기존 DB 대비 멱등 보강 — prefixed 추가가 appendCorpus 안에만 있어서
  //    full 경로만 돌면 컬럼이 없고 embed_articles(ah.prefixed)가 즉시 실패했다(2026-08-02 실측).
  await ensureColumns(c);
  const spec = embedSpecString({ chunker: rep.chunker });
  await gateSpec(c, spec);
  await gateBaseHash(c);
  const runId = (await c.query(`INSERT INTO load_runs (script, mode, corpus, code_rev, embed_spec) VALUES ('load_pg','delta',$1,$2,$3) RETURNING id`,
    [co, gate.codeRev(ROOT), spec])).rows[0].id;
  const BY = 'load_pg@delta';
  const docLevel = new Set();
  const blankLog = gate.openRejectLog(GATE_DIR, 'blank_body_articles.tsv', ['doc_id', 'seq', 'art_key']);
  await c.query('BEGIN');
  try {
    await c.query(`DELETE FROM article_hash ah USING articles a WHERE ah.id=a.id AND a.doc_id = ANY($1)`, [ids]);
    await c.query(`DELETE FROM articles  WHERE doc_id = ANY($1)`, [ids]);
    await c.query(`DELETE FROM documents WHERE doc_id = ANY($1)`, [ids]);
    { const buf = [];
      for await (const d of jsonlLines(path.join(dir, `docs_${co}.jsonl`))) if (d.inst_code) buf.push(d);
      await upsertInstitutionsBatch(c, buf); }
    let nDocs = 0; { const cols = DOC_TYPES.map(() => []);
      const flush = async () => { if (!cols[0].length) return;
        await c.query(docInsertSql(BY, runId), cols);
        cols.forEach(a => a.length = 0); };
      for await (const d of jsonlLines(path.join(dir, `docs_${co}.jsonl`))) {
        docRow(d, docLevel).forEach((v,i)=>cols[i].push(v??null));
        if (++nDocs % BATCH === 0) await flush(); }
      await flush(); }
    let nArts = 0; { const cols = Array.from({ length: 11 }, () => []);
      const flush = async () => { if (!cols[0].length) return;
        await c.query(artInsertSql(BY, runId), cols);
        cols.forEach(a => a.length = 0); };
      for await (const row of loadableArticles(path.join(dir, `articles_${co}.jsonl`), docLevel, blankLog)) {
        row.forEach((v,i)=>cols[i].push(v??null));
        if (++nArts % BATCH === 0) await flush(); }
      await flush(); }
    const hs = await hashStep(c, 'WHERE a.doc_id = ANY($1)', [ids]);   // 접두 적용(전역 유일 판정)
    console.log(`article_hash: 신규 ${hs.inserted} · 접두 뗌(기존 행) ${hs.flipped}`);
    const eq = await c.query(`INSERT INTO embed_queue (text_hash, id)
      SELECT DISTINCT ON (ah.text_hash) ah.text_hash, ah.id FROM article_hash ah JOIN articles a ON a.id=ah.id
      WHERE a.doc_id = ANY($1) ON CONFLICT (text_hash) DO NOTHING`, [ids]);
    await blankLog.end();
    if (blankLog.n) console.log(`[GATE] 빈 본문 조문 ${blankLog.n}건 제외 → blank_body_articles.tsv`);
    await gateUnique(c, 'WHERE a.doc_id = ANY($1)', [ids]);   // EXPECT_UNIQUE 가 있으면 검사 — 실패하면 catch 에서 ROLLBACK
    await c.query('COMMIT');
    // 성공 완료 표시 — COMMIT «직후». gateSpec 은 finished_at 이 있는 실행만 기준으로 삼는다(실패·롤백한 실행의 spec 이 기준이 되지 않게). 뒤의 ANALYZE·인덱스가 실패해도 커밋된 적재는 «완료».
    await c.query(`UPDATE load_runs SET finished_at=now(), n_docs=$1, n_articles=$2 WHERE id=$3`, [nDocs, nArts, runId]);
    await c.query('ANALYZE articles, documents');
    console.log(`delta(${co}) 완료: documents ${nDocs} · articles ${nArts} · embed_queue 신규 ${eq.rowCount} (load_run ${runId})`);
  } catch (e) { await c.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { await c.end(); }
}

async function main() {
  const appendIdx = process.argv.indexOf('--append');
  if (appendIdx >= 0) { await appendCorpus(process.argv[appendIdx + 1]); return; }
  const deltaIdx = process.argv.indexOf('--delta');
  if (deltaIdx >= 0) {
    const si = process.argv.indexOf('--staging');
    await appendCorpusDelta(process.argv[deltaIdx + 1], si >= 0 ? process.argv[si + 1] : undefined);
    return;
  }

  const rep = await gateStart('full', CORPORA, STAGING);   // TRUNCATE «이전»에 스테이징 점검 — EXPECT_UNIQUE 없으면 여기서 중단
  const env = loadEnv();
  const c = new Client({
    host: process.env.ALIO_PGHOST || env.PGHOST || 'postgres', port: +(env.PGPORT || 5432),
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: DB,
  });
  await c.connect();
  await c.query(SCHEMA);
  // ⚠️ 컬럼 보강은 **INSERT보다 먼저**여야 한다. 종전엔 이 호출이 파일 끝(article_hash 절)에 있어서
  //    기존 DB에 full을 돌리면 documents INSERT가 먼저 터졌다(E2E 게이트가 재현해 잡음, 2026-08-02).
  //    (2026-10-06: load_runs 에 code_rev·embed_spec 칼럼이 생겨 load_runs INSERT 보다도 앞서야 한다)
  await ensureColumns(c);
  const spec = embedSpecString({ chunker: rep.chunker });
  const runId = (await c.query(
    `INSERT INTO load_runs (script, mode, corpus, code_rev, embed_spec) VALUES ('load_pg', 'full', $1, $2, $3) RETURNING id`,
    [CORPORA.join(','), gate.codeRev(ROOT), spec])).rows[0].id;
  const BY = 'load_pg@full';
  await c.query('TRUNCATE articles, documents, institutions CASCADE');

  // TRUNCATE는 인덱스를 남긴다 — 이후 250만 행 INSERT 내내 GIN 8개를 갱신하게 된다.
  // 어차피 아래 4)에서 전부 다시 만드므로(CREATE INDEX IF NOT EXISTS) 여기서 떨군다.
  // 특히 idx_articles_body_trgm은 2,227MB짜리라 유지비가 크다.
  // ⚠️ append/delta 경로에서는 절대 하지 않는다 — 거기선 기존 데이터가 살아 있고 검색이 돌아간다.
  for (const sql of INDEXES) {
    const name = sql.match(/idx_\w+/)[0];
    await c.query(`DROP INDEX IF EXISTS ${name}`);
  }
  // 은퇴한 인덱스 — INDEXES 에서 빠졌으므로 위 루프가 안 지운다. 남겨두면 2,227MB 를 그냥 먹는다.
  //   idx_articles_body_trgm : 2026-09-19 bigm(lower(body)) 으로 교체
  await c.query('DROP INDEX IF EXISTS idx_articles_body_trgm');

  // 1) institutions — docs_* 에서 유도
  const insts = new Map();
  for (const co of CORPORA) {
    for await (const d of jsonlLines(path.join(STAGING, `docs_${co}.jsonl`))) {
      if (d.inst_code && !insts.has(d.inst_code)) insts.set(d.inst_code, [d.inst_code, d.inst_name, d.ministry]);
    }
  }
  for (const [code, name, min] of insts.values()) {
    await c.query('INSERT INTO institutions (inst_code, inst_name, ministry) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [code, name, min]);
  }
  console.log('institutions:', insts.size);

  // 2) documents — 🔴 2026-10-06: BEGIN 이후 «documents→articles→해시→대기열→게이트» 까지 한 트랜잭션(인덱스는 COMMIT 뒤).
  //    게이트(고유 해시 수 ±5%) 실패 시 롤백 — TRUNCATE 는 위에서 이미 커밋됐으므로 실패 후 상태는 «빈 테이블»(재실행 가능).
  await c.query('BEGIN');
  const docLevel = new Set();
  const blankLog = gate.openRejectLog(GATE_DIR, 'blank_body_articles.tsv', ['doc_id', 'seq', 'art_key']);
  let nDocs = 0;
  for (const co of CORPORA) {
    const cols = DOC_TYPES.map(() => []);   // 22 = 기존11 + meta·content_chars·covered_chars·period_quarter + 감사 3(parser_ver·converted_at·ocr_kind) + body_md5·src_md5·origin·anchor_level
    const flush = async () => {
      if (!cols[0].length) return;
      await c.query(docInsertSql(BY, runId), cols);
      cols.forEach(a => a.length = 0);
    };
    for await (const d of jsonlLines(path.join(STAGING, `docs_${co}.jsonl`))) {
      docRow(d, docLevel).forEach((v, i) => cols[i].push(v ?? null));
      nDocs++;
      if (cols[0].length >= BATCH) await flush();
    }
    await flush();
  }
  console.log('documents:', nDocs);

  // 3) articles
  let nArts = 0;
  for (const co of CORPORA) {
    const cols = Array.from({ length: 11 }, () => []);   // 11 = 기존9 + off + art_key
    const flush = async () => {
      if (!cols[0].length) return;
      await c.query(artInsertSql(BY, runId), cols);
      cols.forEach(a => a.length = 0);
    };
    for await (const row of loadableArticles(path.join(STAGING, `articles_${co}.jsonl`), docLevel, blankLog)) {
      row.forEach((v, i) => cols[i].push(v ?? null));
      nArts++;
      if (cols[0].length >= BATCH) await flush();
      if (nArts % 200000 === 0) console.log('  articles...', nArts);
    }
    await flush();
    console.log(`articles(${co}) 누적:`, nArts);
  }

  // 4) article_hash / embed_queue — full 경로도 반드시 채운다.
  //    (2026-07-18 사고: append만 채우던 탓에 TRUNCATE 재적재분 137만 조문이
  //     의미검색 조인(articles→article_hash→embeddings)에서 통째로 빠졌음)
  // ⚠️ article_embeddings는 어느 스크립트에도 생성문이 없어 **수동 생성에 의존**하고 있었다.
  //    운영 DB엔 있으니 재적재는 통과하지만, 신규 DB에서는 append가
  //    'relation "article_embeddings" does not exist'로 죽는다(2026-08-02 E2E에서 검출).
  //    재해복구·검증이 불가능해지므로 여기서 보장한다. HNSW 인덱스는 만들지 않는다 — 24시간짜리라
  //    암묵적으로 걸면 안 되고, 드롭 여부는 신규 벡터 수를 보고 사람이 정한다.
  // ⚠️ 기존 DB 대비 멱등 보강 — prefixed 추가가 appendCorpus 안에만 있어서
  //    full 경로만 돌면 컬럼이 없고 embed_articles(ah.prefixed)가 즉시 실패했다(2026-08-02 실측).
  const dh = await c.query(`DELETE FROM article_hash h WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = h.id)`);
  const dq = await c.query(`DELETE FROM embed_queue q WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = q.id)`);
  const ih = await hashStep(c, '', []);   // 전량 — 접두 적용(전역 유일 판정)
  const iq = await c.query(`
    INSERT INTO embed_queue (text_hash, id)
    SELECT DISTINCT ON (h.text_hash) h.text_hash, h.id
    FROM article_hash h
    ON CONFLICT (text_hash) DO NOTHING`);
  console.log(`article_hash: dangling -${dh.rowCount}, 신규 +${ih.inserted} · 접두 뗌 ${ih.flipped} | embed_queue: dangling -${dq.rowCount}, 신규 +${iq.rowCount}`);
  await blankLog.end();
  if (blankLog.n) console.log(`[GATE] 빈 본문 조문 ${blankLog.n}건 제외 → blank_body_articles.tsv`);
  await gateUnique(c, '', []);   // 실패하면 던진다 → 프로세스 종료·연결 종료로 BEGIN 이후 롤백
  await c.query('COMMIT');
  // 성공 완료 표시 — COMMIT «직후». gateSpec 은 finished_at 이 있는 실행만 기준으로 삼는다(실패·롤백한 실행의 spec 이 기준이 되지 않게). 뒤의 ANALYZE·인덱스가 실패해도 커밋된 적재는 «완료».
  await c.query(`UPDATE load_runs SET finished_at=now(), n_docs=$1, n_articles=$2 WHERE id=$3`, [nDocs, nArts, runId]);

  // 5) 인덱스 (COMMIT 뒤 — 종전엔 해시보다 앞이었으나 해시 조인은 PK 만 쓴다)
  for (const sql of INDEXES) {
    const t = Date.now();
    await c.query(sql);
    console.log('인덱스:', sql.match(/idx_\w+/)[0], ((Date.now() - t) / 1000).toFixed(1) + 's');
  }

  await c.query('ANALYZE');

  const s = await c.query(`SELECT (SELECT count(*) FROM institutions) i,
    (SELECT count(*) FROM documents) d, (SELECT count(*) FROM articles) a,
    pg_size_pretty(pg_database_size('${DB}')) size`);
  console.log('완료:', JSON.stringify(s.rows[0]), `(load_run ${runId})`);
  await c.end();
}

main().catch(e => { console.error('실패:', e.message); process.exit(1); });
