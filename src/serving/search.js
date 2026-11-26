#!/usr/bin/env node
/**
 * ALIO 조항 DB 검색 CLI
 *
 * 사용법:
 *   node rag/search.js "연차휴가"
 *   node rag/search.js "임금피크제" --corpus bylaws --limit 20
 *   node rag/search.js "단체협약 체결" --corpus ca --type 단체협약
 *   node rag/search.js "육아휴직" --inst 근로복지공단
 *   node rag/search.js "연차" --ministry 고용노동부 --csv
 *   node rag/search.js "제60조" --compare "근로기준법"  # 특정 법령 조항 기준 유사기관 내규 검색
 *
 * 옵션:
 *   --corpus bylaws|legal|ca|all   코퍼스 필터 (기본: all)
 *   --type   취업규칙|규정|지침...  문서유형 필터 (부분일치)
 *   --inst   기관명                 기관명 필터 (부분일치)
 *   --ministry 부처명              소관부처 필터 (부분일치)
 *   --usecase recruit|audit|governance|labor|finance  활용처 필터 (콤마로 복수 지정 시 OR — 문서의 usecases 배열과 겹침 매칭)
 *   --year   YYYY                  문서 연도 필터 (doc_date 앞 4자리)
 *   --all-versions                 내규 구버전 포함 (기본: 같은 기관·규정명은 최신 개정일만 — 구버전 혼재 0.47% 실측)
 *   --understand                   질의 이해 — 검색어에서 기관/부처/연도를 자동 추출해 필터 적용(_query_understand.js)
 *   --limit  N                     결과 수 (기본: 15, 최대: 100)
 *   --section 본칙|부칙            조문 구분 필터 (기본: 본칙)
 *   --body                         본문까지 검색 (기본: 조제목만)
 *   --semantic                     의미 검색 (pgvector KNN — 키워드가 조문에 없어도 검색됨.
 *                                  검색어를 bge-m3(기본 로컬 ollama, EMBED_PROVIDER)로 임베딩)
 *   --json                         JSON 출력
 *   --csv                          CSV 파일로 저장 (search_result_<keyword>.csv)
 *   --full                         본문 전체 출력 (기본: 앞 300자)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const IF = require('./item_filter.js');   // 항목·기간 필터(2026-10-22 item_next) — ITEM_FILTER=off 이면 args 에 itemCats/period 가 없어 아래 분기는 전부 비활성

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const env = {};
  for (const f of ['.env.api', '.env.aiapi']) {
    try {
      for (const l of fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)) {
        const m = l.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
        if (m) env[m[1]] = m[2].trim();
      }
    } catch (e) {}
  }
  return env;
}

// 🔴 질의 인코더 = 문서 인코더와 **같은 모델(bge-m3)·같은 차원(1024)** 이어야 한다(어긋나면 «오류 없이 오답»).
//   문서 벡터는 OpenRouter `baai/bge-m3` 로 만들고, 질의는 로컬 ollama `bge-m3`(F16 GGUF)로 만든다 —
//   «같은 모델의 다른 서빙» 이라 런북 §C 의 좌표계 검증(같은 문장 코사인 ≥ 0.99)을 통과해야 한다.
//   bge-m3 는 질의/문서 접두(instruction)가 없다 — input_type·접두를 붙이지 않는다(붙이면 오히려 어긋난다).
//   이 파일은 `alio-mcp/src/` 와 `alio/rag/` 두 벌 — 같이 고치고 md5 로 대조할 것.
const EMBED_PROVIDER = process.env.EMBED_PROVIDER || 'ollama';
// 폴백(유료·옵트인): ollama 가 죽었을 때만 같은 모델의 OpenRouter 로. 비우면 폴백 없음(의미검색만 실패, 키워드는 정상).
const EMBED_FALLBACK = process.env.EMBED_FALLBACK || '';
const EMBED_DIM = 1024;

// ── 의미검색 인덱스 방식 (2026-10-06 적재·임베딩 설계 v1) ───────────────────────────────
// 저장은 vector(1024) 전정밀도, HNSW 는 halfvec «표현식» 인덱스 `((embedding::halfvec(1024)) halfvec_cosine_ops)`.
//   halfvec: 인덱스로 후보 SEM_CAND_N(기본 100)개를 뽑고 → 원본 vector 로 정확 거리를 다시 재서 → 상위 k.
//   vector : 레거시(vector 인덱스를 직접 탄다). 인덱스가 vector 형이면 이쪽으로 — 안 맞으면 인덱스를 못 타고 순차 스캔이 된다.
// 🔴 ORDER BY 식은 인덱스 표현식과 «글자 그대로» 같아야 플래너가 쓴다(rag/embed_spec.js 의 halfvecOrder 와 같은 형태 — _test_query_sql.js 가 검사).
// 이 파일은 `mcp/src/` 와 `rag/` 두 벌 — 이 블록도 같이 간다(embed_spec.js 를 require 하지 않는 이유).
// SEM_INDEX 환경변수가 «명시»되면 그대로 쓴다(인덱스 형태와 다르면 경고만). 미지정이면 첫 의미검색 때 idx_emb_hnsw 의 정의를 보고 자동 선택한다
// (ensureSemanticIndex) — 그 전까지의 기본값은 halfvec. 인덱스 형태와 질의 형태가 어긋나면 인덱스를 못 타고 순차 스캔(30초 타임아웃)이 된다.
const SEM_INDEX_EXPLICIT = !!process.env.SEM_INDEX;
let semIndex = process.env.SEM_INDEX || 'halfvec';
const SEM_CAND_N = parseInt(process.env.SEM_CAND_N || '100', 10);
if (!['halfvec', 'vector'].includes(semIndex)) throw new Error('SEM_INDEX 는 halfvec | vector');
const semanticOrderBy = (col, vec) => semIndex === 'halfvec'
  ? `${col}::halfvec(${EMBED_DIM}) <=> (${vec})::halfvec(${EMBED_DIM})` : `${col} <=> ${vec}`;

// ── 코퍼스별 HNSW 레이아웃 (2026-10-21 사용자 승인) ─────────────────────────────────────────────
// idx_emb_hnsw_{legal,bylaws,ca,disclosure} 4개가 모두 있으면 «corpus» 레이아웃(ensureSemanticIndex 가 판정), 아니면 기존 단일 idx_emb_hnsw.
//   corpus: 코퍼스마다 partial 인덱스(술어 `e.corpora @> ARRAY['…']::text[]`)로 후보를 뽑아 합치고, 원본 vector 로 정확 재정렬.
//   disclosure 는 비트 양자화 인덱스로 SEM_BIT_CAND(4,000)개를 뽑고 → vector 정확 거리로 SEM_CAND_N 개로 줄인다(후보 4,000 에서 recall 0.959).
// 정의 원본은 rag/embed_spec.js(CORPUS_HNSW) — 이 파일은 require 하지 않는 사본이다(_test_corpus_index.js 가 두 벌이 같은 SQL 을 만드는지 검사).
const CORPUS_HNSW_Q = { legal: 'halfvec', bylaws: 'halfvec', ca: 'halfvec', disclosure: 'bit' };
const SEM_BIT_CAND = parseInt(process.env.SEM_BIT_CAND || '4000', 10);
const SEM_POST_IDS_MAX = parseInt(process.env.SEM_POST_IDS_MAX || '30000', 10);   // 항목·기간 사후 필터가 후보에서 받는 최대 사본 id 수(넘으면 postStats.capped)
if (!(SEM_BIT_CAND >= 1 && SEM_BIT_CAND <= 100000)) throw new Error('SEM_BIT_CAND 는 1~100000 정수');
let semLayout = 'single';
const corpusPredQ = c => `e.corpora @> ARRAY['${c}']::text[]`;
const corpusOrderQ = (c, vec) => CORPUS_HNSW_Q[c] === 'bit'
  ? `binary_quantize(e.embedding)::bit(${EMBED_DIM}) <~> binary_quantize((${vec})::vector(${EMBED_DIM}))::bit(${EMBED_DIM})`
  : `e.embedding::halfvec(${EMBED_DIM}) <=> (${vec})::halfvec(${EMBED_DIM})`;

// 의미검색 세션 노브 → ['hnsw.ef_search = N', "hnsw.iterative_scan = '…'"] (호출자가 'SET ' / 'SET LOCAL ' 을 붙인다).
//   ef_search 는 후보 수 이상이어야 한다(HNSW 는 ef_search 개까지만 돌려준다). 환경변수 HNSW_EF_SEARCH 로 실험 중 덮어쓴다.
//   iterative_scan 은 필터 질의에만: HNSW_ITERATIVE_SCAN = relaxed_order(기본) | strict_order | off
function semanticSettings(q, defaultEf) {
  if (q.layout === 'corpus') {
    // pgvector ef_search 상한 1000. 비트 후보(4,000)는 ef_search 보다 커서 반복 스캔(relaxed_order)으로 채운다 — 필터 유무와 무관하게 항상 켠다.
    // ef_search 기본 400(10-21 스테이징 실측): 1000 이면 차가운 캐시에서 bylaws 의미검색이 15초 제한(408)에 걸렸고(4/4), 400 이면 p50 1.06s·최대 1.26s·실패 0.
    //   recall(별도 서버 6.38M, 정확해 대비): bylaws 0.978·legal 0.978·ca 0.953 @ef400. 환경변수 HNSW_EF_SEARCH 로 올릴 수 있다(상한 1000).
    const ef = Math.min(1000, parseInt(process.env.HNSW_EF_SEARCH || '', 10) || 400);
    const it = process.env.HNSW_ITERATIVE_SCAN || 'relaxed_order';
    if (!['relaxed_order', 'strict_order'].includes(it)) throw new Error('corpus 레이아웃의 HNSW_ITERATIVE_SCAN 는 relaxed_order | strict_order');
    const mst = parseInt(process.env.HNSW_MAX_SCAN_TUPLES || '40000', 10);
    if (!(mst >= 1 && mst <= 1000000)) throw new Error('HNSW_MAX_SCAN_TUPLES 는 1~1000000 정수');
    // enable_seqscan=off: 운영 규모(6.4M)에서 disclosure 필터 질의를 플래너가 순차 스캔+정렬로 잡아 120초 제한에 걸렸다(10-21 실측). 인덱스 경로를 강제한다.
    //   조인·EXISTS 쪽 보조 인덱스(article_hash(text_hash)·PK)는 그대로 쓰이므로 다른 부분은 영향이 없다.
    return [`hnsw.ef_search = ${ef}`, `hnsw.iterative_scan = '${it}'`, `hnsw.max_scan_tuples = ${mst}`, 'enable_seqscan = off'];
  }
  const ef = Math.max(parseInt(process.env.HNSW_EF_SEARCH || '', 10) || defaultEf, q.candN || 0);
  const sets = [`hnsw.ef_search = ${ef}`];
  const it = process.env.HNSW_ITERATIVE_SCAN || 'relaxed_order';
  if (!['relaxed_order', 'strict_order', 'off'].includes(it)) throw new Error('HNSW_ITERATIVE_SCAN 는 relaxed_order | strict_order | off');
  // S-13: 명시 필터(hasFilter)뿐 아니라 «암묵 필터»(판본·section — implicitFilter)에도 반복 스캔을 켠다.
  //   암묵 필터가 후보를 38% 까지 탈락시켜도 반환 수가 limit 밑으로 내려가지 않게 한다. 반복 스캔은 결과가 충분하면 추가 비용이 없다.
  if ((q.hasFilter || q.implicitFilter) && it !== 'off') {
    sets.push(`hnsw.iterative_scan = '${it}'`);
    // 반복 스캔 상한 — pgvector 기본 20000 을 «명시»한다(희소 필터에서 limit 미달 시 올려 시험: G9). 정수만 허용(SET 은 파라미터 바인딩 불가).
    const mst = parseInt(process.env.HNSW_MAX_SCAN_TUPLES || '20000', 10);
    if (!(mst >= 1 && mst <= 1000000)) throw new Error('HNSW_MAX_SCAN_TUPLES 는 1~1000000 정수');
    sets.push(`hnsw.max_scan_tuples = ${mst}`);
  }
  return sets;
}

const QUERY_PROVIDERS = {
  ollama: {
    url: () => process.env.OLLAMA_URL || 'http://ollama:11434/api/embed',
    keyName: null, timeout: parseInt(process.env.EMBED_TIMEOUT_MS || '15000', 10),   // 콜드스타트(모델 적재 6~26초 실측) 여유
    // keep_alive: 요청 단위로도 상주 시간을 갱신한다(서버 env OLLAMA_KEEP_ALIVE 기본 5분 → 한산한 시간대 콜드스타트 방지).
    body: t => ({ model: process.env.EMBED_MODEL || 'bge-m3', input: [t], truncate: false, keep_alive: process.env.OLLAMA_KEEP_ALIVE || '24h' }),
    pick: j => j.embeddings[0],
  },
  openrouter: {
    url: () => 'https://openrouter.ai/api/v1/embeddings', keyName: 'OPENROUTER_API_KEY_BGEM3', timeout: 30000,
    body: t => ({ model: 'baai/bge-m3', input: [t] }),     // 1024 네이티브 — dimensions 를 주면 400
    pick: j => j.data[0].embedding,
  },
  nvidia: {   // 이전 서버 롤백용 — DB 벡터가 NVIDIA 일 때만. 신 DB(bge-m3)에서는 쓰면 오답.
    url: () => 'https://integrate.api.nvidia.com/v1/embeddings', keyName: 'NVIDIA_API_KEY', timeout: 30000,
    body: t => ({ model: 'nvidia/llama-nemotron-embed-vl-1b-v2', input: [t], input_type: 'query', dimensions: 1024, truncate: 'END' }),
    pick: j => j.data[0].embedding,
  },
};

// provider 가 요구하는 키 이름(없으면 null). api/mcp/CLI/eval 의 «키 있나» 가드가 전부 이걸 본다 — 가드가 NVIDIA 를
// 하드코딩해 provider 를 바꿔도 의미검색이 막히던 결함(2026-09-24)의 재발 방지.
// 의미검색 첫 호출 때 한 번 — idx_emb_hnsw 의 형태를 확인한다. q = pg Client/Pool(.query). 성공한 판정만 캐시(인덱스 재생성 중이던 실패는 다음 호출에서 재확인).
//  ① SEM_INDEX 명시: 그대로 쓰되 불일치면 경고 ② 미지정: halfvec 식 인덱스면 halfvec, vector_cosine_ops 면 vector ③ 인덱스 없음: NO_SEM_INDEX 오류(순차 스캔으로 30초 타임아웃 나지 않게)
// ponytail: 인덱스를 다른 형태로 다시 만들면 프로세스를 재시작해야 반영된다(캐시 무효화 없음).
let semIndexChecked = false, semCheckedAt = 0;
const SEM_RECHECK_MS = Math.max(0, parseInt(process.env.SEM_INDEX_RECHECK_MS || '60000', 10) || 0);   // 10-21 리뷰 #9: 0 이면 종전처럼 영구 캐시
async function ensureSemanticIndex(q) {
  if (semIndexChecked && (!SEM_RECHECK_MS || Date.now() - semCheckedAt < SEM_RECHECK_MS)) return semLayout === 'corpus' ? 'corpus' : semIndex;   // 🔴 10-21 리뷰: 캐시 후에도 레이아웃을 그대로 돌려준다(종전엔 두 번째 호출부터 semIndex 를 돌려 isCorpusLayout 이 항상 false 였다)
  const all = await q.query(`SELECT indexname, indexdef FROM pg_indexes WHERE indexname LIKE 'idx_emb_hnsw%' AND schemaname = current_schema()`);
  const have = new Set(all.rows.map(x => x.indexname).filter(Boolean));
  if (process.env.SEM_LAYOUT !== 'single' && Object.keys(CORPUS_HNSW_Q).every(c => have.has('idx_emb_hnsw_' + c))) {
    semLayout = 'corpus'; semIndexChecked = true; semCheckedAt = Date.now(); return 'corpus';
  }
  semLayout = 'single';
  const r = { rows: all.rows.filter(x => !x.indexname || x.indexname === 'idx_emb_hnsw') };
  if (!r.rows.length) throw Object.assign(new Error('의미검색 인덱스 없음 — idx_emb_hnsw 가 없습니다(재생성 중이거나 미구축). 잠시 후 다시 시도하거나 semantic=false 키워드 검색을 사용하세요'), { code: 'NO_SEM_INDEX' });
  const def = r.rows[0].indexdef || '';
  const actual = /halfvec/.test(def) ? 'halfvec' : /vector_cosine_ops/.test(def) ? 'vector' : null;
  if (SEM_INDEX_EXPLICIT) { if (actual && actual !== semIndex) console.error(`[search] 경고: SEM_INDEX=${semIndex} 인데 idx_emb_hnsw 는 ${actual} 형 — 질의가 인덱스를 못 타 느려진다`); }
  else if (actual) semIndex = actual;
  else console.error(`[search] 경고: idx_emb_hnsw 형태를 알 수 없음(${def.slice(0, 120)}) — 기본 ${semIndex} 유지`);
  semIndexChecked = true; semCheckedAt = Date.now();
  return semIndex;
}

function embedKeyName(provider = EMBED_PROVIDER) { return (QUERY_PROVIDERS[provider] || {}).keyName || null; }

function embedOnce(provider, env, text) {
  const P = QUERY_PROVIDERS[provider];
  if (!P) return Promise.reject(new Error('알 수 없는 EMBED_PROVIDER=' + provider));
  const u = new URL(P.url());
  const transport = u.protocol === 'http:' ? require('http') : require('https');
  const key = P.keyName ? env[P.keyName] : null;
  if (P.keyName && !key) return Promise.reject(new Error(`${P.keyName} 없음 (provider=${provider})`));
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(P.body(text.slice(0, 500)));
    const req = transport.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST', timeout: P.timeout,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                 ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          if (r.statusCode !== 200) throw new Error('HTTP ' + r.statusCode);
          const v = P.pick(JSON.parse(d));
          // 차원·유한성 가드 — 어긋나면 «오류 없이 오답»(HNSW 는 차원이 다르면 에러지만 NaN 은 조용히 통과)
          if (!Array.isArray(v) || v.length !== EMBED_DIM || !v.every(Number.isFinite)) throw new Error('차원/값 이상: ' + (v && v.length));
          resolve(v);
        } catch (e) { reject(new Error(`임베딩(${provider}): ${e.message} ${d.slice(0, 120)}`)); }
      });
    });
    req.on('error', e => reject(new Error(`임베딩(${provider}): ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error(`임베딩(${provider}) timeout ${P.timeout}ms`)); });
    req.write(body);
    req.end();
  });
}

// 검색어 임베딩. 실패 시 EMBED_FALLBACK(있으면) 한 번 더. 호출자는 실패를 «semantic 팔 강등» 으로 흡수한다.
async function embedQuery(env, text) {
  try { return await embedOnce(EMBED_PROVIDER, env, text); }
  catch (e) {
    if (!EMBED_FALLBACK || EMBED_FALLBACK === EMBED_PROVIDER) throw e;
    console.error('[embed] 1차 실패 → 폴백', EMBED_FALLBACK, '·', e.message.slice(0, 100));
    return embedOnce(EMBED_FALLBACK, env, text);
  }
}

// '--usecase audit' 또는 'audit,recruit' → text[] 파라미터용 배열 (미지정 시 null)
//
// ⚠️ `_shared`(00_공유법령참조)를 항상 포함시킨다. 필터는 `d.usecases && $N::text[]`
//    (배열 겹침)이라, 활용처를 하나라도 걸면 `_shared` 만 달린 문서가 **에러 없이 사라진다**.
//    미매칭 법령은 `backfill_usecase.js:92` 가 `['_shared']` 로 찍는데, 그건 "어느 활용처에도
//    안 맞는다"가 아니라 **"모든 활용처가 공유하는 참조"** 라는 뜻이다 — 제외는 설계 의도 위반.
//    (2026-08-01 온톨로지 4번째 에이전트가 A·B 둘 다 놓친 결함으로 지적. 온톨로지 도입과 무관한 순수 버그.)
//    사용자가 `_shared` 만 콕 집어 조회하는 경우는 그대로 둔다.
function parseUsecase(val) {
  if (!val || val === true) return null;
  const list = String(val).split(',').map(s => s.trim()).filter(s => /^[a-z_]+$/.test(s));
  if (!list.length) return null;
  if (list.length === 1 && list[0] === '_shared') return list;
  return list.includes('_shared') ? list : [...list, '_shared'];
}

// ── 판본(edition) 필터 — S-02/S-03/R03 (2026-10-13 패치셋) ──────────────────────────────────────
// 모든 코퍼스 공통 규칙(기본 = 현행판만):
//   · documents.meta.edition_status 가 있으면 그 값이 current 인 것만(법령·지침: frontmatter, 내규: load_pg.computeEditions 가 적재 때 기록).
//   · 표식이 없는 문서 = current 로 간주. 단 내규는 «구 DB 호환»으로 종전 규칙(같은 inst_code+doc_title 에 doc_date 가 더 큰 형제가 있으면 구판)을 쓴다.
//   · 표식 없는 법령(legal)은 시행일(effective_from 또는 doc_date)이 오늘(KST) 이후면 시행예정으로 보고 제외한다(S-06).
//   · 폐지(meta.repealed='true') 법령은 기본 제외(SEARCH_REPEALED=include 로 포함 — 이 경우에도 응답 row 의 repealed 로 표시된다).
// all_versions=true → 위 규칙 전부 해제(연혁·시행예정·폐지 포함).
// as_of=YYYYMMDD(compact) → 그 날짜에 유효한 판: effective_from <= as_of < effective_to(현행은 to 비어 있음).
//   내규는 형제 판의 doc_date 로 «그 날짜까지의 최신 판» 을 고른다(적재 때 계산한 값에 의존하지 않는다). legal·bylaws 외 코퍼스는 as_of 영향 없음.
// SEARCH_EDITION_FILTER=legacy 면 종전(내규 최신본만)으로 되돌린다 — 롤백 스위치. 파라미터 자리는 동일하게 유지(미사용 파라미터는 PG 가 타입을 못 정해 오류).
const SEARCH_EDITION_FILTER = process.env.SEARCH_EDITION_FILTER || 'on';
if (!['on', 'legacy'].includes(SEARCH_EDITION_FILTER)) throw new Error('SEARCH_EDITION_FILTER 는 on | legacy');
// D4: ca(단체협약) «현행» = 기관·협약 경로 기준 최신 «폴더 연도» 만(문서 날짜가 없어 근사 — load_pg.computeEditions 가 meta 에 기록, 한계는 그쪽 주석).
const SEARCH_CA_LATEST = process.env.SEARCH_CA_LATEST || 'on';
if (!['on', 'off'].includes(SEARCH_CA_LATEST)) throw new Error('SEARCH_CA_LATEST 는 on | off');
const SEARCH_REPEALED = process.env.SEARCH_REPEALED || 'exclude';
if (!['exclude', 'include'].includes(SEARCH_REPEALED)) throw new Error('SEARCH_REPEALED 는 exclude | include');
// 기본 section: all = 본칙·부칙·별표 전부(S-04). 'all' 외 값(예: 본칙)이면 종전 동작.
const SEARCH_DEFAULT_SECTION = process.env.SEARCH_DEFAULT_SECTION || 'all';

// section 인자 → SQL 파라미터(null = 전체). undefined 는 기본값을 쓴다. 'all'·''·true 는 전체.
function sectionParam(args) {
  const v = args.section === undefined ? SEARCH_DEFAULT_SECTION : args.section;
  return (v === undefined || v === null || v === true || v === '' || v === 'all') ? null : String(v);
}
const sectionClause = p => `(${p}::text IS NULL OR a.section = ${p})`;

// 연구회 소관 출연연(documents.meta.scope='extra') 노출 범위. args.scope: 없음·'default' = 제외(355곳 기준 유지), 'extra' = 이 기관들만, 'all' = 둘 다.
// 값은 고정 열거형만 SQL 에 리터럴로 넣는다(파라미터 번호를 건드리지 않는다). SEARCH_SCOPE_FILTER=off 면 종전 SQL 과 글자 그대로 같다(롤백 스위치).
const SEARCH_SCOPE_FILTER = process.env.SEARCH_SCOPE_FILTER || 'on';
if (!['on', 'off'].includes(SEARCH_SCOPE_FILTER)) throw new Error('SEARCH_SCOPE_FILTER 는 on | off');
// scope=extra 의미검색 전용(11-11): 출연연 해시에 붙인 corpora 태그 'bylaws_extra' 의 partial HNSW(idx_emb_hnsw_bylaws_extra)로 후보를 뽑는다.
//   종전 경로는 플래너가 HNSW 를 버리고 출연연 조문 17만 건을 하나씩 정확 계산해 5~7초(콜드 30초 초과)였다. SEARCH_EXTRA_INDEX=off 면 종전 SQL 과 같다(롤백).
//   SEM_EXTRA_MIN_CHARS: 쪽번호·머리글 같은 10자 안팎 조각이 상위를 차지하던 문제 — scope=extra 의미검색에서만 후보 조문의 최소 글자 수(0 이면 끔).
const SEARCH_EXTRA_INDEX = process.env.SEARCH_EXTRA_INDEX || 'on';
if (!['on', 'off'].includes(SEARCH_EXTRA_INDEX)) throw new Error('SEARCH_EXTRA_INDEX 는 on | off');
const SEM_EXTRA_MIN_CHARS = parseInt(process.env.SEM_EXTRA_MIN_CHARS || '30', 10);
if (!(SEM_EXTRA_MIN_CHARS >= 0 && SEM_EXTRA_MIN_CHARS <= 1000)) throw new Error('SEM_EXTRA_MIN_CHARS 는 0~1000 정수');
const EXTRA_TAG = 'bylaws_extra';
const useExtraIndex = args => SEARCH_EXTRA_INDEX === 'on' && SEARCH_SCOPE_FILTER === 'on' && args.scope === 'extra' && (args.corpus === 'all' || args.corpus === 'bylaws');
const extraMinCharsClause = args => (SEARCH_EXTRA_INDEX === 'on' && SEARCH_SCOPE_FILTER === 'on' && args.scope === 'extra' && SEM_EXTRA_MIN_CHARS > 0) ? `\n        AND a.n_chars >= ${SEM_EXTRA_MIN_CHARS}` : '';
function scopeClause(args) {
  if (SEARCH_SCOPE_FILTER === 'off') return '';
  if (args.scope === 'extra') return `\n        AND d.meta->>'scope' = 'extra'`;
  if (args.scope === 'all') return '';
  return `\n        AND COALESCE(d.meta->>'scope', '') <> 'extra'`;
}

// as_of 입력(YYYY-MM-DD | YYYYMMDD | 비움) → 'YYYYMMDD' | null. 형식이 틀리면 BAD_ASOF 오류(조용히 무시하면 «현행» 으로 오답).
function parseAsOf(v) {
  if (v === undefined || v === null || v === '' || v === false) return null;
  const m = String(v).trim().match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  const ok = m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31;
  if (!ok) throw Object.assign(new Error('as_of 는 YYYY-MM-DD 형식이어야 합니다: ' + String(v).slice(0, 20)), { code: 'BAD_ASOF' });
  return m[1] + m[2] + m[3];
}

// 판본 필터 SQL 조각. aP = all_versions(bool) 자리, bP = as_of(text YYYYMMDD) 자리. 5개 SQL 이 «같은 함수» 로 만든다(drift 방지).
function editionClause(aP, bP) {
  if (SEARCH_EDITION_FILTER === 'legacy') {
    return `
        AND (${bP}::text IS NULL OR TRUE)
        AND (d.corpus <> 'bylaws' OR ${aP}::bool OR NOT EXISTS (
          SELECT 1 FROM documents d2
          WHERE d2.corpus = 'bylaws' AND d2.inst_code IS NOT DISTINCT FROM d.inst_code
            AND d2.doc_title = d.doc_title AND d2.doc_date > d.doc_date))`;
  }
  const sib = (extra) => `NOT EXISTS (
            SELECT 1 FROM documents d2
            WHERE d2.corpus = 'bylaws' AND d2.inst_code = d.inst_code   -- «=» 여야 idx_docs_edition(corpus, inst_code, doc_title, doc_date)을 온전히 탄다(IS NOT DISTINCT FROM 은 인덱스 조건이 못 된다 — as_of 가 문서마다 인덱스 범위를 훑었다). bylaws 의 inst_code 는 NULL 이 없다(파서가 폴더에서 채움).
              AND d2.doc_title = d.doc_title AND d2.doc_date > d.doc_date${extra})`;
  const today = `to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYYMMDD')`;
  const from = `replace(COALESCE(NULLIF(d.meta->>'effective_from', ''), d.doc_date, ''), '-', '')`;   // 법령 doc_date 는 '2016-03-01' 형식도 있다 — 하이픈을 떼야 YYYYMMDD 비교가 맞다
  const repealedOk = SEARCH_REPEALED === 'include' ? 'TRUE' : `COALESCE(d.meta->>'repealed', '') <> 'true'`;
  return `
        AND (${aP}::bool OR CASE
          WHEN ${bP}::text IS NOT NULL THEN
            CASE d.corpus
              WHEN 'bylaws' THEN d.doc_date IS NULL OR (d.doc_date <= ${bP} AND ${sib(` AND d2.doc_date <= ${bP}`)})
              WHEN 'legal' THEN ${from} <= ${bP}
                AND (COALESCE(d.meta->>'effective_to', '') = '' OR ${bP} < d.meta->>'effective_to')
                AND NOT (COALESCE(d.meta->>'repealed', '') = 'true' AND COALESCE(d.meta->>'repealed_at', '') <> '' AND d.meta->>'repealed_at' <= ${bP})
              ELSE TRUE END
          ELSE
            CASE WHEN d.corpus = 'ca' THEN ${SEARCH_CA_LATEST === 'on' ? "COALESCE(d.meta->>'edition_status', 'current') = 'current'" : 'TRUE'}
                 WHEN d.meta->>'edition_status' IS NOT NULL THEN d.meta->>'edition_status' = 'current'
                 WHEN d.corpus = 'bylaws' THEN ${sib('')}
                 ELSE TRUE END
            AND (d.corpus <> 'legal' OR ${from} <= ${today})
            AND ${repealedOk}
          END)`;
}

// 응답 row 에 싣는 판본·구분 필드(S-11/S-12). meta 에 표식이 없으면 NULL(= 표식 없음 = 현행 간주) — 'current' 로 지어내지 않는다.
// 내규는 구 DB(적재 때 meta 미계산)에서도 doc_date 로 effective_from 을 채운다.
const EDITION_COLS = `
        a.section   AS section,
        d.meta->>'edition_group'  AS edition_group,
        d.meta->>'edition_status' AS edition_status,
        d.meta->>'edition_basis'  AS edition_basis,   -- 예: folder_year_approx(ca 근사 판정)
        COALESCE(NULLIF(d.meta->>'effective_from', ''), CASE WHEN d.corpus = 'bylaws' AND d.doc_date ~ '^[0-9]{8}$' THEN d.doc_date END) AS effective_from,
        NULLIF(d.meta->>'effective_to', '') AS effective_to,
        COALESCE(d.meta->>'repealed', '') = 'true' AS repealed,
        COALESCE(d.meta->>'lineage_closed', '') = 'true' AS lineage_closed,   -- D3: 현행 판이 없는 폐쇄 계보(예: 예산편성·집행지침)
        NULLIF(d.meta->>'lineage_successor', '') AS lineage_successor`;

// 동점 정렬(D1·D2): 같은 점수에서는 «현행 → 시행예정 → 연혁», «본칙 → 부칙 → 별표», «최신 시행일» 순. 현행 기본 검색에선 사실상 section 만 작동한다.
//   st·sec·fr = 판본 상태·구분·시행일 식(조인 별칭 쓰는 SQL 은 d.meta…·a.section, UNION 바깥은 출력 컬럼명).
const editionTieOrder = (st, sec, fr) => `CASE COALESCE(${st}, 'current') WHEN 'current' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
        CASE ${sec} WHEN '본칙' THEN 0 WHEN '부칙' THEN 1 ELSE 2 END, ${fr} DESC NULLS LAST`;
const TIE_JOIN = editionTieOrder(`d.meta->>'edition_status'`, 'a.section', `COALESCE(NULLIF(d.meta->>'effective_from', ''), d.doc_date)`);
const TIE_OUTER = editionTieOrder('edition_status', 'section', 'COALESCE(effective_from, doc_date)');

// 응답 row 에 판본 상태·경고 표지를 붙인다(API·MCP 가 같은 함수). 현행(표식 없음 포함)이면 edition_state='current' 만, 아니면 edition_warning 문자열도.
//   all_versions·as_of 로 연혁을 받을 때 «이게 현행이 아니다» 가 응답·인용에 남게 한다. 입력 row 는 EDITION_COLS 컬럼을 가진 것.
const fmtD = v => /^\d{8}$/.test(v || '') ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` : v;
function editionWarning(r) {
  const span = r.effective_from ? ` (유효 ${fmtD(r.effective_from)}${r.effective_to ? ' ~ ' + fmtD(r.effective_to) : ' ~'})` : '';
  if (r.repealed) return '폐지된 법령 — 현행 아님(연혁 자료)';
  if (r.lineage_closed) return `폐쇄된 계보 — 현행 판 없음${r.lineage_successor ? '(이후 ' + r.lineage_successor + ' 계보로 통합)' : ''}${span}. 연혁 자료로만 인용할 것`;
  if (r.edition_status === 'scheduled') return `시행예정 판${r.effective_from ? ' (시행 ' + fmtD(r.effective_from) + ')' : ''} — 아직 현행 아님`;
  if (r.edition_status === 'superseded') return `연혁(구판) — 현행 아님${span}${r.edition_basis === 'folder_year_approx' ? ' · 폴더 연도 기준 근사 판정' : ''}`;
  return null;
}
function annotateEdition(rows) {
  return rows.map(r => {
    const w = editionWarning(r);
    const state = r.repealed ? 'repealed' : r.lineage_closed ? 'lineage_closed' : (r.edition_status || 'current');
    return w ? { ...r, edition_state: state, edition_warning: w } : { ...r, edition_state: state };
  });
}

// ── 동일문서 표시·묶기 (2026-10-09 DUP_MARK) ───────────────────────────────────
// documents.meta 의 dup_group(기관|항목|하위경로|본문해시) 를 결과 행에 싣는다.
// 메타 키가 없는 행(법령·내규·옛 적재분)은 NULL → 접히지 않아 기존 동작과 같다.
// COLLAPSE_DUP=0 이면 NULL 상수만 선택(접기 완전 OFF). 컬럼 이름은 collapseDup 가 응답에서 지운다.
// 계열(기간) 표시용 열 — period_label·submitted_at 은 응답에 싣고(없으면 annotateSeries 가 키를 지운다), series_inst 는 내부용(응답 전에 제거).
const SERIES_SEL = `CASE WHEN d.corpus = 'disclosure' THEN d.meta->>'period_label' END AS period_label, CASE WHEN d.corpus = 'disclosure' THEN d.meta->>'submitted_at' END AS submitted_at, CASE WHEN d.corpus = 'disclosure' THEN d.inst_code END AS series_inst`;   // 2026-10-22 next2: 공시만(ca 17,310건에도 submitted_at 이 있어 정렬·응답이 바뀌던 문제 — M1)
const COLLAPSE_DUP = process.env.COLLAPSE_DUP !== '0';
const SERIES_LATEST = process.env.SERIES_LATEST === '1';   // next3: 0(기본)=series_latest·series_note·series_warning·latest_only 미사용(기간 필드·same_doc.rounds 는 항상)
const SERIES_ORDER = process.env.SERIES_ORDER === '1';     // next3: 0(기본)=동점 정렬 현행과 동일, 1=동점이면 공시일 최신 먼저
const SERIES_TIE = SERIES_ORDER ? ', submitted_at DESC NULLS LAST' : '';
const DISCLOSURE_DOC_BRANCH = process.env.DISCLOSURE_DOC_BRANCH === '1';   // 공시 문서명 브랜치(제목 백필 뒤에만 1)
const DUP_COLS = COLLAPSE_DUP
  ? `d.meta->>'dup_group' AS dup_group, COALESCE(a.art_key, a.seq::text) AS dup_chunk, d.doc_id AS real_doc_id, ${SERIES_SEL}`
  : `NULL::text AS dup_group, NULL::text AS dup_chunk, d.doc_id AS real_doc_id, ${SERIES_SEL}`;
// real_doc_id: documents.doc_id 실값(공시 84% 는 corpus:rel_path 와 다르다). MCP withDocId 가 행 doc_id 로 쓰고 API 는 응답에서 뺀다. COLLAPSE_DUP 과 무관하게 항상 SELECT.
// 접기 키 = 기관 | dup_group | 청크(art_key, 없으면 seq): 다른 회차 사본의 «같은 청크»만 접고 같은 파일의 다른 청크는 유지한다(2026-10-21 사용자 확정).
// dup_chunk 는 내부 열 — collapseDup 가 응답에서 지운다(art_key 를 별칭으로 쓰지 않는 이유: anchors=true 일 때 a.art_key AS art_key 와 충돌).

// 의미검색에 필터가 걸렸는지 (2단계 exact 경로 분기 판단용 — api_server/mcp에서 사용)
//   as_of·«명시된» section 도 필터다 — 대표행(embed_queue)만 보는 무필터 경로는 같은 해시의 다른 사본(다른 판·다른 section)을 못 본다.
//   (section 기본값은 «명시» 가 아니므로 포함하지 않는다 — args.section 이 undefined 면 기본값 사용)
// ignorePost=true: 사후 필터(항목·기간)를 «후보 선별 필터» 로 세지 않는다 — buildSemanticQuery 가 HNSW 모양을 정할 때 쓴다(사후 필터는 후보를 받은 뒤 건다).
function semanticHasFilter(args, ignorePost = false) {
  return (!ignorePost && IF.hasPost(args) && IF.appliesTo(args.corpus)) || args.corpus !== 'all' || !!args.type || !!args.inst || !!args.ministry || !!args.usecase || !!args.year
    || !!args.asOf || (args.section !== undefined && sectionParam(args) !== null)
    || args.scope === 'extra' || args.scope === 'all';   // 연구회 소관 출연연: 대표행(embed_queue)은 355곳 사본을 우선하므로 extra 문서는 «모든 사본» 경로에서만 보인다
}
// 암묵 필터(판본·section 기본값)가 걸리는지 — 반복 스캔(S-13) 판단용
function semanticImplicitFilter(args) {
  return (SEARCH_EDITION_FILTER === 'on' && !args.allVersions) || sectionParam(args) !== null;
}

// ── 2단계 하이브리드 (filtered semantic 가속) ─────────────────────────────────
// HNSW+필터(iterative_scan)는 선택적 필터에서 ~7s까지 걸린다(실측). 대신:
//   1단계: SQL로 필터 후보 조문 id를 먼저 좁힌다(btree/GIN — 수십 ms)
//   2단계: 후보가 작으면(기본 ≤2만) HNSW를 타지 않고 후보 내 '정확' 거리계산
// ORDER BY의 `+ 0`은 의도적 — 식이 인덱스 연산자와 달라져 HNSW가 못 붙는다(정확 스캔 보장).
// 후보가 임계 초과면 기존 HNSW 경로로 폴백. (아이디어 출처: turbovec의 allowlist 2단계 패턴)
// 항목·기간 필터 조각(공시 행에만 적용). firstIdx = 첫 값의 $번호. 필터가 없으면 sql='' · params=[] → 기존 SQL 과 글자 그대로 같다.
function postFilter(args, firstIdx, lead = '\n        AND ') {
  const parts = [], params = [];
  if (args.itemCats) { const c = IF.itemClause('$' + (firstIdx + params.length), args.corpus); if (c) { params.push(args.itemCats); parts.push(c); } }   // c=null: 이 코퍼스 질의엔 걸지 않는다
  if (args.period) { const c = IF.periodClause('$' + (firstIdx + params.length), args.period, args.corpus); if (c) { params.push(args.period.val); parts.push(c); } }
  if (args.reportPeriod) { const c = IF.periodClause('$' + (firstIdx + params.length), args.reportPeriod, args.corpus); if (c) { params.push(args.reportPeriod.val); parts.push(c); } }   // G2-A: period_label_adj 기준
  if (args.targetYear) { const c = IF.targetYearClause('$' + (firstIdx + params.length), args.corpus); if (c) { params.push(args.targetYear); parts.push(c); } }   // G2-B: 문서 제목의 20XX년
  return { sql: parts.map(x => lead + x).join(''), params };
}

function buildCandidateIdsQuery(args, limitPlusOne) {
  const pf = postFilter(args, 11);
  return {
    sql: `
      SELECT a.id
      FROM articles a
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)
      WHERE ${sectionClause('$1')}
        AND ($2 = 'all' OR d.corpus = $2)
        AND ($3::text IS NULL OR d.doc_type ILIKE '%'||$3||'%')
        AND ($4::text IS NULL OR i.inst_name ILIKE '%'||$4||'%')
        AND ($5::text IS NULL OR i.ministry ILIKE '%'||$5||'%')
        AND ($6::text[] IS NULL OR d.usecases && $6::text[])
        AND ($8::text IS NULL OR d.doc_date LIKE $8||'%')${editionClause('$9', '$10')}${scopeClause(args)}${pf.sql}
      LIMIT $7`,
    params: [sectionParam(args), args.corpus, args.type, args.inst, args.ministry, args.usecase, limitPlusOne, args.year || null, !!args.allVersions, args.asOf || null, ...pf.params],
  };
}

function buildSemanticExactQuery(vecStr, ids, limit) {
  return {
    sql: `
      SELECT
        i.inst_name AS inst_name,
        i.ministry  AS ministry,
        d.doc_title AS doc_title,
        d.doc_type  AS doc_type,
        d.corpus    AS corpus,
        d.category  AS category,   -- 공시항목(43005_G(지배구조) 등) — DB 채움률 100%인데 응답에 없었다(2026-09-22)
        d.rel_path  AS rel_path,
        CASE WHEN a.art_no IS NOT NULL THEN '제'||a.art_no||'조'||COALESCE('의'||a.art_sub::text,'') ELSE '' END AS art_ref,
        a.title     AS art_title,
        a.body      AS body,
        a.n_chars   AS n_chars,
        d.doc_date  AS doc_date,${EDITION_COLS},
        ${DUP_COLS},
        ROUND((1 - (e.embedding <=> $1::vector(1024)))::numeric, 3) AS score
      FROM articles a
      JOIN article_hash h ON h.id = a.id
      JOIN article_embeddings e ON e.text_hash = h.text_hash
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)
      WHERE a.id = ANY($2::bigint[])
      ORDER BY (e.embedding <=> $1::vector(1024)) + 0, ${TIE_JOIN}
      LIMIT $3`,
    params: [vecStr, ids, limit],
  };
}

// corpus 레이아웃 질의 — 코퍼스(들)마다 «partial 인덱스로 후보» 를 뽑아 UNION 하고, 이후는 단일 레이아웃과 같은 정확 재정렬.
//   params: …$8=limit … 뒤에 $12=SEM_CAND_N(최소 limit), 비트 코퍼스가 있으면 $13=SEM_BIT_CAND.
function buildCorpusLayoutQuery({ args, SEL, join, WHERE, params, hasFilter, implicitFilter, post }) {
  const candN = Math.max(SEM_CAND_N, args.limit);
  const extraIdx = useExtraIndex(args);   // scope=extra: 출연연은 bylaws 뿐이라 다른 코퍼스 인덱스는 돌지 않는다
  let corpora = extraIdx ? ['bylaws'] : args.corpus === 'all' ? Object.keys(CORPUS_HNSW_Q) : [args.corpus].filter(c => CORPUS_HNSW_Q[c]);
  if (!corpora.length) corpora = ['legal'];   // 알 수 없는 코퍼스 값 — WHERE d.corpus = $3 이 전부 걸러 0건(기존 동작과 같다)
  const needBit = corpora.some(c => CORPUS_HNSW_Q[c] === 'bit');
  // 사후 필터 + 비트 코퍼스만(예: disclosure)이면 «후보 100 절단» 이 없어 $12(candN) 를 쓰지 않는다 — 쓰지 않는 파라미터는 PG 가 타입을 못 정해 오류이므로 자리 자체를 뺀다.
  const needCand = !post || corpora.some(c => CORPUS_HNSW_Q[c] !== 'bit');
  const candPh = '$12', bitPh = needCand ? '$13' : '$12';
  const P = [...params, ...(needCand ? [candN] : []), ...(needBit ? [SEM_BIT_CAND] : [])];
  // 사후 필터(항목·기간, ITEM_FILTER): HNSW 후보(비트 4,000)를 «그대로» 받은 뒤 바깥 SELECT 의 WHERE 에서만 건다 — 후보 단계 SQL(EXISTS 포함)에는 넣지 않는다(플래너가 HNSW 를 버리지 않게).
  //   그래서 비트 후보를 exact 로 100개(SEM_CAND_N)로 줄이는 단계를 건너뛰고 4,000 전부를 바깥에서 거른 뒤 정확 거리로 정렬한다(좁은 항목도 후보 안의 정답을 잃지 않는다).
  let postSql = '';
  if (post) { const pf = postFilter({ ...post, corpus: args.corpus }, P.length + 1); postSql = pf.sql; P.push(...pf.params); }
  const shaped = hasFilter || !!post;   // 바깥에서 «모든 사본(article_hash)» 을 펼쳐 거르는 모양
  const FROM_UNF = `FROM article_embeddings e ${join} JOIN documents d USING(doc_id) LEFT JOIN institutions i USING(inst_code)`;
  const EXISTS = `EXISTS (
          SELECT 1 FROM article_hash h
          JOIN articles a ON a.id = h.id
          JOIN documents d USING(doc_id)
          LEFT JOIN institutions i USING(inst_code)
          ${WHERE.replace(/^WHERE /, 'WHERE h.text_hash = e.text_hash AND ')}${extraIdx ? '\n          LIMIT 1 OFFSET 0' : ''})`;   // LIMIT 1 OFFSET 0(LIMIT 만으로는 PG 가 EXISTS 에서 떼어낸다): 세미조인으로 풀리면 플래너가 부분 HNSW 를 버리고 출연연 14만 건을 전부 정렬한다(실측 4~37초) — 상관 서브쿼리로 남겨 인덱스 순서대로 후보를 거른다
  const branch = c => {
    const bit = CORPUS_HNSW_Q[c] === 'bit', ord = corpusOrderQ(c, '$1::vector(1024)'), pred = extraIdx ? `e.corpora @> ARRAY['${EXTRA_TAG}']::text[]` : corpusPredQ(c);
    if (!shaped) {
      const inner = `SELECT a.id AS aid, e.text_hash AS th${bit ? ', e.embedding AS emb' : ''}
          ${FROM_UNF}
          ${WHERE} AND ${pred}
          ORDER BY ${ord}
          LIMIT ${bit ? bitPh : candPh}`;
      return bit ? `(SELECT x.aid, x.th FROM (${inner}) x ORDER BY x.emb <=> $1::vector(1024) LIMIT ${candPh})` : `(${inner})`;
    }
    const inner = `SELECT e.text_hash AS th${bit && !post ? ', e.embedding AS emb' : ''}
          FROM article_embeddings e
          WHERE ${pred}${hasFilter ? ` AND ${EXISTS}` : ''}
          ORDER BY ${ord}
          LIMIT ${bit ? bitPh : candPh}`;
    return bit && !post ? `(SELECT x.th FROM (${inner}) x ORDER BY x.emb <=> $1::vector(1024) LIMIT ${candPh})` : `(${inner})`;
  };
  const cand = `WITH cand AS (\n        ${corpora.map(branch).join('\n        UNION\n        ')}\n      )`;
  if (!shaped) {
    return { hasFilter, implicitFilter, candN, layout: 'corpus', sql: `
      ${cand}
      SELECT ${SEL}
      FROM cand c
      JOIN articles a ON a.id = c.aid
      JOIN article_embeddings e ON e.text_hash = c.th
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)
      ORDER BY e.embedding <=> $1::vector(1024)
      LIMIT $8`, params: P };
  }
  if (post) {
    // 사후 필터 2단계(2026-10-22 실측): 후보(비트 4,000 해시)를 바깥에서 «벡터까지 조인한 채» 거르고 정렬하면 플래너가 전 임베딩을 정렬하는 계획(수십 초)으로 갈 수 있다.
    //   그래서 ① 후보 CTE(그대로) + 필터 → 통과한 (article id, text_hash) 만 돌려받고(벡터·본문 없음)
    //        ② 통과 해시만 정확 거리로 상위 K → 그 해시의 통과 사본을 펼쳐 본문과 함께 상위 limit (stage2). 두 단계는 같은 세션에서 실행한다(runSemanticPost).
    //   ①의 $8 은 «반환 id 상한»(SEM_POST_IDS_MAX) — 원래 limit 자리를 PG 가 타입 추론하도록 실사용한다.
    const P1 = [...P]; P1[7] = SEM_POST_IDS_MAX;
    const stage2 = (hashes, ids, lim) => ({ sql: `
      WITH top AS (
        SELECT e.text_hash AS th, (e.embedding <=> $1::vector(1024)) + 0 AS dist
        FROM article_embeddings e
        WHERE e.text_hash = ANY($2::text[])
        ORDER BY dist
        LIMIT $3
      )
      SELECT ${SEL.replace('ROUND((1 - (e.embedding <=> $1::vector(1024)))::numeric, 3) AS score', 'ROUND((1 - t.dist)::numeric, 3) AS score')}
      FROM top t
      JOIN article_hash h ON h.text_hash = t.th AND h.id = ANY($4::bigint[])
      JOIN articles a ON a.id = h.id
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)
      ORDER BY t.dist, ${TIE_JOIN}
      LIMIT $3`, params: [params[0], hashes, lim, ids] });
    return { hasFilter, implicitFilter, candN, layout: 'corpus', post: true, stage2, sql: `
      ${cand}
      SELECT a.id AS aid, c.th AS th
      FROM cand c
      JOIN article_hash h ON h.text_hash = c.th
      JOIN articles a ON a.id = h.id
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)
      ${WHERE}${postSql}
      LIMIT $8`, params: P1 };
  }
  return { hasFilter, implicitFilter, candN, layout: 'corpus', sql: `
      ${cand}
      SELECT ${SEL}
      FROM cand c
      JOIN article_hash h ON h.text_hash = c.th
      JOIN articles a ON a.id = h.id
      JOIN article_embeddings e ON e.text_hash = c.th
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)
      ${WHERE}
      ORDER BY e.embedding <=> $1::vector(1024), ${TIE_JOIN}
      LIMIT $8`, params: P };
}

// 사후 필터 질의 실행(① 후보+필터 → ② 정확 거리 상위). c = 세션(SET LOCAL 이 이미 걸린 pg client). post 가 아닌 q 는 종전대로 한 번에 실행.
//   반환: rows (+ rows.postStats = {passed_ids, passed_hashes, capped})
async function runSemanticPost(c, q, lim) {
  const r1 = (await c.query(q.sql, q.params)).rows;
  if (!r1.length) { const out = []; out.postStats = { passed_ids: 0, passed_hashes: 0, capped: false }; return out; }
  const hashes = [...new Set(r1.map(r => r.th))], ids = r1.map(r => r.aid);
  const s2 = q.stage2(hashes, ids, lim);
  const out = (await c.query(s2.sql, s2.params)).rows;
  out.postStats = { passed_ids: ids.length, passed_hashes: hashes.length, capped: r1.length >= SEM_POST_IDS_MAX };
  return out;
}

function buildSemanticQuery(vecStr, args) {
  // 필터가 있으면 article_hash로 모든 사본을 대상(기관 필터 등이 대표조문에 안 걸리는 문제 방지),
  // 없으면 embed_queue 대표조문만(중복 제거). 대표행은 load_pg 가 «current·최신 doc 우선» 으로 고른다(S-03).
  const hasFilter = semanticHasFilter(args, true);
  const implicitFilter = semanticImplicitFilter(args);
  const post = (IF.hasPost(args) && IF.appliesTo(args.corpus)) ? { itemCats: args.itemCats || null, period: args.period || null, reportPeriod: args.reportPeriod || null, targetYear: args.targetYear || null } : null;
  const join = (hasFilter || post)
    ? 'JOIN article_hash h USING(text_hash) JOIN articles a ON a.id = h.id'
    : 'JOIN embed_queue q USING(text_hash) JOIN articles a ON a.id = q.id';
  const SEL = `
        i.inst_name AS inst_name,
        i.ministry  AS ministry,
        d.doc_title AS doc_title,
        d.doc_type  AS doc_type,
        d.corpus    AS corpus,
        d.category  AS category,   -- 공시항목(43005_G(지배구조) 등) — DB 채움률 100%인데 응답에 없었다(2026-09-22)
        d.rel_path  AS rel_path,
        CASE WHEN a.art_no IS NOT NULL THEN '제'||a.art_no||'조'||COALESCE('의'||a.art_sub::text,'') ELSE '' END AS art_ref,
        a.title     AS art_title,
        a.body      AS body,
        a.n_chars   AS n_chars,
        d.doc_date  AS doc_date,${EDITION_COLS},
        ${DUP_COLS},
        -- args.anchors=true 일 때만(리랭커 등 «후보 원문을 받는» 내부 호출용): 앵커 3종. 기본 응답 키는 그대로다.
        ${args.anchors ? 'a.doc_id AS doc_id, a.art_key AS art_key, e.text_hash AS text_hash,' : ''}
        ROUND((1 - (e.embedding <=> $1::vector(1024)))::numeric, 3) AS score`;
  // $2 section(null=전체) · $10 all_versions · $11 as_of — 필터 조각은 5개 SQL 이 같은 함수(sectionClause·editionClause)를 쓴다.
  const WHERE = `WHERE ${sectionClause('$2')}
        AND ($3 = 'all' OR d.corpus = $3)
        AND ($4::text IS NULL OR d.doc_type ILIKE '%'||$4||'%')
        AND ($5::text IS NULL OR i.inst_name ILIKE '%'||$5||'%')
        AND ($6::text IS NULL OR i.ministry ILIKE '%'||$6||'%')
        AND ($7::text[] IS NULL OR d.usecases && $7::text[])
        AND ($9::text IS NULL OR d.doc_date LIKE $9||'%')${editionClause('$10', '$11')}${scopeClause(args)}${extraMinCharsClause(args)}`;
  const params = [vecStr, sectionParam(args), args.corpus, args.type, args.inst, args.ministry, args.usecase, args.limit, args.year || null, !!args.allVersions, args.asOf || null];
  if (semLayout === 'corpus') return buildCorpusLayoutQuery({ args, SEL, join, WHERE, params, hasFilter, implicitFilter, post });
  // 비-corpus 레이아웃(SEM_LAYOUT=single 롤백용): 후보 단계 필터와 같은 EXISTS 형 — 느릴 수 있다(항목·기간은 이 레이아웃에서 «사후» 가 아니다).
  const tailPf = post ? postFilter({ ...post, corpus: args.corpus }, (semIndex === 'vector' ? 11 : 12) + 1) : { sql: '', params: [] };
  const WHEREP = WHERE + tailPf.sql;
  if (semIndex === 'vector') {   // 레거시: vector 인덱스를 직접
    return { hasFilter: hasFilter || !!post, implicitFilter, sql: `
      SELECT ${SEL}
      FROM article_embeddings e
      ${join}
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)
      ${WHEREP}
      ORDER BY ${semanticOrderBy('e.embedding', '$1::vector(1024)')}
      LIMIT $8`, params: [...params, ...tailPf.params] };
  }
  // halfvec: ① cand — 인덱스로 후보 $12 개(필터는 여기서 건다. 필터 질의는 iterative_scan 필요)
  //          ② 원본 vector 로 정확 거리 재계산 → score(= 1 - 코사인 거리)·정렬 → 상위 $8
  //   cand 는 키만 들고 가서, 본문 TOAST 읽기는 최종 후보에만 일어난다.
  const candN = Math.max(SEM_CAND_N, args.limit);
  if (!hasFilter && !post) {
    // 대표행 경로 — 해시당 1행이라 후보창이 중복에 잠식되지 않는다.
    return { hasFilter, implicitFilter, candN, sql: `
      WITH cand AS (
        SELECT a.id AS aid, e.text_hash AS th
        FROM article_embeddings e
        ${join}
        JOIN documents d USING(doc_id)
        LEFT JOIN institutions i USING(inst_code)
        ${WHERE}
        ORDER BY ${semanticOrderBy('e.embedding', '$1::vector(1024)')}
        LIMIT $12
      )
      SELECT ${SEL}
      FROM cand c
      JOIN articles a ON a.id = c.aid
      JOIN article_embeddings e ON e.text_hash = c.th
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)
      ORDER BY e.embedding <=> $1::vector(1024)
      LIMIT $8`, params: [...params, candN] };
  }
  // 필터 경로(S-09) — cand 는 «text_hash 단위» 로 센다: 필터에 맞는 사본이 하나라도 있는 해시만 후보(EXISTS)이고
  //   후보창($12)은 해시 N개. 같은 벡터가 3,899개 사본으로 후보창을 독점하던 문제가 없다.
  //   그 뒤(②)에 필터에 맞는 «사본 전체» 를 펼쳐 거리 순(동점은 최신 doc_date)으로 상위 $8 을 돌려준다.
  //   ⚠️ EXISTS 안쪽 조회가 article_hash(text_hash) 인덱스를 전제한다(load_pg INDEXES 의 idx_article_hash_th).
  return { hasFilter: hasFilter || !!post, implicitFilter, candN, sql: `
      WITH cand AS (
        SELECT e.text_hash AS th
        FROM article_embeddings e
        WHERE EXISTS (
          SELECT 1 FROM article_hash h
          JOIN articles a ON a.id = h.id
          JOIN documents d USING(doc_id)
          LEFT JOIN institutions i USING(inst_code)
          ${WHEREP.replace(/^WHERE /, 'WHERE h.text_hash = e.text_hash AND ')}
        )
        ORDER BY ${semanticOrderBy('e.embedding', '$1::vector(1024)')}
        LIMIT $12
      )
      SELECT ${SEL}
      FROM cand c
      JOIN article_hash h ON h.text_hash = c.th
      JOIN articles a ON a.id = h.id
      JOIN article_embeddings e ON e.text_hash = c.th
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)
      ${WHEREP}
      ORDER BY e.embedding <=> $1::vector(1024), ${TIE_JOIN}
      LIMIT $8`, params: [...params, candN, ...tailPf.params] };
}

function parseArgs(argv) {
  const args = { keyword: '', corpus: 'all', type: null, inst: null, ministry: null,
                  usecase: null, year: null, understand: false, allVersions: false,
                  limit: 15, section: undefined, asOf: null, json: false, csv: false, full: false, body: false,
                  semantic: false, sort: 'relevance' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (key === 'limit') args.limit = Math.min(100, Math.max(1, parseInt(val) || 15));
      else if (key === 'corpus') args.corpus = val;
      else if (key === 'type') args.type = val;
      else if (key === 'inst') args.inst = val;
      else if (key === 'ministry') args.ministry = val;
      else if (key === 'usecase') args.usecase = parseUsecase(val);
      else if (key === 'year') args.year = /^\d{4}$/.test(String(val)) ? String(val) : null;
      else if (key === 'understand') args.understand = true;
      else if (key === 'all-versions') args.allVersions = true;
      else if (key === 'as-of') args.asOf = parseAsOf(val);
      else if (key === 'section') args.section = val;
      else if (key === 'body') args.body = true;
      else if (key === 'semantic') args.semantic = true;
      else if (key === 'sort') args.sort = (val === 'recent') ? 'recent' : 'relevance';
      else if (key === 'json') args.json = true;
      else if (key === 'csv') args.csv = true;
      else if (key === 'full') args.full = true;
    } else if (!args.keyword) {
      args.keyword = a;
    }
  }
  return args;
}

// sort=recent면 개정일 우선(없으면 최후미), 아니면 기존 관련도 정렬.
function recencyPrefix(args, col) { return args.sort === 'recent' ? `${col} DESC NULLS LAST, ` : ''; }

// 다중 키워드(OR/AND) 지원: 필터 파라미터가 원래 $2부터 시작하는 SQL 조각에서,
// 항(term) 개수만큼 늘어난 자리($1..$n)를 감안해 $2 이상의 번호를 shift만큼 밀어준다.
function shiftPlaceholders(sql, shift) {
  return shift ? sql.replace(/\$(\d+)/g, (_, d) => '$' + (parseInt(d, 10) + shift)) : sql;
}

// 키워드에 대문자 ` OR `/` AND `(양쪽 공백)가 있으면 항을 분리 — 혼합은 비범위(OR 우선 감지).
// 연산자가 없으면 null(기존 단일검색 경로 그대로).
// 가운뎃점 표기 변형 — 항에 ㆍ/· 가 있으면 [원형, 다른 표기] , 없으면 [원형]. (질의 정규화는 md 가 아니라 여기서 — 체크리스트 결정 3)
const DOT_A = '\u318d', DOT_B = '\u00b7';
function middleDotVariants(t) {
  const out = [t];
  if (t.includes(DOT_A)) out.push(t.split(DOT_A).join(DOT_B));
  if (t.includes(DOT_B)) out.push(t.split(DOT_B).join(DOT_A));
  if (t.includes(DOT_A) && t.includes(DOT_B)) { out.push(t.split(DOT_A).join(DOT_B)); out.push(t.split(DOT_B).join(DOT_A)); }
  return [...new Set(out)];
}

function splitBooleanKeyword(keyword) {
  let op = null;
  if (/ OR /.test(keyword)) op = 'OR';
  else if (/ AND /.test(keyword)) op = 'AND';
  if (!op) return null;
  const terms = keyword.split(op === 'OR' ? ' OR ' : ' AND ').map(s => s.trim()).filter(Boolean);
  return terms.length >= 2 ? { op, terms } : null;
}

function buildQuery(args) {
  // 1) 제N조 패턴 감지 → 조번호 직접 검색
  const artMatch = args.keyword.match(/제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/);
  if (artMatch) {
    const artNo = parseInt(artMatch[1]);
    const artSub = artMatch[2] ? parseInt(artMatch[2]) : null;
    const pfA = postFilter(args, 13);
    return {
      sql: `
        SELECT
          i.inst_name AS inst_name,
          i.ministry  AS ministry,
          d.doc_title AS doc_title,
          d.doc_type  AS doc_type,
          d.corpus    AS corpus,
        d.category  AS category,   -- 공시항목(43005_G(지배구조) 등) — DB 채움률 100%인데 응답에 없었다(2026-09-22)
          d.rel_path  AS rel_path,
          CASE WHEN a.art_no IS NOT NULL THEN '제'||a.art_no||'조'||COALESCE('의'||a.art_sub::text,'') ELSE '' END AS art_ref,
          a.title     AS art_title,
          a.body      AS body,
          a.n_chars   AS n_chars,
          d.doc_date  AS doc_date,${EDITION_COLS},
          ${DUP_COLS},
          1.0::real   AS score
        FROM articles a
        JOIN documents d USING(doc_id)
        LEFT JOIN institutions i USING(inst_code)
        WHERE a.art_no = $1
          AND ($2::int IS NULL OR a.art_sub = $2)
          AND ${sectionClause('$3')}
          AND ($4 = 'all' OR d.corpus = $4)
          AND ($5::text IS NULL OR d.doc_type ILIKE '%'||$5||'%')
          AND ($6::text IS NULL OR i.inst_name ILIKE '%'||$6||'%')
          AND ($7::text IS NULL OR i.ministry ILIKE '%'||$7||'%')
          AND ($8::text[] IS NULL OR d.usecases && $8::text[])
          AND ($10::text IS NULL OR d.doc_date LIKE $10||'%')${editionClause('$11', '$12')}${scopeClause(args)}${pfA.sql}
        ORDER BY ${recencyPrefix(args, 'd.doc_date')}CASE d.corpus WHEN 'legal' THEN 0 WHEN 'ca' THEN 1 ELSE 2 END, ${TIE_JOIN}, inst_name
        LIMIT $9`,
      params: [artNo, artSub, sectionParam(args), args.corpus, args.type, args.inst, args.ministry, args.usecase, args.limit, args.year || null, !!args.allVersions, args.asOf || null, ...pfA.params]
    };
  }

  // 2) 일반 키워드: title % 로 후보 → similarity 정렬
  //    --body 시 본문 ILIKE 포함 (body trgm GIN 인덱스가 ILIKE 가속)
  //    OR/AND: 대문자 ` OR `/` AND `로 여러 항 결합 시 각 항을 $1..$n에 바인딩하고
  //    이후 필터 파라미터($2..$10)는 (n-1)만큼 shift. 연산자 없으면(n=1) 기존과 완전 동일.
  const boolKw = splitBooleanKeyword(args.keyword);
  const rawTerms = (boolKw ? boolKw.terms : [args.keyword]).map(t => t.slice(0, 40));
  // S-14: 가운뎃점 표기(ㆍ U+318D / · U+00B7)를 양쪽 다 찾는다 — 항마다 «표기 변형» 을 OR 로 묶는다(항 사이는 기존 OR/AND).
  const groups = []; const terms = [];
  for (const t of rawTerms) { const g = []; for (const v of middleDotVariants(t)) { g.push(terms.length + 1); terms.push(v); } groups.push(g); }
  const n = terms.length;          // 바인딩된 항 수($1..$n) — 필터 파라미터는 n-1 만큼 밀린다
  const paramShift = n - 1;
  // 조문 단위 히트: 조문 제목(--body 시 본문 부분문자열 포함) 매칭. 항이 여럿이면 (c1 OR/AND c2 ...)로 결합.
  // 🔴 `--body` 는 `ILIKE` 가 아니라 `lower(...) LIKE lower(...)` 다 (2026-09-19).
  //    의미는 ILIKE 와 동일하지만, `gin_bigm_ops` 가 지원하는 연산자가 `~~`(LIKE)와 `=%` 뿐이라
  //    **ILIKE 로 쓰면 bigm 인덱스를 플래너가 쓰지 못한다**(실측 8/8 Seq Scan · 2.1~2.3초).
  //    이 형태여야 `idx_articles_title_bigm`·`idx_articles_body_bigm` 을 탄다.
  //    trgm 은 3그램이라 「연차」 같은 2글자 한글에서 인덱스를 못 타 순차스캔으로 떨어졌었다
  //    (실측 2,241ms → bigm 4ms). load_pg.js 의 인덱스 정의와 «식이 같아야» 한다 —
  //    한쪽만 바꾸면 오류 없이 조용히 순차스캔으로 돌아간다.
  const artHitAt = i => args.body
    ? `(lower(a.title) LIKE '%'||lower($${i})||'%' OR lower(a.body) LIKE '%'||lower($${i})||'%')`
    : `a.title % $${i}`;
  const docCondAt = i => `(d.doc_title % $${i} OR d.alias % $${i})`;
  // 변형이 없는 항은 종전과 «글자 그대로» 같은 식(괄호 추가 없음) — 기존 시험·플랜 캐시 영향 최소화
  const joinGroup = (g, at) => g.length === 1 ? at(g[0]) : `(${g.map(at).join(' OR ')})`;
  const combine = at => boolKw
    ? `(${groups.map(g => joinGroup(g, at)).join(` ${boolKw.op} `)})`
    : joinGroup(groups[0], at);
  const artHit = combine(artHitAt);
  // 문서명(doc_title/alias) 매칭도 동일하게 항별 결합(일반 코퍼스 UNION 브랜치용).
  const docCond = combine(docCondAt);
  // score: 항·변형별 유사도 중 최댓값(GREATEST) — 단일이면 기존과 동일한 단일 식.
  const scoreExpr = n > 1
    ? `GREATEST(${terms.map((_, idx) => `similarity(a.title, $${idx + 1})`).join(', ')})`
    : `similarity(a.title, $1)`;
  const docScoreExpr = n > 1
    ? `GREATEST(${terms.map((_, idx) => `similarity(d.doc_title, $${idx + 1}), COALESCE(similarity(d.alias, $${idx + 1}), 0)`).join(', ')})`
    : `GREATEST(similarity(d.doc_title, $1), COALESCE(similarity(d.alias, $1), 0))`;
  const limitPh = `$${n + 7}`;
  const artRef = `CASE WHEN a.art_no IS NOT NULL THEN '제'||a.art_no||'조'||COALESCE('의'||a.art_sub::text,'') ELSE '' END`;
  const cols = `
        i.inst_name AS inst_name,
        i.ministry  AS ministry,
        d.doc_title AS doc_title,
        d.doc_type  AS doc_type,
        d.corpus    AS corpus,
        d.category  AS category,   -- 공시항목(43005_G(지배구조) 등) — DB 채움률 100%인데 응답에 없었다(2026-09-22)
        d.rel_path  AS rel_path,
        ${artRef} AS art_ref,
        a.title     AS art_title,
        a.body      AS body,
        a.n_chars   AS n_chars,
        d.doc_date  AS doc_date,${EDITION_COLS},
        ${DUP_COLS}`;
  const from = `
      FROM articles a
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)`;
  const pfG = postFilter(args, 12);   // 항목·기간(없으면 '' · []): 기존 번호 뒤 $12.. — 아래 shiftPlaceholders 가 항 수만큼 함께 민다
  const filter = shiftPlaceholders(`
        AND ${sectionClause('$2')}
        AND ($3 = 'all' OR d.corpus = $3)
        AND ($4::text IS NULL OR d.doc_type ILIKE '%'||$4||'%')
        AND ($5::text IS NULL OR i.inst_name ILIKE '%'||$5||'%')
        AND ($6::text IS NULL OR i.ministry ILIKE '%'||$6||'%')
        AND ($7::text[] IS NULL OR d.usecases && $7::text[])
        AND ($9::text IS NULL OR d.doc_date LIKE $9||'%')${editionClause('$10', '$11')}${scopeClause(args)}${pfG.sql}`, paramShift);
  const filterParams = [...terms, sectionParam(args), args.corpus, args.type, args.inst, args.ministry, args.usecase, args.limit, args.year || null, !!args.allVersions, args.asOf || null, ...pfG.params];
  // 항목 목록 모드(item_next): 항목이 정해졌고 키워드가 «항목명 그 자체»(본문에 없는 말)면 본문 매칭 없이 «그 항목 문서» 를 제출일 최신순으로 돌려준다.
  //   (본문 doc_title 이 'content' 라 항목명 키워드는 어떤 청크 제목·문서명에도 안 걸린다 — 기준선 keyword 0.) 문서 단위로 좁힌 뒤 대표 청크 1건을 LATERAL 로 붙인다.
  if (args.itemCats && args.itemList && args.corpus === 'disclosure') {
    const pl = postFilter({ period: args.period, reportPeriod: args.reportPeriod, targetYear: args.targetYear, corpus: 'disclosure' }, 9);
    return {
      sql: `
        SELECT ${cols},
               1.0::real AS score
        FROM (SELECT d.doc_id FROM documents d LEFT JOIN institutions i USING(inst_code)
               WHERE d.corpus = 'disclosure' AND d.category = ANY($1::text[])
                 AND ($3::text IS NULL OR d.doc_type ILIKE '%'||$3||'%')
                 AND ($4::text IS NULL OR i.inst_name ILIKE '%'||$4||'%')
                 AND ($5::text IS NULL OR i.ministry ILIKE '%'||$5||'%')
                 AND ($6::text[] IS NULL OR d.usecases && $6::text[])
                 AND ($7::text IS NULL OR d.doc_date LIKE $7||'%')${pl.sql}
               ORDER BY (d.doc_title = 'content') DESC, d.meta->>'submitted_at' DESC NULLS LAST, d.doc_id LIMIT $8) m
        JOIN documents d ON d.doc_id = m.doc_id
        LEFT JOIN institutions i USING(inst_code)
        JOIN LATERAL (SELECT a.* FROM articles a WHERE a.doc_id = m.doc_id AND ${sectionClause('$2')}
                       ORDER BY a.art_no NULLS LAST, a.id LIMIT 1) a ON true
        ORDER BY (d.doc_title = 'content') DESC, d.meta->>'submitted_at' DESC NULLS LAST, d.doc_id`,
      params: [args.itemCats, sectionParam(args), args.type, args.inst, args.ministry, args.usecase, args.year || null, args.limit, ...pl.params]
    };
  }
  // 공시자료는 청크 제목(a.title)이 곧 문서명(doc_title)이라 문서명 브랜치가 중복이었다(UNION 생략으로 가속).
  // 🔴 2026-10-22: content형 공시 문서의 doc_title 을 «항목명+기간» 으로 보정(백필)하면 청크 제목은 'content' 그대로라 문서명 브랜치가 필요하다.
  //   DISCLOSURE_DOC_BRANCH=1 (백필 완료 뒤에만 켠다 — 기본 0 = 종전 SQL 그대로)일 때 meta.title_src 표식이 있는 공시 문서만
  //   «문서 단위로 먼저 좁힌 뒤(documents 만: doc_title/alias trgm) 대표 청크 1건을 LATERAL 로» 붙인다(청크 전체 join·정렬을 피함 — a.body 는 상위 limit 건에만 읽는다).
  const docBranchOn = DISCLOSURE_DOC_BRANCH && (args.corpus === 'disclosure' || args.corpus === 'all');
  const filterDoc = filter.replace(shiftPlaceholders(`
        AND ${sectionClause('$2')}`, paramShift), '');   // 문서 단위 단계에는 a.section 조건이 없다(대표 청크 쪽에서 건다)
  if (docBranchOn && filterDoc === filter) throw new Error('filterDoc 치환 실패');
  const docBranch = `
        (SELECT ${cols},
                m.dscore AS score
         FROM (SELECT d.doc_id, ROUND(${docScoreExpr}::numeric, 3) AS dscore
                 FROM documents d LEFT JOIN institutions i USING(inst_code)
                WHERE ${docCond} AND d.corpus = 'disclosure' AND d.meta->>'title_src' IS NOT NULL${filterDoc}
                ORDER BY dscore DESC, d.doc_id LIMIT ${limitPh}) m
         JOIN documents d ON d.doc_id = m.doc_id
         LEFT JOIN institutions i USING(inst_code)
         JOIN LATERAL (SELECT a.* FROM articles a WHERE a.doc_id = m.doc_id AND ${shiftPlaceholders(sectionClause('$2'), paramShift)}
                        ORDER BY a.art_no NULLS LAST, a.id LIMIT 1) a ON true)`;
  const artBranch = `
        (SELECT ${cols},
                ROUND(${scoreExpr}::numeric, 3) AS score
         ${from}
         WHERE ${artHit}${filter})`;
  const outCols = `inst_name, ministry, doc_title, doc_type, corpus, category, rel_path,
             art_ref, art_title, body, n_chars, score, doc_date,
             section, edition_group, edition_status, edition_basis, effective_from, effective_to, repealed, lineage_closed, lineage_successor, dup_group, dup_chunk, real_doc_id, period_label, submitted_at, series_inst`;
  if (args.corpus === 'disclosure') {
    // 동점이면 같은 기관 안에서 공시일 최신 먼저(inst_name 뒤 — 기관 간 순서는 종전과 같다). submitted_at 은 SERIES_SEL 별칭.
    return {
      sql: docBranchOn ? `
        SELECT ${outCols}
        FROM (${artBranch}
        UNION ALL${docBranch}) t
        ORDER BY ${recencyPrefix(args, 'doc_date')}score DESC, inst_name${SERIES_TIE}
        LIMIT ${limitPh}` : `
        SELECT ${cols},
               ROUND(${scoreExpr}::numeric, 3) AS score
        ${from}
        WHERE ${artHit}${filter}
        ORDER BY ${recencyPrefix(args, 'd.doc_date')}score DESC, inst_name${SERIES_TIE}
        LIMIT ${limitPh}`,
      params: filterParams
    };
  }
  // 그 외: 조문 단위 매칭 + 법령/문서 이름 매칭(문서당 대표 1건)을 UNION.
  // 각 브랜치가 자기 trgm 인덱스를 타므로 교차 테이블 OR의 전수스캔을 피한다.
  // docBranchOn(all)일 때는 공시 문서를 종전 문서명 브랜치에서 빼고(청크 히트와 중복) 위의 가벼운 공시 브랜치로 대신한다.
  return {
    sql: `
      SELECT ${outCols}
      FROM (${artBranch}
        UNION ALL
        (SELECT DISTINCT ON (d.doc_id) ${cols},
                ROUND(${docScoreExpr}::numeric, 3) AS score
         ${from}
         WHERE ${docCond}${docBranchOn ? " AND d.corpus <> 'disclosure'" : ''}${filter}
         ORDER BY d.doc_id, a.art_no NULLS LAST, a.id)${docBranchOn ? ' UNION ALL' + docBranch : ''}
      ) t
      ORDER BY ${recencyPrefix(args, 'doc_date')}score DESC, CASE corpus WHEN 'legal' THEN 0 WHEN 'ca' THEN 1 ELSE 2 END, ${TIE_OUTER}, inst_name${SERIES_TIE}
      LIMIT ${limitPh}`,
    params: filterParams
  };
}

function corpusLabel(c) {
  return c === 'legal' ? '법령' : c === 'ca' ? '단협' : c === 'disclosure' ? '공시' : '내규';
}

function truncate(str, len) {
  if (!str) return '';
  const s = str.replace(/\n+/g, ' ');
  return s.length > len ? s.slice(0, len) + '…' : s;
}

function renderTable(rows, full) {
  if (!rows.length) {
    console.log('검색 결과 없음.');
    return;
  }
  const bodyLen = full ? 2000 : 300;
  rows.forEach((r, i) => {
    const src = r.inst_name || r.doc_title || corpusLabel(r.corpus);
    const no = r.art_ref || '-';
    console.log(`\n[${String(i + 1).padStart(2)}] ${corpusLabel(r.corpus)} | ${src} | ${r.doc_title}`);
    console.log(`     ${no} ${r.art_title || '(제목없음)'}  (유사도: ${r.score}  부처: ${r.ministry || '-'})`);
    console.log(`     ${truncate(r.body, bodyLen)}`);
  });
  console.log(`\n총 ${rows.length}건`);
}

function toCsv(rows) {
  const H = ['corpus', 'inst_name', 'ministry', 'doc_title', 'doc_type', 'art_ref', 'art_title', 'score', 'n_chars', 'body'];
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  return [H.join(','), ...rows.map(r => H.map(k => esc(r[k])).join(','))].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.keyword) {
    console.error('사용법: node rag/search.js "검색어" [옵션]');
    console.error('  --corpus bylaws|legal|ca|all  --type 취업규칙  --inst 기관명  --ministry 부처명');
    console.error('  --usecase recruit|audit|governance|labor|finance(콤마 복수)  --year YYYY  --understand  --limit N  --section 본칙|부칙  --json  --csv  --full');
    process.exit(1);
  }

  // 질의 이해: 검색어에서 기관/부처/연도 추출 → 명시 필터가 없을 때만 적용(명시값 우선)
  if (args.understand && args.keyword) {
    const { understand } = require('./_query_understand.js');
    const u = understand(args.keyword);
    const applied = [];
    if (u.inst && !args.inst) { args.inst = u.inst; applied.push('기관=' + u.inst); }
    if (u.ministry && !args.ministry) { args.ministry = u.ministry; applied.push('부처=' + u.ministry); }
    if (u.year && !args.year) { args.year = u.year; applied.push('연도=' + u.year); }
    if (applied.length) {
      args.keyword = u.residual;
      console.error(`[해석] ${applied.join(' · ')} | 검색어 "${u.residual}"`
        + (u.intent !== 'search' ? ` | 의도=${u.intent}` : '')
        + (u.usecases.length ? ` | 활용처 제안=${u.usecases.join(',')}` : ''));
    }
  }

  const env = loadEnv();
  const client = new Client({
    host: process.env.ALIO_PGHOST || env.PGHOST || 'postgres', port: +(env.PGPORT || 5432),
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD,
    database: 'alio_rag',
  });

  try {
    await client.connect();
    await client.query("SET statement_timeout='60s'");

    let sql, params;
    if (args.semantic) {
      // 🔴 2026-09-24. EMBED_PROVIDER 를 openrouter 로 바꿨는데 이 가드만 NVIDIA 를 보고 있었다.
      //    키가 맞아도 «없다」며 exit 1 이 나 의미검색이 통째로 막힌다. provider 에 맞춰 검사한다.
      {
        const needKey = embedKeyName();
        if (needKey && !env[needKey]) { console.error(`--semantic은 .env.aiapi 의 ${needKey} 필요 (provider=${EMBED_PROVIDER})`); process.exit(1); }
      }
      const vec = await embedQuery(env, args.keyword);
      const vecStr = '[' + vec.map(x => x.toFixed(6)).join(',') + ']';
      await ensureSemanticIndex(client);   // 인덱스 형태 확인(없으면 «의미검색 인덱스 없음» 으로 즉시 실패)
      const q = buildSemanticQuery(vecStr, args);
      // ⚠️ ef를 내리려는 시도를 2026-08-02에 했다가 되돌렸다. 조문 벡터를 질의로 쓰면
      // ef=200에서 24.0ms→14.4ms(1.7배)에 top50 겹침 손실이 0으로 보인다. **그 측정은 대표성이 없다** —
      // 조문 벡터는 코퍼스 안에 있어 이웃이 가깝지만, 실제 질의는 **자연어 문장**이라 분포 밖이고
      // 더 넓은 탐색이 필요하다. api_server 주석의 실측 기록: 자연어 질문(sem-02)은 **ef≥400에서만 포착**.
      // 내리려면 golden_set 질의를 실제로 임베딩해 재현율을 재야 한다(rag/eval_search.js).
      // Tier0 튜닝: 하한 500(api_server와 정합). 필터 질의는 반복 스캔(iterative_scan)으로 결과 확보 — semanticSettings 가 둘 다 정한다.
      for (const st of semanticSettings(q, 500)) await client.query('SET ' + st);
      ({ sql, params } = q);
    } else {
      ({ sql, params } = buildQuery(args));
    }

    const t0 = Date.now();
    const res = await client.query(sql, params);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    const rows = res.rows;

    if (args.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else if (args.csv) {
      const fname = `search_result_${args.keyword.replace(/[^\w가-힣]/g, '_').slice(0, 20)}.csv`;
      fs.writeFileSync(fname, '﻿' + toCsv(rows)); // BOM for Excel
      renderTable(rows, args.full);
      console.log(`\nCSV 저장: ${fname}`);
    } else {
      renderTable(rows, args.full);
    }

    console.log(`(${elapsed}s)`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(e => {
    if (/statement timeout/.test(e.message)) {
      console.error('시간 초과(15s): 검색어가 너무 짧거나 흔합니다.');
      console.error('--body 검색은 3자 이상의 구체적 키워드에 적합합니다. (예: "편차보정", "강제배분")');
      console.error('짧은 키워드는 기본(조제목) 검색을 사용하세요.');
    } else {
      console.error('오류:', e.message);
    }
    process.exit(1);
  });
}

// api_server.js 등 외부 재사용을 위한 export (CLI 동작에는 영향 없음)
// ── RRF(Reciprocal Rank Fusion): 점수 체계가 다른 결과 목록들을 순위만으로 융합 ──
// score(문서) = Σ 1/(K + rank). K=60(관례) — 상위권 가중을 완만하게 눌러 안정적.
// trgm similarity와 cosine처럼 스케일이 다른 점수를 정규화 없이 합칠 수 있다.
const RRF_K = 60;
function rrfFuse(lists, limit, opts) {
  const byKey = new Map();
  const ws = (opts && opts.weights) || null;   // HybridFuse(11-25): 목록별 가중(기본 없음=전부 1 → 현행과 동일)
  lists.forEach((rows, li) => rows.forEach((r, i) => {
    // 조각(청크) 단위 키: 같은 문서의 조각들은 art_ref·art_title 이 비거나('content' 등) 같아서 옛 키로는 한 항목으로 합쳐지고 RRF 점수가 쌓였다
    // (하이브리드가 의미검색보다 크게 나빴던 원인 — 2026-10-26). dup_chunk(art_key, 없으면 seq)가 있으면 문서+조각으로 구분한다.
    const key = r.dup_chunk != null && r.dup_chunk !== ''
      ? (r.real_doc_id || r.rel_path || r.doc_title || '') + '|#' + r.dup_chunk
      : (r.rel_path || r.doc_title || '') + '|' + (r.art_ref || '') + '|' + (r.art_title || '');
    const e = byKey.get(key) || { row: r, s: 0 };
    e.s += (ws ? ws[li] : 1) / (RRF_K + i + 1);
    byKey.set(key, e);
  }));
  return [...byKey.values()].sort((a, b) => b.s - a.s).slice(0, limit)
    .map(e => ({ ...e.row, rrf: +e.s.toFixed(4) }));
}

// ── hybrid 융합 v2 (2026-11-25 HybridFuse 후보) — SEARCH_FUSE_V2=on 일 때만. 기본 off 면 hybridFusePlan() 이 null → 호출부는 현행 rrfFuse([kw, sem]) 그대로(응답 바이트 동일). 롤백 = 환경변수 제거/off.
//   원인: 키워드(trigram 제목) 팔은 문장형 질의에서 정밀도가 거의 없는데 의미 팔과 같은 가중이고, 동점(1/61) 순서가 [키워드, 의미] 라 키워드가 앞섰다.
//   SEARCH_FUSE_KW_WEIGHT(기본 0.25) 키워드 팔 가중, SEARCH_FUSE_ORDER=sem_first|kw_first(기본 sem_first) 동점 우선,
//   SEARCH_FUSE_SKIP_SENTENCE=on|off(기본 on) 문장형 질의는 키워드 팔 생략(의미 팔 실패 시 호출부가 키워드 팔로 강등), SEARCH_FUSE_SENT_TOKENS(기본 5) 어절수 문턱.
const FUSE_ENDING = /(나요|인가요|인가|까요|할까|뭔가요|무엇|어떻게|어떤|어떠|있나|있는지|되나요|하나요|돼요|알려|궁금|\?|？)|(다|요|까|죠)\s*$/;
const FUSE_JOSA = /(은|는|이|가|을|를|에서|에게|에는|으로|와|과|도|만)$/;
/** 규칙 기반 질의 유형: 'sentence'(문장형) | 'keyword'(명사구·식별자형). 순수함수. */
function fuseQueryKind(q, tokT) {
  const t = String(q || '').trim(); if (!t) return 'keyword';
  const w = t.split(/\s+/), T = Number.isFinite(tokT) && tokT > 0 ? tokT : 5;
  if (FUSE_ENDING.test(t)) return 'sentence';
  if (w.length >= T) return 'sentence';
  if (w.length >= 3 && w.some(x => x.length >= 3 && FUSE_JOSA.test(x))) return 'sentence';
  return 'keyword';
}
/** 호출 시점에 환경변수를 읽는다. off(기본)면 null. */
function hybridFusePlan(keyword) {
  if ((process.env.SEARCH_FUSE_V2 || 'off') !== 'on') return null;
  const w = Number(process.env.SEARCH_FUSE_KW_WEIGHT !== undefined && process.env.SEARCH_FUSE_KW_WEIGHT !== '' ? process.env.SEARCH_FUSE_KW_WEIGHT : 0.25);
  const skip = (process.env.SEARCH_FUSE_SKIP_SENTENCE || 'on') === 'on' && fuseQueryKind(keyword, Number(process.env.SEARCH_FUSE_SENT_TOKENS)) === 'sentence';
  return { skipKw: skip, kwWeight: Number.isFinite(w) && w > 0 ? w : 1, kwFirst: (process.env.SEARCH_FUSE_ORDER || 'sem_first') === 'kw_first' };
}
/** plan=null → 현행. plan.skipKw → 의미 팔만(순서 보존). */
function fuseHybrid(kw, sem, limit, plan) {
  if (!plan) return rrfFuse([kw, sem], limit);
  const k = plan.skipKw ? [] : kw;
  return plan.kwFirst ? rrfFuse([k, sem], limit, { weights: [plan.kwWeight, 1] }) : rrfFuse([sem, k], limit, { weights: [1, plan.kwWeight] });
}

