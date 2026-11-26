# 07. MCP 도구 14개 상세

> 기준일 2026-11-26. **정의의 근거**: 운영 MCP 서버(이미지 `dev-20261126c15`)의 `tools/list` 응답을 서버 프로세스에서 직접 추출했다(등급 `external` 14개 확인, `find_citing` 추가; 앞선 c13 추출은 13개였다). 인자·열거값·필수 여부는 그 응답과 같다. **동작의 근거**: `src/serving/` 핸들러 코드. 대조 결과는 [CHECKLIST.md](../CHECKLIST.md)에 있다.
> 서버는 일부 도구의 설명을 «도구 목록 크기 예산» 때문에 일부러 짧게 둔다(`structured_query`·`find_citing`·`find_cases`·`query_sql` 등). 아래 «용도»는 코드에 근거한 더 자세한 설명이다.

## 공통 사항

- 전송: MCP Streamable HTTP(무상태, 세션 불필요). 인증: 접속 키(Bearer). 한도 초과는 HTTP 429 + `Retry-After` + JSON-RPC 오류 -32002, 인증 실패는 401.
- **한도**: 기본 분당 40회(의미·하이브리드 분당 10회), 키에 별도 한도(분당·일일)가 있으면 그것을 따른다. 배치 요청은 길이 10 이하이고 항목마다 센다. 무거운 도구는 추가 한도가 있다(분당, 외부 등급 기준): `compare_documents` 5 · `get_related` 10 · `structured_query` 20 · `scan_documents` 4. 내부 등급은 더 높다.
- 응답의 모든 문자열은 반환 시점에 개인정보 마스킹을 거친다(등급별 규칙).
- 판본 표식: 문서가 나오는 응답은 `edition_state`·`edition_warning`·`effective_from/to` 를 함께 준다. «현행 아님»인 근거는 그렇게 밝혀 인용해야 한다.
- **0건 ≠ 없음.** 적재 범위·필터·모드 한계로 못 찾았을 수 있다.
- 도구 노출은 등급에 따라 달라질 수 있다(닫힌 등급에서는 `find_cases`·`query_sql`·`scan_documents`·`find_citing` 을 목록에서 빼고, 직접 호출하면 «이 도구는 현재 사용 등급에서는 제공되지 않습니다» 오류). 조회한 2026-11-26(c15)에는 external 등급에도 14개가 모두 열려 있었다.
- `doc_id`: 응답 행의 `doc_id`(DB 실값)를 그대로 다른 도구에 넘긴다. 옛 형식 `corpus:rel_path` 도 한 번 더 찾아 준다. 못 찾으면 «추측하거나 지어내지 말고 search_corpus 결과의 doc_id 를 그대로 써서 다시 호출하세요» 오류.

---

## 1. `search_corpus`

**용도**: ALIO 공시 문서(경영공시 `disclosure`·기관내규 `bylaws`·단체협약 `ca`)와 근거 법령(`legal`) 조항 검색. 키워드·의미·하이브리드, 판본·시점·항목·기간 필터.

