# CHECKLIST — 도구 문서 대 서버 코드 대조 (2026-11-26, c15 기준 14개)

방법: 운영 MCP 컨테이너(이미지 `dev-20261126c15`) 안에서 `dispatch({method:'tools/list'}, 'external')` 을 호출해 도구 정의를 직접 추출했다(14개; 앞선 c13 추출은 13개였고 `find_citing` 이 추가됨). 정의의 인자 이름·열거값·필수 여부를 `docs/07_mcp_tools.md` 와 스크립트로 대조했다. 응답 필드는 핸들러 코드(`src/serving/`)를 읽어 확인했다.

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
| `find_citing` | 5 | 없음 | law | 없음 | 없음 |
| `find_cases` | 16 | 없음 | (없음) | 없음 | 없음 |
| `query_sql` | 2 | 없음 | sql | 없음 | 없음 |

## 결과 해석

- 14개 도구의 **모든 인자 이름이 문서에 있고**, 필수 인자 표기도 일치한다.
- 열거값 «누락»은 문서에서 값을 개별 나열하지 않고 «`search_corpus` 와 같음»처럼 묶어 쓴 표기 차이다. 값 자체는 틀리지 않다.
- `find_cases`(필수 없음)·`find_citing`(필수 `law`)·`query_sql`(필수 `sql`) 도 일치한다.

## 코드와 대조해 정정한 문서 항목

- `find_cases` 응답 키는 `cases`(초안의 `cards` 정정).
- `structured_query` 의 `dataset` enum 에 `c2_eval` 은 없다(플래그 `STRUCT_C2_EVAL` 별도).
- 임베딩 접두 정책은 «전역 유일할 때만 접두 + 단체협약 항상».
- `find_citing`: 코드의 `per_inst` 인자(1~3)는 `tools/list` 스키마에 노출되지 않는다 — 문서에 «스키마 미노출»로 표기. `get_related` 는 인용 링크 표가 아니라 질의 시점 정규식 추출이라는 점을 04 에서 정정.

## 한계

- 도구 설명 본문(description)은 매우 길거나(search_corpus 약 3,200자) 짧다(find_citing 은 한 문장). 문서는 설명을 옮기지 않고 코드로 확인한 동작을 요약했다.
- 응답 필드 목록은 코드 읽기로 확인했으며 실제 응답 JSON 을 전 필드 대조한 것은 아니다(운영 응답을 문서에 싣지 않기 위해 샘플 호출을 하지 않았다).
- 플래그에 따라 노출 인자가 달라지는 도구는 운영에서 켜진 상태의 정의를 기준으로 했다.