// sort=recent 전역 확정 헬퍼(순수함수) — api_server.js가 runSearch 반환 직전, 어느 경로(키워드
// corpus=all 병합·hybrid RRF·시맨틱 포함)로 rows가 만들어졌든 여기서 최종 개정일 내림차순으로 재정렬한다.
// doc_date는 'YYYYMMDD' 또는 'YYYY' 문자열 — 사전식 비교로 충분. 없음('' / null / undefined)은 최후미.
function recencySort(rows) {
  return rows.slice().sort((a, b) => {
    const x = a.doc_date || '', y = b.doc_date || '';
    if (!x && !y) return 0;
    if (!x) return 1;
    if (!y) return -1;
    return x < y ? 1 : x > y ? -1 : 0;
  });
}

// ── 동일문서 묶기 (같은 기관 안에서만) ────────────────────────────────────────────
// rows 는 이미 관련도순. 같은 (기관, dup_group, 청크=art_key|seq) 은 첫 행(=최고 순위)만 남기고 접는다 — 같은 파일의 다른 청크는 접지 않는다.
// 🔴 기관 간에는 절대 묶지 않는다: 키에 inst_name 을 넣어, 해시가 우연히 같아도 기관이 다르면 별개 행.
// dup_group 이 없는 행(NULL)은 접지 않는다 → 메타 없는 DB 에서는 입력 그대로(하위 호환).
// 반환 rows 에서 dup_group·dup_chunk 컬럼은 지운다(내부용). same_doc 은 foldDupRows 가 붙인다.
function collapseDup(rows, limit, { off = false } = {}) {
  const seen = new Map(), out = [];
  for (const r of rows) {
    const { dup_group, dup_chunk, body_group, ...rest } = r;   // 내부 키 — 검색 응답에는 싣지 않는다(body_group 은 현재 SELECT 하지 않지만 방어적으로 제거)
    if (!off && COLLAPSE_DUP && dup_group) {
      const k = (r.inst_name || '') + '|' + dup_group + '|' + (dup_chunk ?? '');   // (next2) 접기 키 불변 — 기간이 달라도 «동일 본문» 이면 접는다(10-21 정책). 기간은 same_doc.rounds[].period_label 로 노출
      if (seen.has(k)) { seen.get(k).folded++; continue; }
      const rep = { ...rest, _dup: dup_group, folded: 0 };
      seen.set(k, rep); out.push(rep);
    } else out.push(rest);
  }
  const kept = out.slice(0, limit);
  return { rows: kept, collapsed_from: rows.length, folded: rows.length - out.length };
}