| 인자 | 타입 | 설명 |
|---|---|---|
| `keyword` **필수** | string | 검색어. 빈 문자열 `""` 이고 `item` 이 있으면 그 항목 문서를 제출일 최신순으로 나열 |
| `corpus` | enum `all|legal|bylaws|ca|disclosure` | 기본 `all` |
| `semantic` | boolean | 의미 검색 |
| `hybrid` | boolean | 키워드+의미 RRF 융합(모호하면 권장) |
| `usecase` | string | 활용처 필터(콤마=OR): `recruit audit governance labor finance welfare safety security esg` |
| `inst` | string | 기관명 부분일치. 약칭은 정식명으로 해석 |
| `ministry`, `type` | string | 소관부처, 문서유형(규정·지침·단체협약·법률 …) |
| `body` | boolean | 본문까지(기본 제목만, 키워드 전용). **개수·전수 질문에는 반드시 true** |
| `limit` / `offset` | integer | 1~50(기본 10) / 건너뛸 수(최대 198) |
| `all_versions` | boolean | 연혁·시행예정·폐지 포함 |
| `as_of` | string `YYYY-MM-DD` | 그 날짜에 유효한 판 |
| `section` | enum `all|본칙|부칙|별표` | 조문 구분 |
| `collapse_dup` | boolean | 같은 기관 동일 문서 접기(기본 true) |
| `distinct_inst` | boolean | 기관당 1건만 |
| `item` | string | 공시 항목(이름·별칭·코드, 쉼표 여러 개). `disclosure` 에만 적용 |
| `period` | string | 공시 **회차(제출)**: `2026Q2`·`2026`·`2026-07`·`latest` |
| `report_period` | string | 공시 **보고 대상**: `2025Q4`·`2025` |
| `target_year` | string | 문서 제목의 «20XX년» |
| `sort` | enum `latest` | 같은 기관·항목 계열에서 최신 우선 |
| `expand`, `months`, `brief` | boolean / integer / boolean | 동의어 확장(1쪽만), 최근 N개월 제출분, 본문 120자 축소 |
| `latest_only` | boolean | 나중 공시가 있는 행(`series_latest=false`) 제외 |
| `include_short` | boolean | 본문 없는 껍데기 페이지 포함 |

**응답**: `rows[]`, `count`, 그 밖 메타. 행 필드(대표): `doc_id`, `inst_name`, `ministry`, `doc_title`, `doc_type`, `corpus`, `category`, `art_ref`, `art_title`, `body`, `n_chars`, `score`, `doc_date`, `section`, `edition_state`, `edition_warning`, `edition_group`, `effective_from/to`, `repealed`, `lineage_*`, `same_doc`, `period_label`, `period_label_adj`, `submitted_at`, `series_latest`, `table_header`, `rerank`(적용 시), `pre_release`(해당 시). 응답 메타: `degraded`(부분 결과), `docs_total`, `zero_reasons`, `item_resolved`·`unresolved`·`suggestions`·`ambiguous`·`period_warning`, `has_more`·`next_offset`·`window_exhausted`, `deduped_from`, `expanded_terms`, `period_semantics`, `fallback`·`word_hint`(0건 보강).

**한계·주의**
- 키워드는 짧은 명사(3자 이상) 권장. 문장형은 `hybrid`/`semantic`.
- 결과는 상위 후보이므로 **전수·순위를 말할 수 없다**. «몇 곳» 질문은 `count_institutions`, 기관 단위 집계는 `distinct_inst`.
- `degraded` 가 있으면 일부 팔이 실패한 부분 결과이며 0건이 «없음»이 아니다.
- `period_label` 은 제출 회차이지 보고 대상 기간이 아니다. 보고 대상은 `report_period`.
- 출연연 23곳은 기본 제외 — `search_extra`(또는 `inst` 에 기관명을 주면 포함).
- 단체협약 현행 판정은 `folder_year_approx` 근사.

**사용 예**
```json
{"name":"search_corpus","arguments":{"keyword":"육아휴직 대체인력","corpus":"bylaws","hybrid":true,"inst":"○○공사","limit":5}}
{"name":"search_corpus","arguments":{"keyword":"","item":"임직원 수","inst":"○○공사","period":"latest"}}
{"name":"search_corpus","arguments":{"keyword":"근로기준법 연차","corpus":"legal","semantic":true,"as_of":"2019-01-15"}}
```
**실패 시 안내**: 0건이면 `zero_reasons`·`word_hint` 를 따라 필터를 줄이거나 모드를 바꾼다. `unresolved` 면 `list_catalog(kind=items)` 로 항목명을 확인한다.

---

## 2. `get_document`

**용도**: 문서 메타(판본·효력 포함)와 조문 목록.

| 인자 | 설명 |
|---|---|
| `doc_id` **필수** | 문서 ID |
| `include_body` | 조문 전문 포함(기본 false = 200자 미리보기). 응답이 매우 커질 수 있음 |
| `max_articles` | 1~200(기본 50) |
| `offset` | 앞에서 건너뛸 조문 수(서버 설정에서 켜져 있을 때) |
| `find` | 이 표현(`A|B`)이 나온 구절만 반환(긴 문서용, MCPdeep) |
| `expand` | `find` 동의어 확장 |

