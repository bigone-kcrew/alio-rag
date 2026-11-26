# 05. 데이터베이스 활용 기술 상세

> 기준일 2026-11-26. 근거: 운영 DB(`alio_rag`)에 대한 **SELECT 전용** 조회(`information_schema`·`pg_indexes`·`pg_class` 통계·뷰 정의·역할 설정), `src/` 코드. 데이터 값은 인용하지 않고 구조만 적는다. 건수는 별도 표기가 없으면 정확한 `count(*)`가 아니라 통계 추정치(`reltuples`)다.

## 1. 개요

- PostgreSQL **18.6**, 확장: `vector` 0.8.7, `pg_bigm` 1.2, `pg_trgm` 1.6, `pg_prewarm` 1.2.
- DB 하나(`alio_rag`)에 **세 스키마**가 있다.

| 스키마 | 역할 | 쓰는 쪽 |
|---|---|---|
| `public` | 문서·조문·임베딩 등 **검색의 핵심 데이터** | 적재 파이프라인(쓰기), 검색 서버(읽기) |
| `rag_ext` | **구조화 추출 결과**(공시 표 값, 계약·소송·이사회·기부, 징계·지적, 채용, 사례 카드, 인용 링크)와 그 `*_current`·`*_public` 뷰 | 추출기(쓰기), `structured_query`·`find_cases`(읽기) |
| `rag_sql` | **`query_sql` 전용 읽기 뷰 13개** — 공개해도 되는 열만 | 읽기 전용 롤 `mcp_sql_ro` |

- 구조화 표는 **원천 행 테이블 → `_current` 뷰(현행·비합계 행) → `_public` 뷰(공개용 열) → `rag_sql` 뷰** 순으로 얇아진다. 아래 계층마다 «공개 가능한 만큼만» 노출한다.

## 2. `public` 스키마: 핵심 테이블

| 테이블 | 행 수(추정, 2026-11-26) | 역할 |
|---|---:|---|
| `documents` | 약 68만 (정확 679,591) | 문서 1행. 코퍼스·기관·제목·유형·판본·변환 이력·활용처 태그 |
| `articles` | 약 1,190만 (정확 11,890,030) | 조문/청크 1행(제목·본문·`art_no`·`art_sub`·`art_key`·장·구분) |
| `article_hash` | 약 1,090만 | `articles.id` → `text_hash` 매핑(+ `prefixed`, `base_hash`) |
| `embed_queue` | 약 640만 | 고유 해시 1개당 대표 조문 1행 |
| `article_embeddings` | 6,949,400 (정확) | `text_hash` → `vector(1024)`, `model`, `corpora text[]` |
| `institutions` | 378 (정확) | 기관 코드·이름·소관부처 |
| `inst_meta` | 약 355 | 기관 유형·지역·인원·규모 구간 |
| `bylaw_law_compliance` | 약 1.7만 | 내규가 인용하는 법령의 개정 격차 판정(일일 갱신) |
| `load_runs` | 87 (정확) | 적재 실행 이력 |
| `search_log` | 약 1.5만 | 초기 검색 로그(익명 해시 포함). 현행 질의 로그는 파일 기반이다([10](10_operations.md)) |
| `v_article_anchor` | (뷰) | `(doc_id, art_key)` 앵커 조회용 |

### `documents` 주요 열

`doc_id`(PK; 법령·내규 등은 `corpus:rel_path` 형태, 공시는 별도 실값이라 `corpus:rel_path` 와 다른 경우가 많다) · `corpus`(`legal|bylaws|ca|disclosure`) · `rel_path` · `inst_code` · `category` · `doc_title` · `alias`(법령 약칭) · `doc_type` · `doc_date` · `n_articles` · `coverage` · `parse_status` · `meta jsonb`(`dup_group`, `scope=extra`, `title_src`, `aliases` 등) · `period_quarter` · 변환 이력(`parser_ver`, `converted_at`, `ocr_kind`, `body_md5`, `src_md5`, `origin`, `anchor_level`) · `usecases text[]`(활용처 태그) · 감사 열(`created_at/by`, `updated_at/by`, `load_run_id`).

`parse_status` 분포(2026-11-26): `chunked` 621,434 · `ok` 56,752 · `low_coverage` 912 · `shell_no_body` 447 · `no_articles` 35 · `truncated` 10 · `empty` 1.

### `articles` 주요 열

`id`(PK, 재적재마다 바뀜) · `doc_id` · `seq` · `section`(본칙|부칙|별표) · `chapter` · `art_no` · `art_sub` · `title` · `body` · `n_chars` · `off int[]`(원문 위치 오프셋) · `art_key`(안정 앵커) · 감사 열.