// 회차 폴더 라벨: 경로 중 /^\d{4}(-\d{4}|Q\d)?(__.+)?$/ 에 맞는 첫 세그먼트(없으면 null).
const ROUND_RE = /^\d{4}(-\d{4}|Q\d)?(__.+)?$/;
const roundOf = relPath => (String(relPath || '').split('/').find(s => ROUND_RE.test(s))) || null;

// 대표 행(collapseDup 반환 rows)에 same_doc:{n, n_in_range, rounds:[{round,doc_date,doc_id,in_range}]} 를 «질의 시점에» 계산해 붙이고
// 내부 키(_dup, folded)를 지운다. 숫자는 documents.meta->>'dup_group' 의 현재 행 수 — 저장된 dup_n 같은 값을 쓰지 않는다(일 증분에도 정확).
// run(sql, params) → rows. n<2(재게시 없음)면 same_doc 을 달지 않는다. year 가 있으면 범위 안 회차만 in_range=true.
// 실패는 삼키지 않고 note 로 돌려준다(검색 결과 자체는 유지). 반환 {rows, note}.
async function attachSameDoc(run, kept, { year = null } = {}) {
  const groups = [...new Set(kept.map(r => r._dup).filter(Boolean))];
  let note = null; const members = new Map();
  if (groups.length) {
    try {
      // pl = 공시만(ca 등 비공시 회차에는 기간 키를 싣지 않는다 — 행 수준 SERIES_SEL 과 동일)
      const m = await run(
        `SELECT d.meta->>'dup_group' AS g, d.doc_id, d.doc_date, d.rel_path, CASE WHEN d.corpus = 'disclosure' THEN d.meta->>'period_label' END AS pl
           FROM documents d WHERE d.meta->>'dup_group' = ANY($1::text[])
          ORDER BY d.doc_date DESC NULLS LAST, d.rel_path`, [groups]);
      for (const x of m) (members.get(x.g) || members.set(x.g, []).get(x.g)).push(x);
    } catch (e) { note = 'same_doc 조회 실패: ' + String(e.message).slice(0, 120); }
  }
  const ROUNDS_MAX = 20;
  const rows = kept.map(({ _dup, folded, ...r }) => {
    const mem = members.get(_dup);
    if (!mem || mem.length < 2) return r;
    const yOf = x => (roundOf(x.rel_path) || '').slice(0, 4) || String(x.doc_date || '').slice(0, 4);   // 회차 폴더 연도 우선(count 의 year 기준과 동일)
    const inR = x => !year || yOf(x) === year;
    return { ...r, same_doc: { n: mem.length, n_in_range: mem.filter(inR).length, rounds_shown: Math.min(mem.length, ROUNDS_MAX),
      rounds: mem.slice(0, ROUNDS_MAX).map(x => ({ round: roundOf(x.rel_path), doc_date: x.doc_date, doc_id: x.doc_id, in_range: inR(x), ...(x.pl ? { period_label: x.pl } : {}) })) } };
  });
  return { rows, note };
}