**응답**: `document`{`doc_id`, `corpus`, `doc_title`, `alias`, `doc_type`, `doc_date`, `rel_path`, `n_articles`, `usecases`, `inst_name`, `ministry`, `edition_*`, `effective_from/to`, `repealed`, `lineage_*`, `created_at`, `updated_at`}, `articles[]`{`seq`, `section`, `chapter`, `art_no`, `art_sub`, `title`, `n_chars`, `body`}, `articles_shown`, (offset 사용 시) `total_articles`·`offset`·`next_offset`.

**한계**: 조문은 `seq` 순. 200개를 넘는 문서의 뒷부분은 `offset`(또는 `get_article`)이 필요. `n_articles` 와 실제 행 수가 다를 수 있다. **실패 시**: 「문서 없음」→ `search_corpus` 결과의 `doc_id` 를 그대로 사용.

```json
{"name":"get_document","arguments":{"doc_id":"<search_corpus 결과의 doc_id>","max_articles":20}}
```

---

## 3. `get_article`

**용도**: 특정 조문(제N조) 전문.

| 인자 | 설명 |
|---|---|
| `doc_id` **필수** | 문서 ID |
| `art_no` **필수** | 조 번호(제N조의 N) — `search_corpus` 행 `art_ref` 에서 |
| `art_sub` | 가지조문 번호(제N조의M 의 M). 예 «제23조의2» → `art_no=23, art_sub=2`. 생략하면 같은 `art_no` 의 모든 행 |

**응답**: `doc_id`, `articles[]`{`seq`, `section`, `chapter`, `art_no`, `art_sub`, `title`, `body`}.

**한계**: 구분(본칙·부칙) 필터가 없으므로 행의 `section` 으로 구분한다. **별표·부칙 머리 청크는 `art_no` 가 비어 있어 조회되지 않는다**(→ `search_corpus` 의 `section` 필터나 `get_document(include_body=true)`). 번호 없는 행은 «조문 없음» 오류.

```json
{"name":"get_article","arguments":{"doc_id":"<doc_id>","art_no":23,"art_sub":2}}
```

---

## 4. `count_institutions`

**용도**: 조문 본문에 키워드 문자열이 들어 있는 기관이 **모두 몇 곳**인지 DB 에서 직접 센다(상위 k 검색은 전체를 못 센다).

| 인자 | 설명 |
|---|---|
| `keyword` **필수** | 2~30자의 핵심 명사 |
| `corpus` | `all|disclosure|bylaws|ca|legal`(기본 all) |
| `max_list` | 기관 이름 목록을 함께 받을 개수 0~200(기본 0 = 숫자만) |

**응답**: `keyword`, `corpus`, `institutions_total`, `by_corpus`{코퍼스별 기관 수}, `institutions`(요청 시), `basis`.

**한계(응답 `basis` 에 그대로 적힘)**: «문서에 그 문구가 있는 기관»이지 제도를 **시행하는** 기관이 아니다(언급·부정문 포함, **모든 판본** 기준). 출연연 23곳은 제외. 흔한 말(예 «휴가»)은 느릴 수 있다(약 8초, 10초 초과 시 타임아웃). 동일 질의는 10분 캐시, 동시 집계 2건 상한(초과 시 BUSY).

```json
{"name":"count_institutions","arguments":{"keyword":"법률구조","corpus":"bylaws","max_list":20}}
```

---

## 5. `search_extra`

**용도**: 국가과학기술연구회 소관 정부출연연구기관 **23곳의 내규(규정)** 검색. 공시대상 355곳과 별개(공공기관 지정 해제). 인사규정·취업규칙·보수규정·복무규정 등.

| 인자 | 설명 |
|---|---|
| `keyword` **필수** | 검색어 |
| `inst` | 출연연 기관명(부분일치) |
| `semantic`, `hybrid`, `type`, `body`, `limit`, `offset`, `all_versions`, `as_of`, `section` | `search_corpus` 와 같은 의미 |