### 인덱스와 제약

| 대상 | 인덱스 | 목적 |
|---|---|---|
| `articles` | `UNIQUE (doc_id, seq)`, `UNIQUE (doc_id, art_key)`, `(doc_id)`, `(art_no) WHERE art_no IS NOT NULL` | 문서 내 순서·앵커 유일성, 문서별 조회 |
| `articles` | `GIN (lower(body) gin_bigm_ops)`, `GIN (lower(title) gin_bigm_ops)`, `GIN (title gin_trgm_ops)` | **한글 키워드 검색**(pg_bigm: 2-gram) |
| `documents` | `GIN (doc_title gin_trgm_ops)`, `GIN (alias gin_trgm_ops)`, `GIN (usecases)`, `(corpus)`, `(inst_code)`, `(doc_type)`, `(corpus, inst_code, doc_title, doc_date)`, `((meta->>'dup_group'))` | 제목 유사도, 활용처, 판본·중복 묶음 |
| `article_hash` | `PK(id)`, `(text_hash)`, `(base_hash)` | 해시 ↔ 조문 |
| `article_embeddings` | `PK(text_hash)`, **코퍼스별 부분 HNSW 5개**([04](04_load_embedding.md)) | 의미 검색 |

- **pg_bigm 식 일치 규칙**: 인덱스 식이 `lower(body)` 이므로 질의도 `lower(a.body) LIKE ...` 형태여야 인덱스를 탄다. `ILIKE` 를 쓰면 플래너가 인덱스를 못 써서 순차 스캔(실측 2.1~2.3초 → 인덱스 사용 시 4ms)이다. 이 식을 `load_pg.js` 의 인덱스 정의와 «같게» 유지한다.
- **2글자 이하 키워드**는 trigram 계열 인덱스로 처리가 어렵다. 한글 2-gram 은 pg_bigm 이 처리하지만 흔한 말은 넓게 걸려 느리다(예 «휴가» 약 8초, 1~2자 흔한 말은 10초 초과).
- 부분 HNSW 의 조건 `corpora @> ARRAY['...']` 는 `article_embeddings.corpora` 열로 코퍼스를 구분하기 위해 있다(같은 해시가 여러 코퍼스에서 쓰일 수 있다).

## 3. `rag_ext` 스키마: 구조화 데이터

| 영역 | 주요 객체 | 행 규모(추정) | 내용 |
|---|---|---:|---|
| 공시 표 값 | `doc_fields`, `doc_field_runs`, 뷰 `doc_fields_current` | 3,444,718(정확) | 공시 표를 셀 단위 **필드**(`field_key`, `value_raw`, `value_num`, `unit_std`, 열 연도·분기·기준)로 분해. 현행 실행분만 `_current` |
| 업무추진비·기부·출연·소송·이사회 | `b2_docs`, `b2_*_rows`, 뷰 `b2_*_current`, `b2_*_public` | 각 6천~23만 | 코드 20701 업무추진비, 21301 소송, 43009 이사회 의결, 21502 기부, 32001 출연 |
| 이사회·감사·평가 | `c2_board_meeting`·`c2_board_agenda`·`c2_audit_opinion`·`c2_eval_score`·`c2_eval_overall`·`c2_finding_item` + MV `*_current` | 수천~수만 | 회의·안건, 감사의견, 경영평가 점수·종합등급, 지적 항목 |
| 계약 | `contract_docs`, `contract_rows`, `contract_cp_map`, MV `contract_current_m`, 뷰 `contract_public`, `contract_small_agg` | 약 97만 행 | 수의계약 등 계약 표(70301) |
| 징계·지적·채용 | `discipline_case`, `finding_meta`, `recruit_post`, 뷰 `recruit_open`·`recruit_closing_soon` | 2.7만 / 1.3만 / 2.5만 | 징계 처분, 국회·감사원 지적 메타, 접수 중 채용 |
| 사례 카드 | `card_items`(41,989), `card2_items`(23,631), `card_event`, `card_doc_feat`, `card_doc_sat`, 뷰 `card2_find_v` | — | LLM 추출 카드([08](08_structured_cases_sql.md)) |
| 인용 링크 | `bylaw_cite_link`(509,854, 정확), `bylaw_cite_run`, `card_cite_link` | — | 내규·단체협약 조문의 인용을 대상 법령·판본에 연결(아래 «인용 링크 표»). 백업 `bylaw_cite_link_bak_20261126` |
| 추출 로그 | `extract_log`, `c2_extract_log`, `card_runs`, `card_doc_log` … | — | 추출 실행·실패 기록 |

