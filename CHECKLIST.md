# CHECKLIST — 도구 문서 대 서버 코드 대조 (2026-11-26)

방법: 운영 MCP 컨테이너(이미지 `dev-20261126c13`) 안에서 `dispatch({method:'tools/list'}, tier)` 를 호출해 `internal`·`external` 두 등급의 도구 정의를 직접 추출했다(둘 다 13개, 이름·순서 동일). 이 정의의 인자 이름·열거값·필수 여부를 `docs/07_mcp_tools.md` 와 스크립트로 대조했다. 응답 필드는 핸들러 코드(`src/serving/`)를 읽어 확인했다.

| 도구 | 인자 수(tools/list) | 문서에 없는 인자 | 필수 인자 | 필수 표기 누락 | 열거값 누락(비고) |
|---|---:|---|---|---|---|
| `search_corpus` | 24 | 없음 | keyword | 없음 | 없음 |
| `get_document` | 6 | 없음 | doc_id | 없음 | 없음 |
| `get_article` | 3 | 없음 | doc_id, art_no | 없음 | 없음 |
| `count_institutions` | 3 | 없음 | keyword | 없음 | 없음 |
| `search_extra` | 11 | 없음 | keyword | 없음 | section=본칙; section=부칙; section=별표 |
| `list_catalog` | 6 | 없음 | kind | 없음 | corpus=legal; corpus=bylaws; corpus=disclosure |
| `compare_documents` | 7 | 없음 | a, b | 없음 | 없음 |
| `get_series` | 5 | 없음 | item | 없음 | 없음 |
| `structured_query` | 22 | 없음 | dataset | 없음 | tables=all |
| `get_related` | 7 | 없음 | doc_id, art_no | 없음 | 없음 |
| `scan_documents` | 14 | 없음 | terms | 없음 | 없음 |
| `find_cases` | 16 | 없음 | (없음) | 없음 | 없음 |
| `query_sql` | 2 | 없음 | sql | 없음 | 없음 |

## 결과 해석

- 13개 도구의 **모든 인자 이름이 문서에 있고**, 필수 인자 표기도 일치한다.
- 열거값 «누락» 4건은 문서에서 값을 개별 나열하지 않고 한 줄로 묶어 쓴 표기 차이다: `search_extra.section`(`search_corpus` 와 같다고 참조), `list_catalog.corpus`(`search_corpus` 와 같음), `structured_query.tables=all`(표에 `tables` 설명으로 요약). 값 자체는 틀리지 않다.
- `find_cases` 는 필수 인자가 없다(코드·`tools/list` 일치).

## 코드와 대조해 정정한 문서 항목

- `find_cases` 응답 키는 `cases`(처음 초안의 `cards` 를 정정), `legal_basis`·`filters_applied`·`count_returned` 포함.
- `structured_query` 의 `dataset` enum 에 `c2_eval` 은 없다(플래그 `STRUCT_C2_EVAL` 별도) — 문서에 반영.
- 임베딩 접두 정책은 «전역 유일할 때만 접두 + 단체협약 항상»이다(초안의 반대 서술을 `load_pg.js` 주석과 대조해 정정).

## 한계

- 도구 설명 본문(description)은 매우 길거나(search_corpus 약 3,200자) 짧다. 문서는 설명을 그대로 옮기지 않고 코드로 확인한 동작을 요약했다.
- 응답 필드 목록은 코드 읽기로 확인했으며, 실제 응답 JSON 을 전 필드 대조한 것은 아니다(운영 응답을 문서에 싣지 않기 위해 샘플 호출을 하지 않았다).
- 플래그에 따라 노출 인자가 달라지는 도구(`search_corpus` 의 `offset`·`item` 등)는 운영에서 켜진 상태의 정의를 기준으로 했다.