**응답·판본 규칙**은 `search_corpus` 와 같다. **한계**: 내규만 있다(경영공시·단체협약은 없다). 의미 검색 시 쪽번호·머리글 같은 짧은 조각이 상위를 차지하지 않도록 최소 글자 수 필터가 적용될 수 있다.

```json
{"name":"search_extra","arguments":{"keyword":"연차휴가","inst":"한국생산기술연구원","hybrid":true}}
```

---

## 6. `list_catalog`

**용도**: 다른 도구의 필터에 넣을 **정확한 값**의 목록과 문서 수. 값을 모를 때 `search_corpus` 보다 먼저 쓴다(전수 검색 도구가 아님).

| 인자 | 설명 |
|---|---|
| `kind` **필수** | `institutions`(ministry 포함)·`ministries`·`doc_types`·`usecases`·`items`(공시 항목명)·`case_topics`·`case_types`·`case_results`·`case_codes`(사례 카드용)·`sql_guide`(`query_sql` 가이드) |
| `corpus` | 문서 수를 셀 코퍼스(기본 all, `items` 는 무관) |
| `q` | 값에 포함된 글자로 거르기(부분일치) |
| `limit` / `offset` | 1~200(기본 50) / `next_offset` 으로 이어서 |
| `code` | `case_*` kind 에서 코드 한정 |

**한계**: `items`·`case_*`·`sql_guide` 는 해당 기능이 켜져 있을 때만 enum 에 있다. 기관 0건일 때 약칭이면 정식명을 안내하는 힌트(옵션)가 있다. 목록은 캐시된다(TTL).

```json
{"name":"list_catalog","arguments":{"kind":"institutions","q":"공항"}}
{"name":"list_catalog","arguments":{"kind":"sql_guide"}}
```

---

## 7. `compare_documents`

**용도**: 두 문서의 조문을 **조 번호로 짝지어** 개정·신설·삭제·판정보류를 JSON 으로 비교(판본 간·기관 간).

| 인자 | 설명 |
|---|---|
| `a`, `b` **필수** | 기준(이전)·비교(이후) `doc_id`. 구판은 `search_corpus(all_versions=true)` 로 먼저 얻는다 |
| `include_body` | 변경 조문의 본문 일부 포함(기본 false) |
| `only_changed` | 변동 없는 조문 제외(기본 true) |
| `max_changes` / `offset` | 1~100(기본 30) / `next_offset` |
| `body_chars` | `include_body` 일 때 조문당 길이 50~700(기본 300) |

**응답**: `a`·`b`(메타·`edition_state`), `summary`, `listed`, `total_changes`, `shown`, `next_offset`, `truncated_by_size`, `changes[]`(길이·해시·달라진 구간), `notes`.

**한계**: **기계 비교**다. 자구 수정과 실질 개정을 구분하지 않는다. 별표·번호 없는 조문 제외. 조문이 일정 수를 넘으면 앞부분만 비교(`notes`). 해시는 정규화 본문 SHA-1 앞 8자. 같은 문서를 a·b 에 넣으면 오류.

```json
{"name":"compare_documents","arguments":{"a":"<구판 doc_id>","b":"<현행 doc_id>"}}
```

---

## 8. `get_series`

**용도**: 한 기관·항목의 공시 **회차(분기·연)** 또는 법령·내규·단체협약의 **판본 연혁**을 시간순 목록으로(수치는 추출하지 않음).

| 인자 | 설명 |
|---|---|
| `item` **필수** | 공시: 항목명(예 «임직원 수»). 그 외: 문서명 일부(예 «인사규정», 2자 이상) |
| `inst` | 기관명(모호하면 후보를 알려 줌). `legal` 은 생략 가능, `bylaws`·`ca` 는 필수 |
| `corpus` | `disclosure|bylaws|ca|legal`(기본 disclosure) |
| `from`, `to` | 공시: `2024` 또는 `2024Q3`(**보고 대상 분기** `period_label_adj` 기준). 그 외: `2024` 또는 `2024-07-01` |