- `bak_*`·`*_bak_*`·`g_*`·`g3ab_*`·`cc_*` 등은 백업·시험·실험 테이블이다. 공개 도구는 읽지 않는다.
- **갱신**: `rag_ext_refresh.py`(일일 델타 뒤 1회, `src/extraction/`)가 `public.documents` 의 `body_md5`·추출기 버전과 파생 테이블을 비교해 **변경된 문서만 재추출·교체**한다. 문서 단위 트랜잭션(자식 삭제 → 부모 삭제 → 삽입 → 현행 재계산), 실패는 비치명(그 문서만 건너뜀), 실행 잠금, 운영 스키마에 쓰려면 `RAG_EXT_PROD=1` 을 요구한다. 실행 뒤 materialized view 를 `REFRESH MATERIALIZED VIEW CONCURRENTLY` 로 갱신한다(계약 MV 확인, 나머지 MV 도 같은 방식으로 추정 — 미확인).
- 알림 임계(추정치): 신규·변경이 연속 N일 0건, 실패율 2% 초과, 필드 키 미분류율 초과(예 코드 21401 은 기준선 51%라 65% 허용).

### 인용 링크 표 `rag_ext.bylaw_cite_link` (2026-11-26 13:56 재적재 기준)

내규(bylaws)·단체협약(ca)의 **모든 문서·모든 조문**(판본 포함)에서 «법령명 + 제N조» 표기를 **규칙 기반(LLM 없음)** 으로 추출해 대상 문서에 연결한 표다. 509,854행.

| 열 | 뜻 |
|---|---|
| `link_id` (PK) | 행 번호 |
| `src_doc_id`, `src_seq`, `src_corpus`, `src_inst_code`, `src_art_no`, `src_art_sub` | 인용하는 쪽(내규·단협 문서의 조문 청크) |
| `ev_text`, `ev_start`, `ev_end` | 인용 문구와 `articles.body` 안의 위치(유니코드 코드포인트 오프셋; `substr(body, ev_start+1, ev_end-ev_start) = ev_text` 로 검증) |
| `name_raw`, `law_key` | 본문에 쓰인 법령명 원문, 정규화한 법령 키 |
| `art_no`, `art_sub`, `locator` | 인용된 조·가지조문, 항·호까지의 위치 표기(예 «제12조제2항») |
| **`kind`** | `law`(legal 코퍼스의 법령으로 해소) · `unmatched`(법령명은 추출했으나 코퍼스에 없거나 해소 실패) · `bylaw`(내규→내규 인용) · `ca`(단체협약 참조) |
| `dst_doc_id`, `edition_ef`, `edition_et` | 연결된 법령 문서와 그 판의 시행 구간 |
| **`ed_conf`** | 인용 당시 판 신뢰도: `ok`(인용 시점이 판 구간 안) · `weak` · `gap`(구간 밖 등) |
| `ref_date`, `ref_basis` | 인용 시점 판정에 쓴 날짜와 근거 |
| **`how`** | 해소 방식: `exact` · `suffix` · `short_exact` · `alias`(약칭 사전) · `inline_alias`(«이하 "법"» 정의) · `connect`(앞 인용 이어받기) · `relative`·`relative_ante`(«같은 법») · `none` |
| `reason`, `art_found`, `rule_id`, `rule_ver`, `run_id` | 미해소 사유, 대상 조문 존재 여부, 규칙 식별자(현행 `C1.v1+E4+RABC`), 적재 실행 |
| **`verified_state`** | `auto_strict`(281,636) · `auto`(228,218) — 자동 추출이며 사람 검수 전이다. 교체 전 표에는 약한 연결 표지 `auto_weak_rel` 이 있었다 |