// ── 계열(기관+항목) «더 나중 공시» 표시 (2026-10-22 next2) ─────────────────────────────
// 대상 = 허용목록(series_allowlist.json)에 있는 «분기·연간 스냅샷» 항목 코드(category)뿐. 이벤트성 항목(이사회·감사보고서(43006)·임원 국외출장·채용정보·노조 협약류 등)은
//   회차마다 별개 사건이라 «더 나중 공시가 있다» 가 의미 없으므로 표시하지 않는다(미부착). 판별 기준·표는 series_allowlist.json _meta.
// 계열 키 = SERIES_KEY=item(기본): 허용목록의 (항목명, 주기 k) 가 같은 코드들을 한 계열로 묶는다(예 소송 21301·21311). 항목명이 같아도 주기가 다른 코드(노조 21021 분기 / 21025 연)는 묶지 않는다
//   (항목명만으로 묶으면 단협·임금협약·회의록 같은 하위 항목이 섞여 «나중 공시» 오판이 3,200여 건 늘어난다 — 실측). SERIES_KEY=category 면 코드 단위.
// 최신 판정 = 공시일(meta.submitted_at, 없으면 doc_date) 최댓값. 동일 공시일이면 period_label 큰 쪽(결정적). period_label 로 정렬하지 않는다:
//   1~3월에 공시한 4분기 보고서가 YYYYQ4 로 붙어 같은 해 Q3 보다 «큰 라벨» 이 된다 → 표시용 보정 period_label_adj(Q4 + 1~3월 공시 → 전년 Q4)만 추가한다.
// 동일 본문으로 접힌 행(same_doc)에 최신 기간의 사본이 들어 있으면 «나중 공시 있음» 으로 보지 않는다(내용이 최신 기간에도 그대로).
const _fs = require('fs'), _path = require('path');
const loadSeriesAllow = p => { try { return JSON.parse(_fs.readFileSync(p, 'utf8')).cats || {}; } catch { return {}; } };   // 파일이 없으면 빈 목록 = 계열 표시 없음(기간 필드만)
const SERIES_ALLOW = loadSeriesAllow(process.env.SERIES_ALLOWLIST || _path.join(__dirname, 'series_allowlist.json'));
if (SERIES_LATEST && !Object.keys(SERIES_ALLOW).length) console.error('[series] SERIES_LATEST=1 인데 허용목록(series_allowlist.json)이 비었다 — 이미지에 파일이 빠졌는지 확인(표시 없음으로 동작)');   // 조용한 무효화 방지(stderr)
const ROW_TARGET_YEAR = process.env.ROW_TARGET_YEAR !== 'off';   // G2-B: 응답 행의 target_year(기본 on, off 로 끔)
const SERIES_KEY = process.env.SERIES_KEY || 'item';
if (!['item', 'category'].includes(SERIES_KEY)) throw new Error('SERIES_KEY 는 item | category');
// 허용 코드 → 같은 계열의 코드 목록(자기 자신 포함)
const seriesSiblings = (cat, allow = SERIES_ALLOW) => {
  const me = allow[cat]; if (!me) return null;
  if (SERIES_KEY !== 'item' || !me.item) return [cat];
  return Object.keys(allow).filter(c => allow[c].item === me.item && allow[c].k === me.k).sort();
};
const seriesKey = (inst, cat, allow) => { const s = seriesSiblings(cat, allow); return s ? inst + '\u0000' + s.join('\u0001') : null; };
const dashDate = d => (/^\d{8}$/.test(d || '') ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);
// 표시용 보정: «YYYYQ4» 가 같은 해 1~3월 공시면 전년 4분기(라벨 연도는 공시 연도라서). 다른 라벨·월은 그대로.
const adjPeriodLabel = (pl, sa) => {
  const m = /^(\d{4})Q4$/.exec(pl || ''); const s = /^(\d{4})-(\d{2})-/.exec(sa || '');
  return m && s && s[1] === m[1] && +s[2] <= 3 ? (+m[1] - 1) + 'Q4' : pl;
};
// 허용 코드의 (기관, 계열) 별 «가장 나중 공시» 1건 — 쌍(unnest)으로 정확 조회(inst×category 교차곱 아님), 동일 공시일은 period_label 큰 쪽(결정적).
async function fetchSeriesLatest(run, rows, allow = SERIES_ALLOW) {
  const keys = new Map();
  if (!SERIES_LATEST) return { latest: new Map(), note: null };   // 플래그 OFF: DB 조회 안 함
  for (const r of rows) {
    if (r.corpus !== 'disclosure' || !r.series_inst || !r.category) continue;
    const k = seriesKey(r.series_inst, r.category, allow); if (k) keys.set(k, k);
  }
  const latest = new Map(); let note = null;
  if (!keys.size) return { latest, note };
  const list = [...keys.keys()].map(k => k.split('\u0000'));
  try {
    const m = await run(
      `SELECT p.i AS inst_code, p.c AS cats, x.pl, x.sa
         FROM unnest($1::text[], $2::text[]) AS p(i, c)
         CROSS JOIN LATERAL (
           SELECT d.meta->>'period_label' AS pl,
                  COALESCE(d.meta->>'submitted_at', CASE WHEN d.doc_date ~ '^[0-9]{8}$' THEN substr(d.doc_date,1,4)||'-'||substr(d.doc_date,5,2)||'-'||substr(d.doc_date,7,2) END) AS sa
             FROM documents d
            WHERE d.corpus = 'disclosure' AND d.inst_code = p.i AND d.category = ANY(string_to_array(p.c, E'\\x01'))
            ORDER BY sa DESC NULLS LAST, pl DESC NULLS LAST LIMIT 1) x`,
      [list.map(x => x[0]), list.map(x => x[1])]);
    for (const x of m) latest.set(x.inst_code + '\u0000' + x.cats, x);
  } catch (e) { note = 'series 조회 실패'; }   // 오류 원문은 응답에 싣지 않는다(내부 메시지 노출 방지)
  return { latest, note };
}
// 순수 함수: 행에 period_label·submitted_at(있으면)·period_label_adj(보정이 다를 때)·series_latest·series_note 를 정리하고 내부 열(series_inst)을 지운다. 반환 rows.
function annotateSeriesRows(rows, latest, allow = SERIES_ALLOW) {
  return rows.map(({ series_inst, ...r }) => {
    if (r.period_label == null) delete r.period_label;
    if (r.submitted_at == null) delete r.submitted_at;
    if (r.period_label) { const adj = adjPeriodLabel(r.period_label, r.submitted_at); if (adj !== r.period_label) r.period_label_adj = adj; }
    if (ROW_TARGET_YEAR && r.corpus === 'disclosure') { const ty = IF.titleYear(r.doc_title); if (ty) r.target_year = ty; }   // G2-B: 제목에서 뽑을 수 있을 때만
    const k = SERIES_LATEST && r.corpus === 'disclosure' && series_inst && r.category ? seriesKey(series_inst, r.category, allow) : null;
    const L = k ? latest.get(k) : null;
    if (!L || !L.sa) return r;
    const mine = r.submitted_at || dashDate(r.doc_date) || '';
    const sameAsLatest = !!(r.same_doc && r.same_doc.rounds && r.same_doc.rounds.some(x => x.period_label && x.period_label === L.pl));
    const stale = !!mine && L.sa > mine && (L.pl ?? null) !== (r.period_label ?? null) && !sameAsLatest;
    if (!stale) return { ...r, series_latest: true };
    const Ls = adjPeriodLabel(L.pl, L.sa) || L.sa, Ms = r.period_label_adj || r.period_label || mine;
    return { ...r, series_latest: false, series_note: `같은 기관·항목에 이 행보다 나중에 공시된 자료가 있습니다(${Ls}, 공시일 ${L.sa}). 이 행은 ${Ms}(공시일 ${mine}) 자료이며, 새 자료가 이 자료를 대체·정정했다는 뜻은 아닙니다 — 질문한 기간에 맞으면 그대로 쓰세요.` };
  });
}
// latest_only=true 는 SERIES_LATEST=1 일 때만 유효: series_latest===false 행을 뺀다(없는 값·표시 없는 행은 유지).
const latestOnly = (rows, on) => (SERIES_LATEST && on === true ? rows.filter(r => r.series_latest !== false) : rows);
async function annotateSeries(run, rows) {
  const { latest, note } = await fetchSeriesLatest(run, rows);
  return { rows: annotateSeriesRows(rows, latest), note };
}