**응답**: 공시 — `inst`, `item`, `total`, `series[]`{`doc_id`, `category`, `target_year`, `period_label`, `period_label_adj`, `submitted_at`, `same_content_as_prev` …}, `notes`. 그 외 — `series[]`{`doc_id`, `doc_title`, `effective_from/to`, `edition_state`, `edition_group`}.

**한계**: 최대 400건(넘으면 **오래된 쪽**을 덜고 `truncated`·`omitted_oldest`; `from`/`to` 로 나눠 조회). 공시 계열 조회는 항목 필터 기능이 켜져 있어야 한다. `same_content_as_prev` 는 `dup_group`·본문 해시가 있는 항목에서만 표시되며, 표식 부재가 «내용이 다름»을 뜻하지 않는다. `from>to` 면 오류.

```json
{"name":"get_series","arguments":{"inst":"○○공사","item":"임직원 수","from":"2023","to":"2025Q4"}}
{"name":"get_series","arguments":{"corpus":"legal","item":"근로기준법"}}
```

---

## 9. `structured_query`

**용도**: 기관별 값·건수를 DB 에서 **직접 조회·집계**(문서 검색이 아님). 자유 SQL 없이 `dataset` 별 허용 인자만 받는다.

**데이터셋**: `field_values`(공시 표 값: 임직원 수·보수·채용·일반현황 등, 기관 비교·시계열) · `recruit`(접수 중·마감 임박 채용) · `discipline`(징계 처분) · `findings`(국회 B1210·감사원 B1220 지적) · `b2_bizcost`(업무추진비) · `b2_lawsuit`(소송) · `b2_board`(이사회 의결) · `b2_donation`(기부) · `b2_contrib`(출연) · `c2_meeting`·`c2_agenda`·`c2_audit`·`c2_finding`(이사회 회의·안건·감사의견·지적 항목. 경영평가 `c2_eval` 은 코드에 있으나 2026-11-26 `tools/list` 의 enum 에는 없다 — 별도 플래그) · `contracts`(계약; 공개용 뷰).

| 인자(대표) | 설명 |
|---|---|
| `dataset` **필수** | 위 값 |
| `inst` | 기관명(약칭 가능, 쉼표로 최대 5). `field_values` 필수 |
| `item`, `field`, `from`, `to`, `basis`, `tables`, `detail` | `field_values` 용: 항목·필드 키(`"20201:staff_total"` 또는 `"평균보수"`)·열 범위·`결산|예산|분기|연도`·재무 전체 표·임원 셀 단위 |
| `mode`, `days` | `recruit`: `open|closing_soon`(필수), 임박 일수 1~30 |
| `type`, `code`, `status`, `year`, `month`, `result`, `q` | 처분·고용형태, 지적 코드 `B1210|B1220`, 지적 상태, 연도, 월, 결과 문구, 키워드(2자 이상) |
| `group_by` | `type|year|inst|status|code` — 데이터셋별로 허용되는 값이 다르다. 새 데이터셋은 `year` 만 |
| `metric` | `count`·`amount` — 기관 1곳의 연도별 건수 또는 조건부 총액(검증 못 하면 행만) |
| `limit` / `offset` | 0~200(기본 50, 0 = 건수만) / `next_offset` |

**응답 공통**: `dataset`, `count`, `total`, `exhaustive`, `has_more`, `next_offset`, `rows`|`aggregates`, `source`(`source_doc_ids`), `caveats`, `as_of`, 품질 표식(`quality`·`coverage_warn`·`sum_check`·…). 임원(20305)은 `executives` 로 묶고, 필드를 못 맞추면 `field_candidates` 를 준다.