- 열 값의 해석 중 `ed_conf` 의 `ok`(인용 시점이 판 구간 `[edition_ef, edition_et)` 안)만 내부 검증 기준으로 확인했고, `weak`·`gap` 과 `how`·`verified_state` 값의 세부 정의는 추출 규칙 코드를 보아야 하며 여기서는 이름에서 추정한 설명이다(미확인).
- 분포(2026-11-26): `kind` = unmatched 220,101 · **law 183,854** · bylaw 101,289 · ca 4,610. law 행의 `ed_conf` = ok 149,247 · weak 18,201 · gap 16,406.
- 인덱스: `UNIQUE (link_id)`, `UNIQUE (src_doc_id, src_seq, ev_start)`(멱등 적재 키), `bcl_law_art (law_key, art_no, art_sub) WHERE kind='law'`(법령 역조회), `bcl_src (src_doc_id, src_seq)`, `bcl_inst (src_inst_code, law_key)`, `bcl_unm (name_raw) WHERE kind='unmatched'`(사전 보강 후보 집계). FK 없음.
- 정밀도·한계·적재·교체 절차는 [08](08_structured_cases_sql.md#4-find_citing-과-인용-링크-표).

### 구조화 추출 방식과 검증

| 방식 | 대상 | 검증 |
|---|---|---|
| **규칙 기반 파서**(결정적) | 공시 표 필드(`field_extractor`), 업무추진비·소송·이사회·기부(`b2_extract`), 계약(`contract_parser_v3`), 징계·지적 | 표 합계행 검증(`sum_check`), 대차대조 항등식(재무 2,027/2,028 일치), 단위 보정, 합계·소계 행 플래그, 파싱 플래그(`parse_flags`) |
| **LLM 추출** | 사례 카드(요지·결과·원문 인용 위치·favor) | 원문 인용 위치 일치(`quote_match`), 후처리 정규화·품질 열, 사람 검수는 표본([09](09_evaluation.md)) |

- 규칙 기반 추출에서 반복된 함정: **금액 단위 배수 오판**(천원/백만원/억원), 합계·소계 행이 일반 행으로 들어옴, 같은 (기관·연도)에 «현행» 문서가 복수, 계약 상대방 순위 상위가 개인·빈 문자열, 복수 업체 칸 미분할. 레드팀(2026-11-23)이 짚었고 데이터 층과 뷰로 보정했다(`amount_won` 의심 행 NULL 처리, `counterparty_class` 열, `contract_current` 재정의). 단위 오표기는 2026-11-26 에 원천 UPDATE·추출기 패치·뷰 보정으로 고쳤다.

## 4. `rag_sql` 스키마: 읽기 전용 뷰와 롤

뷰 13개(2026-11-26): `institutions`, `item_codes`, `doc_fields`, `b2_bizcost`, `b2_board`, `b2_contrib`, `b2_donation`, `b2_lawsuit`, `c2_audit_opinion`, `c2_board_agenda`, `c2_board_meeting`, `c2_eval_score`, `c2_finding_item`.

- `rag_sql.doc_fields` 는 `rag_ext.doc_fields_current` 에서 **항목 코드 4종**(20201 임직원 수 등)만 노출하고, 보정된 단위(`unit_std`)를 CASE 로 계산해 낸다.
- `rag_sql.b2_*` 는 `rag_ext.b2_*_public` 의 얇은 투영이다. `_public` 은 `_current`(현행·비합계 행)에서 자유 서술·원본 열을 뺀 것이다. 계약 `contract_public` 은 계약명·내용·사유에서 전화번호·주소 형태를 `[전화]`·`[주소]` 로 치환하고 상대방 명칭은 «회사로 분류된 것만» 키로 노출한다. 사택·관사 임차 같은 개인 주거 성격 행은 제외한다.
- `b2_hidden_inst_years`: 금액이 비정상적으로 큰 행(1e12 초과 등)이 있는 (기관·연도)를 모아 두고, 조건부 총액 계산에서 그 기관·연도를 «검증 못 함»으로 처리하는 데 쓴다.

### 읽기 전용 롤 `mcp_sql_ro`

| 설정 | 값 (2026-11-26 조회) |
|---|---|
| 권한 | `rag_sql` 의 위 13개 뷰에 **SELECT 만**(테이블 단위 GRANT 는 그 외 없음). `public`·`rag_sql` 스키마 USAGE, `rag_ext` 스키마 USAGE **없음** |
| `default_transaction_read_only` | on |
| `statement_timeout` | 5s |
| `lock_timeout` | 1s |
| `idle_in_transaction_session_timeout` | 10s |
| `search_path` | `rag_sql` |
| `temp_file_limit` | 200MB |
| `work_mem` | 16MB |

- 서버에서 검증(토큰 검증기)하고, 롤에서 한 번 더 막고, READ ONLY 트랜잭션과 타임아웃으로 또 막는 **겹겹 방어**다([08](08_structured_cases_sql.md)).
- 앱 계정과 읽기 전용 롤을 분리했다. 구조화 조회(`structured_query`)는 앱 계정을 쓰지만 트랜잭션을 `READ ONLY` 로 강제한다(레드팀 권고 반영).

## 5. 개인정보와 마스킹 (DB 관점)

- **적재 시점 마스킹**: 파서가 청크 텍스트에서 주민번호형·휴대폰·개인 메일을 마스킹해 DB·임베딩에 넣는다(원문은 md 파일에만 있다). 건강검진 개인 기록 문서는 색인에서 제외한다.
- **반환 시점 마스킹**: 서빙 계층이 응답 행·본문·제목에서 한 번 더 가린다(등급별: external·미지정은 모든 이메일, internal·master 는 기본). 구조화·사례 카드 응답 문자열도 마스킹한다.
- 한계: 이름·주소·계좌번호는 탐지하지 못한다. 일반전화는 숫자열·품목코드 과다 적중(약 33만 건 오탐)으로 마스킹하지 않는다([10](10_operations.md)).
- 공개용 뷰는 자유 서술 열과 원본 열(`raw_cells`, 대표자명, 상대방 원문 등)을 빼서 개인정보 노출면 자체를 줄인다.

## 6. 예시 쿼리 (구조 중심, 값 없음)

```sql
-- (1) 한글 키워드: pg_bigm 인덱스를 타는 형태(lower(...) LIKE)
SELECT d.doc_id, a.art_no, a.title
  FROM articles a JOIN documents d USING (doc_id)
 WHERE d.corpus = 'bylaws'
   AND lower(a.body) LIKE '%' || lower($1) || '%'
 ORDER BY d.doc_date DESC
 LIMIT 10;

-- (2) 의미 검색(후보 → 정확 재순위): 코퍼스 부분 HNSW 를 타려면 식과 조건이 인덱스와 같아야 한다
WITH cand AS (
  SELECT e.text_hash
    FROM article_embeddings e
   WHERE e.corpora @> ARRAY['legal']
   ORDER BY (e.embedding::halfvec(1024)) <=> $1::halfvec(1024)
   LIMIT 200)
SELECT a.doc_id, a.art_key, (e.embedding <=> $1::vector(1024)) AS dist
  FROM cand c
  JOIN article_embeddings e USING (text_hash)
  JOIN article_hash h USING (text_hash)
  JOIN articles a ON a.id = h.id
 ORDER BY dist
 LIMIT 10;

-- (3) 판본: 특정 시점 법령 (as_of=YYYYMMDD) — documents.meta 의 effective_from/effective_to(없으면 doc_date)로
--     effective_from <= as_of < effective_to 를 비교하고 edition_status 로 현행·연혁을 거른다
--     (실제 SQL 은 src/serving/search.js 의 buildQuery 참조)

-- (4) query_sql 로 허용되는 형태: 뷰 이름만, 값은 바인딩($1), 합계는 sum_check 조건 동반
SELECT yr, sum(amount_won) AS total
  FROM b2_bizcost
 WHERE inst_code = $1 AND sum_check = 'ok'
 GROUP BY yr;
```

## 7. 알려진 함정

- **`reltuples` 는 추정치**다. 규모를 말할 때는 `count(*)` 또는 공식 집계의 정의를 쓴다. `article_embeddings` 전체 행 수에는 출연연 벡터와 고아가 들어 있다.
- **TRUNCATE 는 벡터를 남긴다**(FK 없음) → 고아가 쌓인다. 대량 재적재 뒤에는 고아 정리를 거친다.
- **HNSW + 필터**는 선택적 필터에서 최대 약 7초까지 느려질 수 있다(반복 스캔). 후보를 먼저 줄인 뒤 정확 거리로 재순위하는 2단계 방식(후보 ≤ 2만이면 정확 거리)으로 완화했다.
- 코퍼스 구분 열이 없는 쪽에 카테고리 필터를 SQL 로 얹으면 HNSW 를 버려 전량 타임아웃이 난다(실측).
- 델타 적재는 `doc_id` 범위 교체라 **총계가 단조 증가가 아니다**. 수치는 하드코딩하지 않고 조회한다.
- 조회 명령이 정본을 쓰는 경우(캐시·상태 파일 갱신)가 있어 «읽기 전용»이라고 믿고 실행하기 전에 스크립트를 확인한다([11](11_lessons_pitfalls.md)).
- `load_runs` 의 `finished_at IS NULL` 행은 실패·롤백한 실행의 흔적으로 정상이다(정리하면 임베딩 규격 기준 판정이 오염될 수 있어 닫지 않는다).
- 문서 수·청크 수 정의가 다르면 값이 다르다: 문서 = `documents` 행, 청크 = `articles` 행, 벡터 = 코퍼스별 고유 `text_hash` 합(공식 집계). `documents.corpus='bylaws'` 에는 출연연 4,407건이 포함되므로 355곳 기준 집계는 `meta.scope <> 'extra'` 로 거른다.