// collapseDup + attachSameDoc (api_server 용 한 번에). 반환 {rows, collapsed_from, folded, dup_note?}
async function foldDupRows(run, rows, limit, { off = false, year = null } = {}) {
  const c = collapseDup(rows, limit, { off });
  const a = await attachSameDoc(run, c.rows, { year });
  return { rows: a.rows, collapsed_from: c.collapsed_from, folded: c.folded, ...(a.note ? { dup_note: a.note } : {}) };
}

module.exports = { sectionParam, parseAsOf, editionClause, editionWarning, annotateEdition, editionTieOrder, semanticImplicitFilter, middleDotVariants, EDITION_COLS, loadEnv, buildQuery, corpusLabel, truncate, embedQuery, embedKeyName, buildSemanticQuery, parseUsecase,
  get SEM_INDEX() { return semIndex; }, get SEM_LAYOUT() { return semLayout; }, SEM_CAND_N, SEM_BIT_CAND, corpusPredQ, corpusOrderQ, CORPUS_HNSW_Q, semanticOrderBy, semanticSettings, ensureSemanticIndex,
  semanticHasFilter, runSemanticPost, SEM_POST_IDS_MAX, buildCandidateIdsQuery, buildSemanticExactQuery, rrfFuse, fuseQueryKind, hybridFusePlan, fuseHybrid, parseArgs, recencySort,
  COLLAPSE_DUP, collapseDup, attachSameDoc, foldDupRows, roundOf, SERIES_LATEST, SERIES_ORDER, latestOnly,
  postFilter, annotateSeries, annotateSeriesRows, fetchSeriesLatest, adjPeriodLabel, seriesKey, SERIES_ALLOW, DISCLOSURE_DOC_BRANCH };