**한계·정책**: **전수가 아니면 «전체·최다» 단정 금지**(`exhaustive=false`). 새 데이터셋(b2·c2·contracts)은 **행 조회·건수 허용, 기관 1곳 연도별 조건부 총액 허용, 순위·전 기관 합계·상대방 상위 N·기관 간 비교·횟수·비율은 거부**(`[거부]` 오류로 이유와 대안 안내). `limit`·`offset` 상한 초과는 조용히 줄이지 않고 거부. 동시 실행 3건 상한(`BUSY`), 조회 시간 8초 제한, 같은 질의 5분 캐시(채용은 1분).

```json
{"name":"structured_query","arguments":{"dataset":"field_values","inst":"○○공사","item":"임직원 수","from":"2023","to":"2025"}}
{"name":"structured_query","arguments":{"dataset":"recruit","mode":"closing_soon","days":7,"limit":20}}
{"name":"structured_query","arguments":{"dataset":"b2_bizcost","inst":"○○공사","year":2024,"metric":"amount"}}
```

---

## 10. `get_related`

**용도**: 법령·기관내규 문서의 한 조문이 **인용하는** 조문(outgoing)과 이 조문을 **인용하는** 조문(incoming).

| 인자 | 설명 |
|---|---|
| `doc_id`, `art_no` **필수** | 대상 조문 |
| `art_sub` | 가지조문 번호 |
| `direction` | `outgoing|incoming|both`(기본 outgoing) |
| `limit` | 방향별 1~50(기본 20) |
| `corpus` | incoming 에서 인용 문서를 찾을 코퍼스 `legal|bylaws`(법령 대상 기본 legal, bylaws 는 `inst` 와 함께) |
| `inst` | incoming 의 인용 문서 기관명(법령 문서의 내규 피인용에는 필수) |

**응답**: `outgoing[]`, `incoming[]`, `incoming_scope`, `incoming_truncated`, `candidates_capped`, `approximate:true`, `notes`.

**한계**: **근사**이며 전수가 아니다. 본문에 «법령명 + 제N조»가 그대로 적힌 경우만 잡는다(약칭·«같은 법»·시행령 위임 표현 누락). 단체협약·공시 문서는 미지원. incoming 은 후보 조회 상한(300)에 닿으면 하한이다. 범위(corpus·inst)가 좁을수록 빠르다.

```json
{"name":"get_related","arguments":{"doc_id":"<내규 doc_id>","art_no":12,"direction":"both"}}
```

---

## 11. `scan_documents`

**용도**: 필터한 **문서 집합의 본문 전체**에서 용어를 찾는 느린 서버측 grep(장꼬리 질의용: «지난해 ○○를 구매한 기관?»). 문서별 발췌와 `coverage` 를 돌려준다.

| 인자 | 설명 |
|---|---|
| `terms` **필수** | string 또는 array. 2~40자, 최대 12개. `A|B` = OR. **정규식 아님**(문자열로만 처리) |
| `expand` | 동의어 확장 |
| `corpus` | `disclosure|bylaws|ca|legal|all` |
| `item`, `period`, `report_period`, `target_year` | 공시 필터(`search_corpus` 와 같은 의미) |
| `months`, `submitted_from` | 최근 N개월 제출, `YYYY-MM-DD` 이후 |
| `inst`, `ministry` | 기관·부처 |
| `distinct_inst` | 기관별 묶음 |
| `limit`, `cursor` | 페이지 크기, `next_cursor` 를 **같은 인자 + cursor** 로 넘겨 이어받기 |

**응답**: 문서·기관별 발췌, `coverage`, `next_cursor`, «찾지 못함 ≠ 없음» 고지.

**한계**: 응답 본문 상한(약 38KB), 동시 2건, 외부 등급 분당 4회. 필터가 넓으면 시간 예산을 넘어 `next_cursor` 로 나눠 받는다. 0건은 «수집 범위 내 확인되지 않음»으로만 답한다. (사례 카드 대비 전수성이 높지만 질의당 15~40호출·60~150초가 걸릴 수 있다 — 2026-11-26 레드팀 실측.)

```json
{"name":"scan_documents","arguments":{"terms":"전파차단기|전파 차단기","corpus":"disclosure","months":12,"distinct_inst":true}}
```

---

## 12. `find_citing`

**용도**: **법령(·조문)을 인용하는 기관 내규·단체협약 조문**을 거꾸로 찾는다(법령 기준 역조회). 결과는 **기관 단위 목록**이며 순위·빈도가 아니다. 인용 링크 표 `rag_ext.bylaw_cite_link` 의 `kind='law'` 행만 읽는다([05](05_database.md), [08](08_structured_cases_sql.md#4-find_citing-과-인용-링크-표)).

| 인자 | 설명 |
|---|---|
| `law` **필수** | 법령명(약칭 가능, 2~80자). 약칭 일부(노조법·근기법 등)는 정식명으로 해석하고, 여러 법령과 맞으면 `ambiguous` + `candidates` 를 돌려준다 |
| `art` | 조 번호. `제60조`·`60`·`18의2` 형식 |
| `corpus` | `bylaws`(기관 내규) 또는 `ca`(단체협약). 생략하면 둘 다 |
| `inst` | 기관명(약칭은 정식명으로 해석, 부분일치) |
| `limit` | 1~50(기본 20) |

(코드에는 기관당 표시 건수 `per_inst`(1~3)도 있으나 `tools/list` 스키마에는 노출되지 않는다.)

**응답**: `law`, `law_key`, `resolved`, `art`, `corpus`, `inst`, **`units_total`**(접은 뒤 조문 단위 수), **`institutions_total`**, **`truncated_scan`**, `count`, `rows[]`{`doc_id`, `seq`, `corpus`, `inst_code`, `inst_name`, `doc_title`, `art_ref`(인용하는 조), `cited`(인용 문구), `cited_art`(인용된 조·항), `ed_conf`, `ed_note`}, **`coverage`**{`scope`, `law_links_total`, `law_in_corpus`}, **`note`**, 0건이면 `hint`.

**규칙·한계**
- **기관당 최신 판 1건으로 접는다**: 같은 기관·같은 문서 계열·같은 조문의 구판은 빼고 최신 판만 남긴다. 연혁 판과 출연연(`scope=extra`)은 제외한다.
- **`ed_conf` 가 `ok` 가 아니면 «시점 판 확인 불가»**(`ed_note`) — 인용 당시의 법 «판»이 맞는지 확인하지 못한 행이다. 조 번호가 개정으로 옮겨졌는지는 확인하지 않는다.
- **맨 «법 제N조»(법령명 없이 «이 법»·«법»만 쓴 표기)는 연결하지 않는다.** 조 번호 0(서식 자리표시자 «제0조»)은 제외하고 `art_no ≥ 1` 만 쓴다.
- **법령만 주고 조를 주지 않으면 스캔 한도 4,000행**에서 끊긴다(`truncated_scan=true` — 기관 수는 하한).
- **legal 코퍼스에 수록된 법령만 연결된다.** 미수록 법령은 인용이 있어도 나오지 않는다(`law_in_corpus=false` + 안내). 구법명(개명 전 법령명)도 연결되지 않는다.
- 규칙 기반 추출(LLM 아님)이라 약칭·표기 변형을 놓칠 수 있다. 정밀도·한계의 수치는 [08](08_structured_cases_sql.md#4-find_citing-과-인용-링크-표). **0건은 «인용 없음» 확정이 아니다.**
- 동시 실행 4건 상한(초과 시 `BUSY`), 조회 5초 제한, 질의·인용 문구는 반환 시 마스킹.

```json
{"name":"find_citing","arguments":{"law":"근로기준법","art":"제60조","corpus":"bylaws","limit":20}}
{"name":"find_citing","arguments":{"law":"노조법","corpus":"ca","limit":10}}
```
**실패 시 안내**: `resolved=false` 이면 `note` 를 따른다(미수록 법령이면 `search_corpus` 키워드 검색 병행).

---

## 13. `find_cases`

**용도**: **다기관 사례 카드**(감사·이사회·노사·평가) 검색 — 요지·원문 인용·근거 법령. 카드는 LLM 이 공시 문서에서 추출한 **표본**이다.

| 인자 | 설명 |
|---|---|
| `topic` | `A|B` = OR, 값은 `list_catalog(case_topics)` (임금·수당·휴가·복지·채용·안전·징계·계약·재무·인사·근로시간·조직·교육·노사관계·기타 등) |
| `type`, `code`, `result`, `favor` | 사례 유형, 공시 코드(`list_catalog(case_codes)`), 결과 문구, `favorable|neutral|unfavorable|unknown` |
| `ref_year` | 기준연도 `2024`·`2022-2024` (제출일이 없는 코드용) |
| `months`, `from`, `to`, `date_basis` | 기간 필터와 기준 |
| `inst`, `ministry`, `like_inst` | 기관·부처, 유사 기관 필터 |
| `basis` | 근거 법령 `[제N조]` |
| `limit`(≤30), `offset` | 페이징 |

**응답**: `cases[]`{`card_id`, `inst_name`, `submitted_at`, `code`, `case_type`, `topics`, `summary`(**모델 요약**), `result`, `quote`(**원문 근거, 원문 그대로**), `quote_span`, `favor`, `matched_in`, `legal_basis`(규칙으로 뽑은 근거 법령 연결, 자동 추출이라 확인 필요), …}, `filters_applied`, `coverage`(`cards_matching`·`docs_with_matching_cards`·코드별 `by_code`·재현율 고지), `count_returned`, `has_more`·`next_offset`, `exhaustive:false`, `notice`, `field_labels`. 정렬은 제출일 최신순(순위 아님).

**한계(응답 `notice` 에 그대로 실림)**: **순위·최다·건수 단정 금지**(일치 건수는 표본 안의 값). `summary` 는 모델 요약이라 인용 밖 사실이 섞일 수 있다(독립 검수 표본 약 6%) — 근거는 `quote`·`quote_span` 으로 원문 확인. 노출 코드는 일부(예: 이사회 43005, 감사결과 43006, 노사협의회 21028)이며 재게시율이 높은 코드(단체협약 63795·노사합의 63796 등)는 보류. 순위·집계 요구(`group_by`·`top` 등)와 질의의 «최다·순위·비율» 표현은 거부. 상세는 [08](08_structured_cases_sql.md).

```json
{"name":"find_cases","arguments":{"topic":"성과급","code":"43005","ref_year":"2023-2025","limit":10}}
```

---

## 14. `query_sql`

**용도**: **공개용 읽기 전용 뷰**에 대한 SELECT 한 문장(최대 200행). 먼저 `list_catalog(kind=sql_guide)` 로 표·열·규칙을 확인한다. 적재된 표본 기준이므로 전수·합계를 단정하지 않는다.

| 인자 | 설명 |
|---|---|
| `sql` **필수** | SELECT/WITH 한 문장(6,000자 이하) |
| `params` | `$1..` 바인딩 값 배열(10개 이하; 문자열·숫자·불리언·null) |

**응답**: `columns`, `rows`, `row_count`, `truncated`, `ms`, `policy`{`coverage`, `warnings`, `zero_hint`}.

**정책 계층·거부 규칙**은 [08](08_structured_cases_sql.md#query_sql-정책-계층)에 상세히 있다. 요약: 허용 뷰만, 허용 함수만, 주석·다중 문·달러 인용·DML/DDL·시스템 카탈로그 거부, `SUM` 질의는 합계행 검증 열 `sum_check` 를 함께 쓰도록 강제, 비용 상한(EXPLAIN)·타임아웃·행 상한·동시·분당 한도, 감사 로그.

```json
{"name":"query_sql","arguments":{"sql":"SELECT yr, sum(amount_won) AS total FROM b2_bizcost WHERE inst_code = $1 AND sum_check = 'ok' GROUP BY yr ORDER BY yr","params":["<기관코드>"]}}
```
**실패 시 안내**: 거부 오류가 이유와 허용 대안을 말해 준다. 0건이면 `policy.zero_hint` 에 따라 «확인할 수 없음»으로 답하고, 기관명 약칭이면 정식명으로 다시 시도한다.
