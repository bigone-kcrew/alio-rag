#!/usr/bin/env node
/**
 * ALIO RAG MCP 서버 (stdio) — 에이전트(Claude Code 등)가 코퍼스를 도구로 직접 검색
 *
 * 의존성 없이 MCP stdio 프로토콜(줄단위 JSON-RPC 2.0)을 직접 구현한다.
 * 검색 로직은 search.js(buildQuery/buildSemanticQuery/embedQuery)를 그대로 재사용 —
 * CLI·api_server와 동일한 결과.
 *
 * 도구:
 *   search_corpus  키워드/의미 검색 (corpus, usecase, inst, ministry, type, limit, body, semantic)
 *   get_document   문서 메타 + 조문 목록 (doc_id)
 *   get_article    특정 조문 전문 (doc_id, art_no[, art_sub])
 *
 * 등록(Claude Code): claude mcp add -s user alio-rag -- node <repo>/src/serving/mcp_server.js
 * 등록(Codex):       codex mcp add alio-rag -- node <repo>/src/serving/mcp_server.js
 *   + ~/.codex/config.toml의 [mcp_servers.alio-rag]에 default_tools_approval_mode = "approve"
 *     (없으면 approval=never·read-only에서 "user cancelled MCP tool call"로 즉시 취소됨)
 * DB 접속: .env.api (api_server와 동일). 의미검색은 NVIDIA_API_KEY 필요(없으면 키워드만).
 */
'use strict';

const { Pool } = require('pg');
const { countInst } = require('./count_inst');
const { resolveInst, scopeFor, SCOPE_NOTE } = require('./inst_alias');
const { parseAsOf, loadEnv, buildQuery, embedQuery, embedKeyName, buildSemanticQuery, parseUsecase,
  semanticHasFilter, annotateEdition, buildCandidateIdsQuery, buildSemanticExactQuery, rrfFuse, hybridFusePlan, fuseHybrid, semanticSettings, ensureSemanticIndex,
  COLLAPSE_DUP, collapseDup, attachSameDoc, annotateSeries, latestOnly, SERIES_LATEST, SEM_BIT_CAND, runSemanticPost } = require('./search.js');
const PR = require('./prerelease.js');   // 공개 전 공시 표기(PRERELEASE_MARK=on 일 때만 동작, off 면 no-op)
const TH = require('./table_header.js');   // G2-C: 표 청크 머리글 부착(ATTACH_TABLE_HEADER=off 로 끔)
const G2 = require('./g2_meta.js');   // G2-D·E: period_semantics·docs_total·zero_reasons·AUTO_HYBRID_ON_ZERO
const IF = require('./item_filter.js');   // 항목·기간 필터(ITEM_FILTER=off 기본 — off 면 아래 분기 전부 비활성, 도구 스키마·설명도 그대로)
const ITEM_ON = IF.mode() !== 'off';

const { rerankRows, docNote } = require('./rerank_legal.js');   // RERANK_LEGAL=off(기본)이면 즉시 무동작 — 응답 바이트 동일
const { maskRows, maskOptsForTier } = require('./mask_pii.js');   // S-07 복원(RT-05)
const PAGING = process.env.MCP_SEARCH_PAGING === 'on';   // 2026-10-28: search_corpus 쪽수 넘기기(offset)·has_more 신호 — 기본 off(응답 바이트 동일). on 이면 offset 인자·has_more/next_offset/limit/max_limit 응답 키
const EXT = require('./mcp_ext.js');   // 도구 확장(2026-10-27): MCP_DOC_OFFSET·MCP_LIST_CATALOG·MCP_COMPARE·MCP_SERIES·MCP_RELATED 가 'on' 일 때만 동작 — 기본 off 면 무동작
const DEEP = process.env.MCP_DEEP === 'on';   // MCPdeep(2026-11-24): scan_documents·get_document find·search_corpus expand/months/brief·부처 구명칭 — 기본 off(응답·도구 목록 바이트 동일)
const DEEP_EXT = process.env.MCP_DEEP_EXTERNAL === 'on';   // 기본 off — MCP_DEEP=on 이어도 external·등급 미지정 tier 에는 신규 기능을 열지 않는다
const FIND_CASES = process.env.MCP_FIND_CASES === 'on';   // FindCases(2026-11-24): find_cases(사례 카드 검색) — 기본 off(도구 목록·응답 바이트 동일)
const FIND_CASES_EXT = process.env.MCP_FIND_CASES_EXTERNAL === 'on';   // 기본 off — external·등급 미지정 tier 에는 열지 않는다
const SQL_TOOL = process.env.MCP_SQL_TOOL === 'on';   // SqlTool(2026-11-25): query_sql(읽기 전용 SQL)·list_catalog(kind=sql_guide) — 기본 off(도구 목록·응답 바이트 동일). external 은 MCP_SQL_TOOL_EXTERNAL=on 일 때만
const fcOpen = tier => FIND_CASES && (tier === 'internal' || tier === 'master' || (FIND_CASES_EXT && tier === 'external'));
const deepOpen = tier => DEEP && (tier === 'internal' || tier === 'master' || (DEEP_EXT && tier === 'external'));
const DEEP_ARGS = ['expand', 'months', 'brief'];   // search_corpus 신규 인자
const SQLT = require('./sql_tool.js');   // SqlTool: MCP_SQL_TOOL=on 일 때만 쓰임(off 면 require 만 — pg 는 호출 시 지연 로드)
const QX = require('./query_expand.js');
const AM = require('./auto_mode.js');   // QueryStudy: SEARCH_AUTO_MODE=on 일 때만(자동 hybrid 승격·0건 hybrid 확대·0건 사유)
const SCACHE = require('./search_cache.js');
const CG = require('./code_guide.js');
const SH = require('./shell_docs.js');   // c6 ShortDocs: SEARCH_SHELL_HANDLING·SEARCH_SHELL_GUARD   // c6: MCP_ITEM_GUIDE=on — 코드 가이드·item_coverage   // SEARCH_CACHE=on 일 때만
const SC = require('./scan_documents.js');
const qlog = require('./qlog.js');   // 질의 로그(QUERY_LOG=1 일 때만 동작, 꺼져 있으면 no-op)
// 응답의 rows·articles 본문·제목에서 휴대폰·주민번호·개인메일을 가린다. MASK_PII=0 으로만 끈다(기본 켬).
const MASK_PII = (process.env.MASK_PII || '') !== '0';
const maskOut = (out, tier) => {
  if (!MASK_PII || !out || typeof out !== 'object') return out;
  const o = { ...out }, mo = maskOptsForTier(tier);   // 10-21: 등급별(external·미지정=모든 이메일 / internal·master=기본)
  if (Array.isArray(o.rows)) o.rows = maskRows(o.rows, mo).rows;
  if (Array.isArray(o.articles)) o.articles = maskRows(o.articles, mo).rows;
  if (o.document && typeof o.document === 'object') o.document = maskRows([o.document], mo).rows[0];
  return EXT.maskExtra(o, tier);   // 새 도구의 응답 키(items·changes·series·outgoing·incoming 등) — 해당 키가 없는 기존 응답은 그대로

};

const fileEnv = (() => { try { return loadEnv(); } catch { return {}; } })();
const env = key => process.env[key] || fileEnv[key] || '';

const pool = new Pool({
  host: process.env.ALIO_PGHOST || env('PGHOST') || 'postgres',
  port: parseInt(env('PGPORT') || '5432', 10),
  user: env('POSTGRES_USER'),
  password: env('POSTGRES_PASSWORD'),
  database: env('PGDATABASE') || 'alio_rag',
  max: 4,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,   // 풀이 가득 찼을 때 무기한 대기하지 않는다(10-21 리뷰 #3)
});
pool.on('error', e => process.stderr.write('[pg pool] ' + e.message + '\n'));

// SET LOCAL은 트랜잭션 안에서만 유효(풀 세션 누수 방지) — api_server와 동일 패턴
async function withPooled(sets, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const s of sets) await c.query(s);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
  finally { c.release(); }
}

// ── 도구 구현 ─────────────────────────────────────────────────────────────────

// 연구회 소관 출연연(scope=extra) 안내 — search_extra 이거나 기관 지정으로 출연연이 포함된 응답에 싣는다.
// 0건·«문서/조문 없음» 응답 표준 안내(2026-11-12) — 정적 문구(데이터 값 없음 → 마스킹·등급 영향 없음). isError 의미는 바꾸지 않는다(0건은 정상 «없음»).
const ZERO_HINT = '0건은 «자료 없음» 확정이 아닙니다. 추측해서 답하지 말고, 표현을 바꾸거나(약칭→정식명, 가운뎃점 제거, 핵심 명사만)·inst/corpus 를 조정하거나·hybrid:true 또는 body:true 로 다시 검색하세요. 그래도 없으면 «검색 결과 없음»이라고 답하세요.';
const NOT_FOUND_TAIL = ' — 추측하거나 지어내지 말고, search_corpus 결과의 doc_id 를 그대로 써서 다시 호출하세요.';
const EXTRA_HINT = '국가과학기술연구회 소관 출연연(한국과학기술연구원·한국생산기술연구원·한국전자통신연구원 등 23곳)의 내규는 이 도구가 아니라 search_extra 로 검색한다.';
async function toolSearchCorpus(a, forcedScope) {
  const args = {
    keyword: String(a.keyword || '').slice(0, 100),
    corpus: a.corpus || 'all',
    type: a.type || null,
    inst: resolveInst(a.inst) || null,   // 약칭(창진원 등) → 정식명
    scope: scopeFor(forcedScope, resolveInst(a.inst) || null),   // 출연연: 기본 제외·search_extra 는 'extra'·기관을 지정하면 자동 'all'
    ministry: (DEEP ? QX.resolveMinistry(a.ministry).value : a.ministry) || null,   // MCPdeep: 구명칭(산업통상자원부 등)은 현행명으로
    usecase: parseUsecase(a.usecase || ''),
    section: a.section || undefined,   // 미지정 = search.js 기본(SEARCH_DEFAULT_SECTION, 기본 all). 본칙|부칙|별표|all
    allVersions: !!a.all_versions,     // 연혁·시행예정·폐지 포함 (기본: 현행판만)
    asOf: parseAsOf(a.as_of),          // 그 날짜에 유효한 판 (YYYY-MM-DD)
    body: !!a.body,
    limit: Math.min(50, Math.max(1, parseInt(a.limit, 10) || 10)),
  };
  const OFF = PAGING ? Math.min(198, Math.max(0, parseInt(a.offset, 10) || 0)) : 0;   // 건너뛸 결과 수 — 볼 수 있는 범위는 앞쪽 후보 200건(마지막 1건은 has_more 확인용)
  const LIM = PAGING ? Math.max(1, Math.min(args.limit, 199 - OFF)) : args.limit;     // 창 끝에서는 쪽 크기를 줄여 쪽이 겹치지 않게 한다(limit_applied)
  const NEED = LIM + OFF + (PAGING ? 1 : 0);   // 한 건 더 받아 has_more 를 정확히 안다(PAGING off 면 종전 = limit) — 항상 ≤ 200
  // 항목·기간 필터(ITEM_FILTER): 명시 item/period/sort=latest + (auto) 질의에서 항목 자동 감지. off 면 itemCtx=null, args 불변.
  const itemCtx = IF.applyTo(args, a);   // BAD_PERIOD 는 일반 Error 로 전달돼 isError 응답이 된다
  const listOnly = !args.keyword && !!(itemCtx && itemCtx.itemCats);   // item 만 준 «항목 목록» 호출 — 의미검색 안 함
  if (!args.keyword && !listOnly) throw new Error('keyword가 필요합니다' + (itemCtx && itemCtx.info ? ' (item 을 못 찾음: ' + JSON.stringify(itemCtx.info) + ')' : ''));
  let semPost = false;   // 의미검색이 «후보 사후 필터» 경로를 탔는가
  let semCapped = false; // RC: 사후 필터 통과 후보가 실제 한도에 닿았는가(postStats.capped) — 이때만 filtered_short·candidate_cap_reached

  // 검색 행에 doc_id 부여 — documents.doc_id 실값(real_doc_id). 옛 적재분·법령·내규·ca 는 corpus||':'||rel_path 와 같고 공시 약 84% 는 다르다(2026-10-21 실측)
  // → get_document/get_article로 바로 연계 가능. search.js 쿼리는 건드리지 않음.
  // distinct_inst: 기관(inst_name, 없으면 doc_id) 당 최상위 1건만 남겨 limit 개 기관까지 — 같은 기관의 여러 조문·판본이 상위를 차지하는 걸 막는다.
  // 후보를 min(limit*5, 200) 개 더 받아(내부 한도: 이 함수의 limit 50 은 «응답» 상한일 뿐 검색 함수는 막지 않는다) 중복 제거 후 자른다.
  // 동일문서 묶기(collapse_dup, 기본 ON): 같은 기관·같은 dup_group(회차만 다른 재게시)은 대표 1건으로 접고 same_doc 에 «N건(회차 목록)» 을
  //   질의 시점에 계산해 싣는다. 후보를 limit*3(최대 200) 받아 접은 뒤 limit 로 자르고, 모자라고 후보가 더 있을 법하면 2배씩 재조회(최대 200).
  //   접기는 SQL 필터(기관·연도 등)를 통과한 행 안에서만, 기관 간에는 절대 접지 않는다. dup_group 메타가 없는 행은 접히지 않는다(기존 동작).
  const distinct = !!a.distinct_inst;
  const collapse = COLLAPSE_DUP && a.collapse_dup !== false;
  const baseN = distinct ? Math.min(NEED * 5, 200) : collapse ? Math.min(NEED * 3, 200) : NEED;
  const dedupInst = rows => { const seen = new Set(), out = [];
    for (const r of rows) { const k = r.inst_name || r.doc_id; if (k != null && seen.has(k)) continue; if (k != null) seen.add(k); out.push(r); if (out.length >= NEED) break; }
    return out; };
  // S-12: 일부 코퍼스·팔이 실패(시간초과·ollama 다운 등)하면 «결과 없음» 으로 위장하지 않고 degraded 로 알린다(API 와 같은 의미).
  const degraded = [];
  const runPooled = (sql, params) => withPooled(["SET LOCAL statement_timeout='5s'"], async c => (await c.query(sql, params)).rows);
  // doc_id = documents.doc_id 실값(real_doc_id) 우선, 없으면 옛 형식 corpus:rel_path(공시 84% 는 둘이 달라 폴백만으로는 get_document 가 못 찾는다). anchors 로 받은 doc_id 는 그대로.
  const withDocId = rows => rows.map(({ real_doc_id, ...r }) => ({ doc_id: real_doc_id || (r.corpus && r.rel_path ? r.corpus + ':' + r.rel_path : undefined), ...r }));
  const prep = rows => annotateEdition(withDocId(rows));   // doc_id 부여 + edition_state·edition_warning 부착
  // arm(lim) → 후보 rows(관련도순), extraFn() → 응답 부가키(arm 호출 뒤 평가)
  const finish = async (arm, extraFn) => {
    let lim = baseN, rows, c, kept, serNote = null;
    for (;;) {
      rows = prep(await arm(lim));
      if (args.latestPerSeries) rows = IF.latestPerSeries(rows);   // period=latest
      if (args.sortLatest) rows = IF.sortLatestRows(rows);         // sort=latest
      c = collapseDup(rows, Infinity, { off: !collapse });
      kept = distinct ? dedupInst(c.rows) : c.rows.slice(0, NEED);
      if (kept.length >= NEED || rows.length < lim || lim >= 200) break;   // 충분 / 후보 소진 / 상한
      lim = Math.min(lim * 2, 200);
    }
    let rr = null;   // 법령 한정 리랭커(corpus=legal + semantic 단독만). 실패는 원순위 + rerank:{applied:false,reason}. off 면 rr=null(키 없음)
    { const ex = extraFn();
      const x = await rerankRows(c.rows, { query: String(a.keyword || '').slice(0, 500), corpus: args.corpus, scope: args.scope, semantic: ex.semantic === true, hybrid: ex.hybrid === true });
      if (x.rows !== c.rows) { c = { ...c, rows: x.rows }; kept = distinct ? dedupInst(c.rows) : c.rows.slice(0, NEED); }
      rr = x.rerank; }
    const keptLen = kept.length;
    let pg = null;   // 쪽수 넘기기: 앞 OFF 건을 건너뛰고 limit 건만. 후보를 한 건 더 받아 has_more 를 정확히 낸다.
    if (PAGING) { const more = keptLen > LIM + OFF, canNext = more && LIM + OFF <= 198; kept = kept.slice(OFF, OFF + LIM);
      pg = { limit: args.limit, max_limit: 50, offset: OFF, has_more: canNext, ...(canNext ? { next_offset: OFF + LIM } : {}),
        ...(more && !canNext ? { window_exhausted: true } : {}), ...(LIM < args.limit ? { limit_applied: LIM } : {}) }; }
    const sd = await attachSameDoc(runPooled, kept, { year: null });
    const prN = PR.markRows(sd.rows);
    let thNote = null; { const t1 = await TH.attachTableHeaders(runPooled, sd.rows, r => r.doc_id); sd.rows = t1.rows; thNote = t1.note; }   // G2-C
    { const s1 = await annotateSeries(runPooled, sd.rows); sd.rows = latestOnly(s1.rows, a.latest_only); serNote = s1.note; }   // 기간 표시 + (허용목록 항목만) «나중 공시 있음» 표시 — 계열 최신은 DB 에서 질의 시점에 계산
    let g2meta = {};   // G2-D: 부분 결과(degraded)일 땐 문서 수·0건 이유를 달지 않는다(0건·적음이 «없음» 으로 읽히지 않게)
    if (!degraded.length) {
      const ex0 = extraFn(), dt = await G2.docsTotal(runPooled, args);
      const zr = sd.rows.length ? [] : await G2.zeroReasons(runPooled, args, { hybrid: ex0.hybrid === true, semantic: ex0.semantic === true, dt });
      g2meta = { ...(G2.usedPeriodish(args) ? { period_semantics: G2.PERIOD_SEMANTICS } : {}), ...(dt || {}), ...(zr.length ? { zero_reasons: zr } : {}) };
    }
    const extra = { ...extraFn(), ...(degraded.length ? { degraded: [...new Set(degraded)] } : {}),
      ...(itemCtx && itemCtx.info ? { item_resolved: itemCtx.info } : {}),
      ...(semCapped && keptLen < NEED ? { filtered_short: true, candidate_cap_reached: true, candidate_cap: SEM_BIT_CAND } : {}),
      ...(itemCtx && itemCtx.periodWarning ? { period_warning: itemCtx.periodWarning } : {}),
      ...(itemCtx && itemCtx.newFilterNote ? { filter_note: itemCtx.newFilterNote } : {}),
      ...(IF.ignoredNote(a) ? { filter_ignored: IF.ignoredNote(a) } : {}),
      ...(thNote ? { table_header_note: thNote } : {}),
      ...(G2.usecaseWarning(a.usecase) ? { usecase_warning: G2.usecaseWarning(a.usecase) } : {}),
      ...g2meta,
      ...(semPost && itemCtx && itemCtx.itemCats && !args.inst && kept.length === 0 ? { item_hint: 'keyword 에 항목명을 넣고 item 을 함께 지정하거나 inst 를 주세요(작은 항목은 의미검색 후보 안에 없을 수 있습니다).' } : {}) };
    return { ...extra, ...(distinct ? { distinct_inst: true, deduped_from: rows.length } : {}),
      ...(c.folded ? { dup_folded: c.folded } : {}),
      ...((collapse || distinct) && keptLen < NEED ? { candidates_exhausted: true } : {}),
      ...(sd.note ? { dup_note: sd.note } : {}),
      ...(serNote ? { series_warning: serNote } : {}),
      ...PR.topFields(prN, !!(args.period || args.reportPeriod)),
      ...(rr ? { rerank: rr } : {}),
      ...(pg || {}),
      ...(args.scope ? { scope_note: SCOPE_NOTE } : {}),
      ...(!args.scope && (args.corpus === 'all' || args.corpus === 'bylaws') && (keptLen === 0 || /출연\(?연|연구회|연구원|연구소/.test(String(a.keyword || ''))) ? { extra_hint: EXTRA_HINT } : {}),
      ...(sd.rows.length === 0 && !degraded.length ? { zero_hint: ZERO_HINT } : {}),
      count: sd.rows.length, rows: sd.rows };
  };

  // ── 키워드 팔: all이면 4코퍼스 병렬 (api_server와 동일 전략, 간소화) ──────────
  async function kwSearch(lim) {
    if (args.corpus === 'all') {
      const per = await Promise.all(['legal', 'ca', 'bylaws', 'disclosure'].map(corpus => {
        const q = buildQuery({ ...args, corpus, limit: lim });
        return withPooled(["SET LOCAL statement_timeout='15s'"],
          async c => (await c.query(q.sql, q.params)).rows).catch(e => { degraded.push(corpus); process.stderr.write(`[mcp] kw ${corpus}: ${e.message}\n`); return []; });
      }));
      return per.flat().sort((x, y) => parseFloat(y.score) - parseFloat(x.score)).slice(0, lim);
    }
    const q = buildQuery({ ...args, limit: lim });
    return withPooled(["SET LOCAL statement_timeout='15s'"],
      async c => (await c.query(q.sql, q.params)).rows);
  }

  // ── 의미검색 팔: 임베딩 1회 + KNN (재작성 융합은 api_server 전용 — MCP는
  //    에이전트가 질의를 다듬는 주체라 불필요). 2단계: 필터 후보 ≤임계면 HNSW 대신 정확 거리.
  async function semSearch(lim) {
    // 🔴 provider 에 맞는 키를 고른다. 종전엔 NVIDIA 키만 봐서, EMBED_PROVIDER 를 openrouter 로
    //   바꿔도 «키가 없다»며 막히거나(운 좋은 경우) 엉뚱한 키로 호출됐다.
    //   search.js 의 EMBED_PROVIDER 와 반드시 같은 값을 본다.
    const keyName = embedKeyName();   // ollama 는 null — 키 불필요
    if (keyName && !env(keyName)) throw new Error(`${keyName} 미설정(provider=${process.env.EMBED_PROVIDER || 'ollama'}) — semantic=false로 키워드 검색을 사용하세요`);
    let candIds = null;
    // 10-21 리뷰 #4: 코퍼스만 지정한 질의는 후보 id 단계(bylaws 차가운 캐시 15s 초과)를 건너뛰고 코퍼스별 HNSW 로 간다 — api_server 와 같은 조건.
    const onlyCorpusFilter = !args.type && !args.inst && !args.ministry && !args.usecase && !args.asOf && !args.scope
      && (args.section === undefined || args.section === null || args.section === '' || args.section === 'all');
    const isCorpusLayout = (await ensureSemanticIndex(pool).catch(() => null)) === 'corpus';
    if (semanticHasFilter(args) && !(onlyCorpusFilter && args.corpus !== 'all' && isCorpusLayout)) {
      const TH = parseInt(env('SEMANTIC_EXACT_MAX') || '20000', 10);
      const cq = buildCandidateIdsQuery(args, TH + 1);
      const cand = await withPooled(["SET LOCAL statement_timeout='15s'"],
        async c => (await c.query(cq.sql, cq.params)).rows).catch(() => null);
      if (cand && cand.length === 0) return [];
      if (cand && cand.length <= TH) candIds = cand.map(r => r.id);
    }
    semPost = !candIds && IF.hasPost(args) && isCorpusLayout;
    if (!candIds) await ensureSemanticIndex(pool);   // 인덱스 형태 확인·캐시 — 없으면 임베딩 호출 전에 «의미검색 인덱스 없음» 으로 실패(순차 스캔 30초 타임아웃 방지)
    const vec = await embedQuery(keyName ? { [keyName]: env(keyName) } : {}, args.keyword);
    const vecStr = '[' + vec.map(x => x.toFixed(6)).join(',') + ']';
    if (candIds) {
      const q = buildSemanticExactQuery(vecStr, candIds, lim);
      return withPooled(["SET LOCAL statement_timeout='30s'"],
        async c => (await c.query(q.sql, q.params)).rows);
    }
    const q = buildSemanticQuery(vecStr, { ...args, limit: lim });   // as_of·section·all_versions 는 args 로 전달
    const sets = ["SET LOCAL statement_timeout='30s'",
      ...semanticSettings(q, Math.min(500, Math.max(100, lim * 3))).map(x => 'SET LOCAL ' + x)];   // ef_search ≥ 후보 수 · iterative_scan(필터 시)
    return withPooled(sets, async c => q.post ? await runSemanticPost(c, q, lim) : (await c.query(q.sql, q.params)).rows)
      .then(rs => { if (rs && rs.postStats && rs.postStats.capped) semCapped = true; return rs; });   // q.post: 항목·기간 사후 필터 2단계
  }

  // ── RRF 하이브리드(hybrid=true): 키워드+의미 병렬 → 순위 융합 ────────────────
  // 의미 팔 실패(키 없음 등) 시 키워드 단독 강등. 제N조 질의는 정확 조회라 미적용.
  if (a.hybrid && !/제\s*\d+\s*조/.test(args.keyword) && !listOnly) {
    let semOk = false;
    return finish(async lim => {
      const depth = Math.min(distinct || collapse ? 200 : 100, Math.max(20, lim * 2));
      const fp = hybridFusePlan(args.keyword);   // SEARCH_FUSE_V2=off(기본)면 null → 아래는 현행과 동일
      const kwArm = () => kwSearch(depth).catch(e => { degraded.push('keyword'); process.stderr.write(`[mcp] hybrid keyword: ${e.message}\n`); return []; });
      let [kw, sem] = await Promise.all([
        fp && fp.skipKw ? [] : kwArm(),
        semSearch(depth).catch(e => { degraded.push('semantic'); process.stderr.write(`[mcp] hybrid semantic: ${e.message}\n`); return []; }),
      ]);
      if (fp && fp.skipKw && sem.length === 0) { kw = await kwArm(); fp.skipKw = false; }   // 의미 팔 실패 → 키워드 단독 강등(현행 의미 유지)
      semOk = sem.length > 0;
      return fuseHybrid(kw, sem, lim, fp);
    }, () => ({ hybrid: true, semantic: semOk }));
  }

  if (a.semantic && !listOnly) return finish(lim => semSearch(lim), () => ({ semantic: true }));
  const out = await finish(lim => kwSearch(lim), () => ({ semantic: false }));
  // c6 ④ 단어형 질의 폴백(SEARCH_WORD_FALLBACK=on): 1~2어 keyword 질의가 0건이면 본문 검색 → 공백 무시 변형 → 모호어 안내 순
  if (out.count === 0 && process.env.SEARCH_WORD_FALLBACK === 'on' && !a._nofb && !listOnly && !out.degraded && args.keyword.trim().split(/\s+/).length <= 2 && !/제\s*\d+\s*조/.test(args.keyword)) {
    const fb = await wordFallback(a, forcedScope, args, out).catch(e => { process.stderr.write('[mcp] word_fallback: ' + e.message + '\n'); return null; });
    if (fb && fb.count > 0) return fb;
    if (fb) Object.assign(out, fb.extra);
  }
  // G2-E: AUTO_HYBRID_ON_ZERO=on(기본 off) — 키워드 0건 + 문장형(공백 2개 이상)이면 hybrid 로 한 번 더. 부분 결과(degraded)·제N조 질의는 제외.
  // 0건 hybrid 재시도: 기존(AUTO_HYBRID_ON_ZERO·문장형만) 또는 c5 확대(SEARCH_ZERO_RETRY=on: 1어 이하·기관필터+body 제외, 상위 유사도 컷)
  const _zr = AM.zeroAny() ? AM.zeroRetryOk({ keyword: args.keyword, inst: args.inst, body: a.body }) : (G2.autoHybridOn() && G2.isSentence(args.keyword));
  if (out.count === 0 && _zr && !out.degraded && !listOnly && !/제\s*\d+\s*조/.test(args.keyword)) {
    try { const li = (!a.inst && AM.zeroAny()) ? AM.liftInst(a.keyword) : null; const h = await toolSearchCorpus({ ...a, hybrid: true, ...(li ? { inst: li } : {}) }, forcedScope);
      if (AM.zeroAny() && AM.zeroCut(h.rows)) return { ...out, zero_retry: '키워드 0건 후 hybrid 재시도를 했지만 의미 유사도가 낮아(상위 ' + AM.MIN_SCORE + ' 미만) 결과를 싣지 않았습니다 — 표현을 바꾸거나 inst·corpus 를 확인하세요.' };
      return { ...h, auto_hybrid: true, ...(li ? { auto_inst: li } : {}), ...(AM.on() || AM.zeroAny() ? { auto_hybrid_note: '제목 일치 결과가 없어 의미 유사 결과로 대신했습니다(질의어와 직접 일치하지 않을 수 있음)' + (args.inst ? ' — inst 필터는 유지됨(없으면 이 기관 문서가 없는 것)' : '') } : {}) }; } catch (e) { process.stderr.write('[mcp] auto_hybrid: ' + e.message + '\n'); }
  }
  // 문장형 질의는 부분일치(trigram)에서 0건이 «조용히» 나오기 쉽다 — 0건이면 원인 힌트를 덧붙인다(기존 키는 그대로).
  if (out.count === 0 && (args.keyword.trim().split(/\s+/).length >= 2 || args.keyword.length > 12))
    out.hint = '문장형 질의는 키워드(부분일치) 모드에서 0건이 나오기 쉽습니다. hybrid:true 또는 semantic:true 로 다시 시도하거나 핵심 명사만 남기세요.';
  return out;
}

// c6 ④: 단어형 0건 폴백. 성공하면 결과 응답(fallback·fallback_note 표시), 실패하면 {count:0, extra:{fallback_tried, word_hint}}.
async function wordFallback(a, forced, args, out) {
  const tried = [], base = { ...a, _nofb: true };
  if (!a.body) { const r = await toolSearchCorpus({ ...base, body: true }, forced); if (r.count > 0) return { ...r, fallback: 'body', fallback_note: '제목에서 찾지 못해 본문 검색으로 대신했습니다(제목 일치가 아님 — 발췌·문맥 확인 필요)' }; tried.push('body'); }
  const kw = args.keyword.trim(), ns = kw.replace(/\s+/g, ''), vs = new Set();
  if (kw !== ns) vs.add(ns);
  else if (/^[가-힣]{4,8}$/.test(kw)) for (let i = 2; i <= kw.length - 2; i++) vs.add(kw.slice(0, i) + ' ' + kw.slice(i));   // 붙여 쓴 한글어 → 한 칸 띄운 변형(제3자검증 ↔ 제3자 검증)
  if (vs.size) {
    const rs = await Promise.all([...vs].slice(0, 6).map(v => toolSearchCorpus({ ...base, keyword: v, body: true }, forced).catch(() => null)));
    const i = rs.findIndex(r => r && r.count > 0);
    if (i >= 0) return { ...rs[i], fallback: 'nospace', fallback_variant: [...vs][i], fallback_note: '공백 표기를 바꾼 «' + [...vs][i] + '» 로 찾았습니다(본문 검색, 제목 일치가 아님)' };
    tried.push('nospace');
  }
  // 모호어 안내: 항목명 후보(부분 일치 상위 5)와 코퍼스별 본문 건수
  const nk = IF.norm(kw), cand = [...IF.PHRASES.entries()].filter(([p]) => nk.length >= 2 && (p.includes(nk) || (p.length >= 3 && nk.includes(p)))).sort((x, y) => Math.abs(x[0].length - nk.length) - Math.abs(y[0].length - nk.length)).slice(0, 5).map(([, e]) => ({ name: e.text, codes: [...e.codes].sort() }));
  let counts = null;
  try { const rows = await withPooled(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='4s'"], async c => (await c.query(`SELECT d.corpus, count(*)::int AS n FROM articles a JOIN documents d ON d.doc_id = a.doc_id LEFT JOIN institutions i ON i.inst_code = d.inst_code WHERE lower(a.body) LIKE $1 AND ($2::text IS NULL OR i.inst_name ILIKE '%' || $2 || '%') AND ($3::text IS NULL OR d.corpus = $3) GROUP BY 1`, ['%' + kw.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%', args.inst ? String(args.inst).replace(/[\\%_]/g, '\\$&') : null, args.corpus && args.corpus !== 'all' ? args.corpus : null])).rows); counts = Object.fromEntries(rows.map(r => [r.corpus, r.n])); } catch { /* 건수 없이 */ }
  return { count: 0, extra: { fallback_tried: tried, word_hint: { note: '제목·본문·공백 변형 모두 0건입니다. 표현이 모호하거나 이 범위에 없을 수 있습니다.', ...(cand.length ? { item_candidates: cand } : {}), ...(counts ? { body_hits_by_corpus: counts, body_hits_scope: (args.inst ? 'inst «' + args.inst + '» ' : '전체 기관 ') + (args.corpus && args.corpus !== 'all' ? 'corpus=' + args.corpus : '전 코퍼스') + ' 기준 본문 포함 청크 수(period·item 등 다른 필터는 반영하지 않음)' } : {}) } } };
}

// doc_id 해석: 실제 documents.doc_id 이면 그대로, 아니면 옛 형식 «corpus:rel_path»(이미 저장해 둔 클라이언트 호환)로 한 번 더 찾는다. 못 찾으면 입력 그대로(기존 오류 문구 유지).
async function resolveDocId(c, docId) {
  if ((await c.query('SELECT 1 FROM documents WHERE doc_id = $1', [docId])).rowCount) return docId;
  const i = docId.indexOf(':');
  if (i < 0) return docId;
  const r = await c.query('SELECT doc_id FROM documents WHERE corpus = $1 AND rel_path = $2 ORDER BY doc_id LIMIT 1', [docId.slice(0, i), docId.slice(i + 1)]);
  return r.rows[0] ? r.rows[0].doc_id : docId;
}

async function toolGetDocument(a) {
  const docIn = String(a.doc_id || '');
  if (!docIn) throw new Error('doc_id가 필요합니다');
  const maxArts = Math.min(200, Math.max(1, parseInt(a.max_articles, 10) || 50));
  const useOff = process.env.MCP_DOC_OFFSET === 'on' && a.offset != null;   // offset 은 플래그 on + 인자가 있을 때만(없으면 응답 바이트 동일)
  const off = useOff ? Math.min(1e6, Math.max(0, parseInt(a.offset, 10) || 0)) : 0;
  return withPooled(["SET LOCAL statement_timeout='15s'"], async c => {
    const docId = await resolveDocId(c, docIn);
    const doc = (await c.query(
      `SELECT d.doc_id, d.corpus, d.doc_title, d.alias, d.doc_type, d.doc_date, d.rel_path,
              d.n_articles, d.usecases, i.inst_name, i.ministry,
              d.meta->>'edition_group'  AS edition_group,
              d.meta->>'edition_status' AS edition_status,
              d.meta->>'edition_basis'  AS edition_basis,
              COALESCE(NULLIF(d.meta->>'effective_from', ''), CASE WHEN d.corpus = 'bylaws' AND d.doc_date ~ '^[0-9]{8}$' THEN d.doc_date END) AS effective_from,
              NULLIF(d.meta->>'effective_to', '') AS effective_to,
              COALESCE(d.meta->>'repealed', '') = 'true' AS repealed,
              COALESCE(d.meta->>'lineage_closed', '') = 'true' AS lineage_closed, NULLIF(d.meta->>'lineage_successor', '') AS lineage_successor,
              d.created_at, d.updated_at
         FROM documents d LEFT JOIN institutions i USING (inst_code)
        WHERE d.doc_id = $1`, [docId])).rows[0];
    if (!doc) throw new Error('문서 없음: ' + docIn + NOT_FOUND_TAIL);
    const arts = (await c.query(
      `SELECT seq, section, chapter, art_no, art_sub, title, n_chars,
              CASE WHEN $2 THEN body ELSE left(body, 200) END AS body
         FROM articles WHERE doc_id = $1 ORDER BY seq LIMIT $3 OFFSET $4`,
      [docId, !!a.include_body, maxArts, off])).rows;
    const out = { document: annotateEdition([doc])[0], articles: arts, articles_shown: arts.length };
    if (useOff) {   // 이어받기 정보 — 실제 행 수(n_articles 와 다를 수 있음)
      const total = (await c.query('SELECT count(*)::int AS n FROM articles WHERE doc_id = $1', [docId])).rows[0].n;
      out.total_articles = total; out.offset = off;
      if (off + arts.length < total) out.next_offset = off + arts.length;
    }
    return out;
  });
}

async function toolGetArticle(a) {
  const docIn = String(a.doc_id || '');
  const artNo = parseInt(a.art_no, 10);
  if (!docIn || !Number.isFinite(artNo)) throw new Error('doc_id와 art_no(정수)가 필요합니다');
  return withPooled(["SET LOCAL statement_timeout='15s'"], async c => {
    const docId = await resolveDocId(c, docIn);
    const params = [docId, artNo];
    let sub = '';
    if (a.art_sub != null) { params.push(parseInt(a.art_sub, 10)); sub = ' AND art_sub = $3'; }
    const rows = (await c.query(
      `SELECT seq, section, chapter, art_no, art_sub, title, body
         FROM articles WHERE doc_id = $1 AND art_no = $2${sub} ORDER BY seq`, params)).rows;
    if (!rows.length) throw new Error(`조문 없음: ${docId} 제${artNo}조` + NOT_FOUND_TAIL);
    return { doc_id: docId, articles: rows };
  });
}

// ── MCP 도구 스키마 ───────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_corpus',
description: '한국 공공기관 ALIO 공시 문서(경영공시 disclosure·기관내규 bylaws·단체협약 ca)와 근거 법령(legal) 조항 검색. ' +
      '검색 모드: 기본은 trigram 키워드 검색(짧은 명사·3자 이상 권장). 문장형·여러 단어 질의는 hybrid:true 또는 semantic:true(키워드가 조문에 없어도 검색)를 권장. ' +
      '필터: corpus·inst(기관명 일부)·ministry·type·usecase·section. ' +
      '국가과학기술연구회 소관 출연연 23곳(공공기관 지정 해제)의 내규는 기본 검색에서 제외되니 search_extra 로 검색(기관명을 inst 로 주면 여기서도 나온다). ' +
      '기본은 «현행판만»(연혁·시행예정·폐지 법령·구판 내규·구연도 단체협약 제외, 별표·부칙 포함). 과거 판은 all_versions=true, "2019년 1월 시점 규정"처럼 시점이 있으면 as_of="2019-01-15". ' +
      '개수/전수 집계형 질문("몇 개"·목록화)에는 반드시 body=true(제목만 보면 누락)로 검색하고 limit을 넉넉히 둘 것. 집계 시 "조문 수"와 "고유 문서 수"는 다르니 rows의 doc_id로 문서 단위를 따로 세어 구분해 답할 것. ' +
      '각 row 의 edition_state(current|superseded|scheduled|repealed|lineage_closed)·edition_warning(현행이 아닐 때만)·effective_from/effective_to·section 으로 판본·효력을 확인해 답에 명시하고, edition_warning 이 있는 근거는 «현행 아님» 을 밝혀 인용할 것. ca 의 현행 판정은 폴더 연도 근사(edition_basis=folder_year_approx)이니 단정하지 말 것. ' +
      '응답에 degraded 가 있으면 일부 코퍼스·검색 팔이 실패한 «부분 결과» 이며 0건이 «없음» 을 뜻하지 않는다. ' +
      'same_doc 은 «같은 기관의 회차만 다른 동일 문서 N건» 표시(대표 1건만 rows, 다른 분기는 same_doc.rounds[].period_label). ' +
      'rerank 는 ' + docNote() + ' semantic 단독 검색에서만 붙고, applied=false 면 리랭킹 없이 원순위(reason 참조). ' +
      '공시 표 청크 행의 table_header 는 1번 청크의 열 이름 줄(청크만으론 열을 알 수 없어 붙임). 필터 응답의 docs_total(조건을 만족하는 공시 문서 수)·0건 때의 zero_reasons 도 확인할 것. ' +
      '공시 행은 period_label(공시 «회차» 라벨, 보고 대상 기간 아님)·submitted_at(공시일)을 답에 밝힐 것(period_label_adj=1~3월 공시 4분기 보고서의 «전년 4분기» 보정값). series_latest=false 는 «같은 기관·항목에 나중 공시가 있다» 는 뜻일 뿐 이 행이 틀렸다는 뜻이 아니다 — «최신·현재» 질문이면 나중 공시를 찾아 답하고, 특정 기간을 물었으면 그 기간 행을 쓴다(순서는 공시일 기준).' +
      (PAGING ? ' 결과는 기본 10건(limit 최대 50)이며 더 있을 수 있다: 응답에 has_more=true 가 있으면 next_offset 을 offset 으로 넣어 다음 쪽을 받고, 전수·목록 질문은 has_more 가 false 가 될 때까지 넘겨 볼 것(쪽마다 새로 검색하므로 쪽 경계에서 순위가 조금 바뀔 수 있다). 볼 수 있는 범위는 앞쪽 약 200건이며 window_exhausted=true 면 그 너머에 더 있다는 뜻이니 inst·section·키워드로 좁혀 다시 검색할 것.' : ''),

    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '검색어 (예: 연차수당, 육아휴직 대체인력)' },
        corpus: { type: 'string', enum: ['all', 'legal', 'bylaws', 'ca', 'disclosure'], description: '검색 코퍼스 (기본 all)' },
        semantic: { type: 'boolean', description: '의미검색 사용 (기본 false=키워드)' },
        hybrid: { type: 'boolean', description: '키워드+의미 RRF 융합 단일검색 — 어느 쪽인지 모호할 때 권장' },
        usecase: { type: 'string', description: '활용처 필터, 콤마=OR. 키: recruit·audit·governance·labor·finance·welfare·safety·security·esg(그 외 값은 0건+usecase_warning). 태그 있는 문서만 통과' },
        inst: { type: 'string', description: '기관명 필터 (부분일치)' },
        ministry: { type: 'string', description: '소관부처 필터' },
        type: { type: 'string', description: '문서유형 필터 (규정/지침/단체협약/법률...)' },
        body: { type: 'boolean', description: '본문까지 검색 (기본 제목만, 키워드 검색 전용)' },
        limit: { type: 'integer', description: PAGING ? '결과 수 1~50 (기본 10). 응답 has_more=true 면 offset 으로 다음 쪽' : '결과 수 1~50 (기본 10)' },
        ...(PAGING ? { offset: { type: 'integer', description: '건너뛸 결과 수(기본 0, 최대 198) — 응답 has_more=true 일 때 next_offset 값을 넣어 다음 쪽을 받는다. 볼 수 있는 범위는 앞쪽 약 200건' } } : {}),
        all_versions: { type: 'boolean', description: '연혁(구판)·시행예정·폐지 포함 (기본 false=현행판만)' },
        as_of: { type: 'string', description: '기준일 YYYY-MM-DD — 그 날짜에 유효한 판(법령·내규). all_versions 와 함께 쓰면 all_versions 가 우선' },
        section: { type: 'string', enum: ['all', '본칙', '부칙', '별표'], description: '조문 구분 필터 (기본 all=본칙·부칙·별표 전부)' },
        ...(SERIES_LATEST ? { latest_only: { type: 'boolean', description: '같은 기관·항목에 더 나중 공시가 있는 행(series_latest=false)을 뺀다(기본 false)' } } : {}),
        collapse_dup: { type: 'boolean', description: '같은 기관의 동일 문서(회차 재게시)를 대표 1건으로 접고 same_doc 로 표시 (기본 true, false=접지 않음)' },
        distinct_inst: { type: 'boolean', description: '기관(inst_name) 당 최상위 1건만 반환해 limit 개 기관까지 — "조건에 맞는 기관 N곳" 같은 기관 단위 집계용. 응답에 deduped_from(중복 제거 전 후보 수) 포함. 다기관 종합은 distinct_inst+기간+item+hybrid' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'get_document',
    description: '문서 메타데이터(판본·효력: edition_status·effective_from/to·repealed·lineage_* 포함)와 조문 목록 조회. search_corpus 결과의 문서를 자세히 볼 때 사용. ' +
      '조문은 seq 순 최대 max_articles(기본 50·상한 200)개이고 offset 이 없다 — 조문이 200개를 넘는 긴 문서의 뒷부분은 목록으로 볼 수 없으니(전체 개수는 document.n_articles) search_corpus 로 조문을 좁히거나 get_article 로 번호를 지정할 것. ' +
      'include_body=true 는 조문 전문을 모두 싣고 응답이 매우 커질 수 있으니 max_articles 를 줄여 쓸 것(기본은 본문 200자 미리보기).',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: '문서 ID (search_corpus 결과의 doc_id)' },
        include_body: { type: 'boolean', description: '조문 전문 포함 (기본 false=200자 미리보기). true 면 응답 크기 주의' },
        max_articles: { type: 'integer', description: '조문 수 상한 1~200 (기본 50). offset 없음 — 앞에서부터 이 개수만' },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'get_article',
    description: '특정 문서의 특정 조문(제N조) 전문 조회. doc_id 는 search_corpus/get_document 결과의 doc_id. art_no·art_sub 는 search_corpus row 의 art_ref 에서 얻는다(예 "제23조의2" → art_no=23, art_sub=2). ' +
      'art_sub 를 생략하면 art_no 가 같은 모든 행을 반환하고, 구분(본칙·부칙) 필터는 없으니 row 의 section 으로 구분할 것. ' +
      '별표 청크와 부칙 머리 청크는 art_no 가 비어 있어(파서 기준) art_no 로 조회되지 않는다 — 별표·부칙 내용은 search_corpus 의 section 필터나 get_document(include_body=true)로 볼 것. 번호 없는 행은 «조문 없음» 오류가 난다.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: '문서 ID (search_corpus/get_document 결과의 doc_id)' },
        art_no: { type: 'integer', description: '조 번호 (제N조의 N). search_corpus row 의 art_ref 에서 얻음' },
        art_sub: { type: 'integer', description: '가지조문 번호 (제N조의M의 M, 선택). 예 "제23조의2" → 2. 생략 시 같은 art_no 전부' },
      },
      required: ['doc_id', 'art_no'],
    },
  },
];

// 항목·기간 필터 안내(ITEM_FILTER 가 explicit|auto 일 때만 — off 면 도구 목록이 종전과 같다)
if (ITEM_ON) {
  const t = TOOLS[0];
  t.description += ' ' + IF.describeItems() + ' item 만 주고 keyword 를 빈 문자열("")로 두면 그 항목 문서를 제출일 최신순으로 나열한다(inst 병용 가능). 응답의 item_resolved 로 적용된 항목 코드를 확인하고, unresolved/suggestions 는 항목명 발견용, ambiguous 면 후보 중 하나를 골라 다시 호출하며, period_warning 이 있으면 기간 값을 확인할 것. 항목만(inst 없이) 의미검색해 결과가 없거나 filtered_short·candidate_cap_reached 가 있으면 keyword 에 항목명을 넣고 item 을 함께 지정하거나 inst 를 줄 것.';
  Object.assign(t.inputSchema.properties, {
    item: { type: 'string', description: '공시 항목 — 이름(자연어)·별칭·코드, 쉼표로 여러 개. 예: "임직원 수", "수의계약", "노동조합 가입정보", "소송 및 법률자문 현황", "21301". 코드를 몰라도 된다. 20401=신규채용 인원 통계 vs B1020=채용 공고(다름). disclosure 문서에만 적용' },
    period: { type: 'string', description: '공시 «회차(제출)» 기간 — "2026Q2"(분기) | "2026"(연) | "2026-07"(제출월) | "latest"(기관·항목 계열별 최신 1건). ⚠ 보고 대상 분기·연도가 아님(1~3월 제출 4분기 보고서는 다음 해 라벨) — 대상 기간은 report_period' },
    report_period: { type: 'string', description: '공시 «보고 대상» 분기/연도 — "2025Q4"|"2025" (period_label_adj 기준: 1~3월에 제출한 4분기 보고서는 전년 4분기로 계산). disclosure 에만 적용' },
    target_year: { type: 'string', description: '자료 대상 연도 "2025" — 문서 제목의 «20XX년» 으로 거름(재게시되는 과거 연도 첨부 제외용). 제목에 연도 없는 문서(예 «임직원 수 2025Q4»)는 제외되니 그땐 report_period(연도가 제목에 없는 문서는 report_period). disclosure 에만 적용' },
    sort: { type: 'string', enum: ['latest'], description: '"latest" = 같은 기관·항목 계열 안에서 공시 제출일이 최신인 것을 앞으로(계열 사이 순서는 관련도 그대로)' },
  });
}

// MCPdeep: 도구 스키마 추가(MCP_DEEP=on 일 때만) — 설명은 짧게(도구 목록 크기 예산)
if (DEEP) {
  Object.assign(TOOLS[0].inputSchema.properties, {
    expand: { type: 'boolean', description: '동의어 확장 검색(1쪽만, expanded_terms)' },
    months: { type: 'integer', description: '최근 N개월 제출분(제출일 기준)' },
    brief: { type: 'boolean', description: '본문 120자로 축소' },
  });
  Object.assign(TOOLS[1].inputSchema.properties, {
    find: { type: 'string', description: '이 표현("A|B")이 나온 구절만 반환(긴 문서용)' }, expand: { type: 'boolean' },
  });
}

if (AM.on()) TOOLS[0].description += AM.ROUTING;   // QueryStudy ④ 도구 설명 라우팅 규칙(SEARCH_AUTO_MODE=on)

if (SH.hidOn()) TOOLS[0].inputSchema.properties.include_short = { type: 'boolean', description: '본문 없는 공시 껍데기 페이지도 포함' };   // c6

// 기관 수 집계(REST /api/count_inst 와 같은 질의): «X 가 본문에 나오는 기관은 몇 곳» — search_corpus 는 상위 후보만 봐서 전체를 못 센다. 기존 도구·응답은 바꾸지 않는다.
TOOLS.push({
  name: 'count_institutions',
  description: '조문 본문에 키워드 문자열이 들어 있는 기관이 모두 몇 곳인지 DB 에서 직접 센다(corpus 별 기관 수 + 중복 제외 합계, max_list 로 기관 이름 목록). «OO 가 나오는 기관은 몇 곳/몇 개»·«OO 제도를 다루는 기관 수» 같은 전체 집계 질문에 쓴다. 센 것은 «문서에 그 문구가 있는 기관» 이지 제도를 시행하는 기관이 아니다(언급·부정문 포함, 모든 판본 기준) — 답할 때 이 한계를 함께 말할 것. 키워드는 2~30자의 핵심 명사(예: 법률구조).',
  inputSchema: { type: 'object', properties: {
    keyword: { type: 'string', description: '본문에서 찾을 문구(핵심 명사, 2~30자)' },
    corpus: { type: 'string', enum: ['all', 'disclosure', 'bylaws', 'ca', 'legal'], description: '범위(기본 all)' },
    max_list: { type: 'integer', description: '기관 이름 목록을 함께 받을 개수(0~200, 기본 0=숫자만)' },
  }, required: ['keyword'] },
});
TOOLS.push({
  name: 'search_extra',
  description: '국가과학기술연구회 소관 정부출연연구기관 23곳(한국과학기술연구원·한국생산기술연구원·한국전자통신연구원·한국기계연구원·한국원자력연구원·한국항공우주연구원·대구경북과학기술원·세계김치연구소 등, 공공기관 지정 해제로 ALIO 공시대상 355곳과 별개)의 «내규(규정)» 만 검색한다. ' +
    '인사규정·취업규칙·보수규정·복무규정 등 출연연 규정이 궁금할 때 쓴다. 공시대상 355곳의 규정·경영공시·단체협약은 search_corpus 를 쓴다(이 도구에는 없다). ' +
    '특정 기관이면 inst 에 기관명을 준다. 검색 방식·판본(현행판 기본)·응답 형식은 search_corpus 와 같다.' + (PAGING ? ' has_more=true 면 next_offset 을 offset 으로 넣어 다음 쪽을 받는다.' : ''),
  inputSchema: { type: 'object', properties: {
    keyword: { type: 'string', description: '검색어 (예: 연차휴가, 육아휴직)' },
    inst: { type: 'string', description: '출연연 기관명 필터 (부분일치, 예: 한국생산기술연구원)' },
    semantic: { type: 'boolean', description: '의미검색 사용 (기본 false=키워드)' },
    hybrid: { type: 'boolean', description: '키워드+의미 RRF 융합 단일검색 — 문장형 질의에 권장' },
    type: { type: 'string', description: '문서유형 필터 (규정/지침/세칙...)' },
    body: { type: 'boolean', description: '본문까지 검색 (기본 제목만, 키워드 검색 전용)' },
    limit: { type: 'integer', description: '결과 수 1~50 (기본 10)' },
    ...(PAGING ? { offset: { type: 'integer', description: '건너뛸 결과 수(기본 0, 최대 198)' } } : {}),
    all_versions: { type: 'boolean', description: '구판 포함 (기본 false=현행판만)' },
    as_of: { type: 'string', description: '기준일 YYYY-MM-DD — 그 날짜에 유효한 판' },
    section: { type: 'string', enum: ['all', '본칙', '부칙', '별표'], description: '조문 구분 필터 (기본 all)' },
  }, required: ['keyword'] },
});
// ── MCPfix: search_corpus 입력 검증·한계 고지 래퍼 — 기존 응답 키는 그대로, 키만 추가한다 ─────────────────────
const CORPORA = ['all', 'legal', 'bylaws', 'ca', 'disclosure'];
const ROWLIST_ITEMS = ['B1030', '70301', '21301', '21311', '20701', '21201', '21211'];   // 수의계약·소송·업무추진비·징계 등 «행 목록» 항목
const FIN_MIX_ITEMS = ['31201', '31301', '31401'];                                          // 연결·별도 표가 함께 게재되는 요약 재무
const RANKQ = /(가장|제일|최다|최대|최소|최고|많은|적은|높은|낮은|상위|하위|순위|랭킹|TOP\s*\d)/i;
const SIZE_WARN = +process.env.MCP_RESPONSE_WARN_BYTES || 60000;
async function searchWrapped(toolName, a, forced, open = true) {
  a = a && typeof a === 'object' ? a : {};
  let amode = null;
  let autoInst = null, autoAsOf = null;
  if (AM.on() && (toolName === 'search_corpus' || toolName === 'search_extra')) {
    amode = AM.decide({ keyword: a.keyword, corpus: toolName === 'search_extra' ? 'bylaws' : a.corpus, hybrid: a.hybrid, semantic: a.semantic, body: a.body });
    if (amode) { a = { ...a, hybrid: true }; if (!a.inst) { const li = AM.liftInst(a.keyword); if (li) { a.inst = li; autoInst = li; } } }   // c5: 질의 속 기관명 → inst 필터(승격 질의만)
    if (a.corpus === 'legal' && !a.as_of && !a.all_versions) { const d = AM.dateToAsOf(a.keyword); if (d) { a = { ...a, as_of: d.asOf, keyword: d.keyword }; autoAsOf = d; } }   // c5: 날짜·판본 문구 → as_of
  }
  const closedIg = [];
  if (DEEP && !open && toolName === 'search_corpus') { a = { ...a }; for (const k of DEEP_ARGS) if (a[k] !== undefined) { closedIg.push(k); delete a[k]; } }
  const t = TOOLS.find(x => x.name === toolName), known = new Set(Object.keys((t && t.inputSchema.properties) || {})), n = {};
  const ig = Object.keys(a).filter(k => !known.has(k) && a[k] !== undefined);
  ig.push(...closedIg);
  if (ig.length) n.params_ignored = ig.map(k => k === 'corpus' && toolName === 'search_extra' ? 'corpus (search_extra 는 내규(bylaws) 고정)' : k);
  if (toolName === 'search_corpus' && a.corpus != null && a.corpus !== '' && !CORPORA.includes(a.corpus))
    throw new Error('corpus 는 ' + CORPORA.join('|') + ' 중 하나여야 합니다(받은 값: ' + String(a.corpus).slice(0, 30) + ')');
  if (a.limit != null && a.limit !== '') {
    const ok = /^\d+$/.test(String(a.limit).trim()) && +a.limit >= 1 && +a.limit <= 50;
    if (!ok) n.limit_adjusted = { requested: a.limit, applied: Math.min(50, Math.max(1, parseInt(a.limit, 10) || 10)), reason: 'limit 은 1~50 정수 — 범위 밖·비정수는 조정됐다(더 많은 건은 has_more·next_offset 또는 조건 좁히기)' };
  }
  const shOn = SH.anyOn() && (toolName === 'search_corpus' || toolName === 'search_extra'), origLimit = Math.min(50, Math.max(1, parseInt(a.limit, 10) || 10)), shOff = Math.min(198, Math.max(0, parseInt(a.offset, 10) || 0));
  const fetchN = shOn ? Math.min(50, origLimit + Math.max(2, Math.ceil(origLimit / 4))) : origLimit;   // c8: 껍데기·조각 처리로 줄어들 몫만 더 받는다(2배 → +25%: limit 20 지연 완화)
  let out = await toolSearchCorpus(toolName === 'search_extra' ? { ...a, corpus: 'bylaws' } : shOn ? { ...a, limit: fetchN } : a, forced);
  if (shOn && Array.isArray(out.rows)) {
    const preRows = out.rows.length, hadMore = !!out.has_more, paging = out.has_more !== undefined;
    let rows = out.rows, notes = {};
    if (preRows) {
      const r = await SH.handle((sql, p) => withPooled(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='5s'"], async c => (await c.query(sql, p)).rows), out.rows, { includeShort: a.include_short === true, filtered: !!(a.inst && a.item) }).catch(e => { process.stderr.write('[mcp] shell_docs: ' + e.message + '\n'); return null; });
      if (r) { rows = r.rows; notes = r.notes; }
    }
    const cut = rows.slice(0, origLimit), more = preRows > origLimit || rows.length > origLimit || hadMore;   // 잘라낸 행·다음 쪽이 있으면 has_more 보존
    out = { ...out, rows: cut, count: cut.length, ...(out.limit !== undefined ? { limit: origLimit } : {}), ...(Object.keys(notes).length ? { shell: notes } : {}) };
    if (paging) { out.has_more = more; if (more && shOff + origLimit <= 198) { out.next_offset = shOff + origLimit; delete out.window_exhausted; } else if (more) { delete out.next_offset; out.window_exhausted = true; } else delete out.next_offset; }
    if (!cut.length) delete out.zero_hint;
  }
  if (DEEP && open) out = await deepSearchPost(toolName, a, forced, out, n);
  if (CG.on() && out.item_resolved && out.item_resolved.codes && out.item_resolved.codes.length) { const cv = await coverageFor(out.item_resolved.codes); if (cv) out = { ...out, item_coverage: cv }; }   // c6
  if (amode) out = { ...out, auto_mode: amode.mode, auto_mode_reason: amode.reason };
  if (autoInst) out = { ...out, auto_inst: autoInst, auto_inst_note: '질의 속 기관명을 inst 필터로 적용했습니다(다른 기관 결과를 원하면 inst 를 직접 지정).' };
  if (autoAsOf) out = { ...out, auto_as_of: autoAsOf.asOf, auto_as_of_note: '질의의 날짜 표현(«' + autoAsOf.phrase + '»)을 as_of 판본 필터로 바꾸고 검색어에서 뺐습니다.' };
  if (AM.on() && out.count === 0 && !out.degraded && (toolName === 'search_corpus' || toolName === 'search_extra')) {
    const zi = await AM.zeroInfo((sql, p) => withPooled(["SET LOCAL transaction_read_only = on", "SET LOCAL statement_timeout='5s'"], async c => (await c.query(sql, p)).rows),
      { inst: resolveInst(a.inst) || null, corpus: toolName === 'search_extra' ? 'bylaws' : a.corpus || 'all', period: a.period, reportPeriod: a.report_period, targetYear: a.target_year }, a, out);
    out = { ...out, ...zi };
  }
  const notes = [], codes = (out.item_resolved && out.item_resolved.codes) || [];
  if (codes.some(c => ROWLIST_ITEMS.includes(c))) notes.push('행 목록형 항목(계약·소송·업무추진비·징계 등): 검색 결과 청크는 표의 일부(예: 4행 단위)이며 전수가 아니다. 건수 합계·상대방별 집계·«가장 많은» 판정은 이 도구로 할 수 없다 — 해당 문서를 get_document(include_body=true)로 끝까지 읽고 «일부만 확인» 이라 밝힐 것.');
  if (codes.some(c => FIN_MIX_ITEMS.includes(c))) notes.push('재무 항목은 연결·별도 표가 한 문서에 섞여 있을 수 있다 — 청크가 연결 기준인지 별도 기준인지 표 제목으로 확인할 것(structured_query field_values 는 연결·별도를 모두 보려면 tables="all").');
  if (RANKQ.test(String(a.keyword || '')) && /(기관|공단|공사|곳)/.test(String(a.keyword || ''))) notes.push('«가장 많은/최다/순위» 류 기관 비교는 이 검색으로 전수 판정이 불가능하다(상위 후보만 본다). 전체 순위로 단정하지 말고, 기관별 값 비교는 structured_query(기관 최대 5곳)로 확인할 것.');
  const res = { ...out, ...n, ...(notes.length ? { coverage_notes: notes } : {}) };
  const bytes = Buffer.byteLength(JSON.stringify(res));
  if (bytes > SIZE_WARN) res.size_warning = `응답이 ${Math.round(bytes / 1024)}KB 로 큽니다(body=true·limit 큼) — limit 를 줄이거나 body=false 로 먼저 찾고 필요한 doc_id 만 get_document 로 읽으세요.`;
  return res;
}
const CLOSED_MSG = '이 도구는 현재 사용 등급에서는 제공되지 않습니다. search_corpus(body=true)·get_document·count_institutions 를 사용하세요.';
// 등급별 도구 목록: 닫힌 등급에는 scan_documents 와 신규 인자(expand·months·brief·find)를 뺀 «기존» 목록(DEEP off 와 바이트 동일)을 준다. 지연 생성·캐시.
let _baseTools = null;
let _noFc = null;
let _lcOrig = null;   // FindCasesPlus: list_catalog 원래 스키마(닫힌 등급은 case_* kind 를 모르는 «기존» 목록을 받는다)
function toolsFor(tier) {   // SqlTool: 등급별 목록 — 닫힌 등급은 query_sql 과 list_catalog 의 sql_guide kind 를 뺀다, 열린 등급은 list_catalog enum 에 sql_guide 가 빠져 있으면(FindCases 닫힘 등) 넣는다(캐시). 그 앞단은 FindCases 목록
  const t = toolsForFc(tier);
  if (!SQL_TOOL) return t;
  const op = SQLT.open(tier), c = op ? _sqlOpen : _sqlClosed;
  if (c.src === t) return c.out;
  const fix = x => { if (x.name !== 'list_catalog') return x; const k = x.inputSchema && x.inputSchema.properties && x.inputSchema.properties.kind; if (!k || !Array.isArray(k.enum)) return x;
    if (op === k.enum.includes(SQLT.CATALOG_KIND)) return x; const y = JSON.parse(JSON.stringify(x)); y.inputSchema.properties.kind.enum = op ? [...k.enum, SQLT.CATALOG_KIND] : k.enum.filter(v => v !== SQLT.CATALOG_KIND); return y; };
  c.src = t; c.out = (op ? t : t.filter(x => x.name !== 'query_sql')).map(fix); return c.out;
}
const _sqlOpen = {}, _sqlClosed = {};
function toolsForFc(tier) {   // FindCases: 닫힌 등급에서는 find_cases 를 목록에서 뺀다(캐시)
  const t = toolsForDeep(tier);
  if (!FIND_CASES || fcOpen(tier)) return t;
  if (!_noFc || _noFc.src !== t) _noFc = { src: t, out: t.filter(x => x.name !== 'find_cases').map(x => (x.name === 'list_catalog' && _lcOrig) ? _lcOrig : x) };
  return _noFc.out;
}
function toolsForDeep(tier) {
  if (!DEEP || deepOpen(tier)) return TOOLS;
  if (!_baseTools) {
    _baseTools = JSON.parse(JSON.stringify(TOOLS.filter(t => t.name !== 'scan_documents')));
    for (const k of DEEP_ARGS) delete _baseTools.find(t => t.name === 'search_corpus').inputSchema.properties[k];
    for (const k of ['find', 'expand']) delete _baseTools.find(t => t.name === 'get_document').inputSchema.properties[k];
    const sc = _baseTools.find(t => t.name === 'search_corpus'); sc.description = sc.description.replace(' 전수 본문 탐색은 scan_documents.', '');
  }
  return _baseTools;
}
// MCPdeep: search_corpus 후처리 — expand(동의어 변형 검색 병합)·부처 구명칭 고지·months 고지·brief(본문 120자)·distinct_inst 안내
const rowKey = r => [r.doc_id, r.art_ref || '', r.seq == null ? '' : r.seq, r.art_title || ''].join('|');
async function deepSearchPost(toolName, a, forced, out, n) {
  const notes = [];
  const mi = QX.resolveMinistry(a.ministry); if (mi.from) out = { ...out, ministry_resolved: { from: mi.from, to: mi.value, ...(mi.note ? { note: mi.note } : {}) } };
  if (toolName === 'search_corpus' && a.expand === true && String(a.keyword || '').trim()) {
    const vs = QX.variantsOf(a.keyword, 4);
    if (vs.length) {
      const lim = Math.min(50, Math.max(1, parseInt(a.limit, 10) || 10));
      const extra = await Promise.all(vs.map(v => toolSearchCorpus(toolName === 'search_extra' ? { ...a, keyword: v, corpus: 'bylaws', offset: 0 } : { ...a, keyword: v, offset: 0 }, forced).then(o => (o.rows || []).map(r => ({ ...r, matched_via: v }))).catch(() => null)));
      const failed = extra.filter(x => x === null).length, seen = new Set((out.rows || []).map(rowKey)), merged = [...(out.rows || [])];
      for (const rs of extra) for (const r of rs || []) { const k = rowKey(r); if (!seen.has(k)) { seen.add(k); merged.push(r); } }
      merged.sort((x, y) => (parseFloat(y.score) || 0) - (parseFloat(x.score) || 0));
      out = { ...out, rows: merged.slice(0, Math.max(lim, 1)), count: Math.min(merged.length, Math.max(lim, 1)), expanded_terms: [{ from: String(a.keyword).slice(0, 100), added: vs }], ...(failed ? { expand_degraded: failed + '개 변형 검색 실패 — 일부 확장어 누락' } : {}) };
      delete out.zero_hint; delete out.hint; delete out.zero_reasons;
      if (PAGING) { delete out.has_more; delete out.next_offset; notes.push('expand=true 는 1쪽(앞 limit 건)만 병합합니다 — 쪽넘김(offset) 불가. 더 보려면 scan_documents.'); }
    }
  }
  if (toolName === 'search_corpus' && a.brief === true && Array.isArray(out.rows)) out = { ...out, rows: out.rows.map(r => (typeof r.body === 'string' && r.body.length > 120) ? { ...r, body: r.body.slice(0, 120) + '…' } : r), brief: true };
  if (a.months != null && a.months !== '' && IF.mode() !== 'off') notes.push('months 는 제출일(submitted_at) 기준이라 제출일 메타가 없는 문서(예: B1030 계약정보 첨부)는 빠진다 — 그런 항목은 period·target_year 로.');
  if (!a.distinct_inst && /(몇\s*곳|몇\s*개\s*기관|기관(은|이)?\s*몇|기관\s*수|어느\s*기관|어떤\s*기관|기관이\s*있)/.test(String(a.keyword || '')) && Array.isArray(out.rows) && out.rows.length > 1)
    notes.push('기관 단위 질문이면 distinct_inst=true(기관당 1건) 로 다시 검색하고, 전체 기관 수는 count_institutions·scan_documents(distinct_inst) 로 셀 것.');
  if (notes.length) out = { ...out, deep_notes: notes };
  return out;
}
const HANDLERS = { search_corpus: (a, cctx) => SCACHE.through('search_corpus', a, cctx, withPooled, () => searchWrapped('search_corpus', a, undefined, deepOpen(cctx && cctx.tier))), get_document: toolGetDocument, get_article: toolGetArticle,
  count_institutions: a => countInst(withPooled, a), search_extra: (a, cctx) => SCACHE.through('search_extra', a, cctx, withPooled, () => searchWrapped('search_extra', a, 'extra')) };
EXT.install({ TOOLS, HANDLERS, withPooled, resolveDocId });
// ── c6: 표 머리글(get_document)·코드 가이드·item_coverage·서빙 계층 전용(DB 변경·재임베딩 없음). 각 플래그 off 면 아래는 무동작 ──
const itemCodesOf = item => { try { const r = IF.resolveExplicit(item); return r.codes || []; } catch { return []; } };
async function coverageFor(codes) {
  const out = []; for (const c of codes.slice(0, 2)) { try { out.push(await CG.itemCoverage(withPooled, c, IF.categoriesFor([c]))); } catch { /* 커버리지 없이 계속 */ } }
  return out.length === 0 ? null : out.length === 1 ? out[0] : out;
}
if (CG.on()) {
  for (const name of ['get_series', 'structured_query']) { const h = HANDLERS[name]; if (!h) continue;
    HANDLERS[name] = async (a, cctx) => { const out = await h(a, cctx); const codes = a && a.item ? itemCodesOf(a.item) : []; if (!codes.length || !out || typeof out !== 'object') return out; const cv = await coverageFor(codes); return cv ? { ...out, item_coverage: cv } : out; }; }
  const lc = HANDLERS.list_catalog;
  if (lc) HANDLERS.list_catalog = async (a, cctx) => {
    const out = await lc(a, cctx); if (!out || out.kind !== 'items' || !Array.isArray(out.items)) return out;
    const full = out.items.length <= 8;
    const items = out.items.map(it => { const gs = (it.codes || []).map(c => { const g = CG.guideFor(c); return g ? { code: c, type: g.type, structured: g.structured, status: g.status, ...(full ? { how: g.how, ...(g.caveat ? { caveat: g.caveat } : {}) } : {}) } : null; }).filter(Boolean); return gs.length ? { ...it, guide: gs } : it; });
    return { ...out, items, guide_note: full ? '코드별 유형·구조화 상태·권장 호출(how)·주의(caveat) 포함.' : '항목이 많아 how·caveat 는 생략 — q 로 좁히면 상세가 붙는다. status: confirmed 구조화 확정·pending 재처리 대기·search_only 검색만.' };
  };
}
if (TH.v2On()) {   // get_document: 표 조각(2번째 이후 청크)에 1번 청크의 열 이름 줄을 별도 필드로 결합(본문·구분자는 불변)
  const gd = HANDLERS.get_document;
  HANDLERS.get_document = async (a, cctx) => {
    const out = await gd(a, cctx); if (!out || !Array.isArray(out.articles) || !out.document || out.document.corpus !== 'disclosure') return out;
    const c1 = await withPooled(["SET LOCAL statement_timeout='5s'"], async c => (await c.query('SELECT left(body, 1500) AS b FROM articles WHERE doc_id = $1 AND seq = 1', [out.document.doc_id])).rows[0]).catch(() => null);
    if (!c1) return out;
    let n = 0; const articles = out.articles.map(r => { if (r.seq === 1 || !r.body) return r; const h = TH.headerFor(c1.b, r.body); if (!h) return r; n++; return { ...r, table_header: h.text, header_source: h.source, header_confidence: h.confidence }; });
    return n ? { ...out, articles, table_header_note: '표 조각의 table_header 는 같은 문서 1번 청크에서 찾은 열 이름 줄(header_source·header_confidence 참고, 추정일 수 있음) — 본문은 그대로다.' } : out;
  };
}
if (DEEP) {   // MCPdeep: 새 도구·find 분기 — 호출 한도는 mcp_ext.heavyLimited('scan')
  const baseGetDoc = HANDLERS.get_document;
  HANDLERS.get_document = async (a, cctx) => {
    const wantFind = a && a.find != null && a.find !== '';
    if (wantFind && deepOpen(cctx && cctx.tier)) return SC.findInDocument(withPooled, resolveDocId, annotateEdition, a);
    const out = await baseGetDoc(a, cctx);
    return wantFind ? { ...out, params_ignored: ['find'] } : out;   // 닫힌 등급: find 는 무시(문서 기본 응답)
  };
  TOOLS.push(SC.toolDef());
  HANDLERS.scan_documents = async (a, cctx) => {
    if (!deepOpen(cctx && cctx.tier)) throw new Error(CLOSED_MSG); const lim = EXT.heavyLimited('scan', cctx); if (lim) throw new Error(`scan_documents 호출 한도(분당 ${lim.max}회)를 넘었습니다. ${lim.retry}초 후 다시 시도하세요.`); return SC.scanDocuments(withPooled, a); };
}   // 플래그가 모두 off 면 TOOLS·HANDLERS 불변
if (FIND_CASES) {   // FindCases: 사례 카드 검색 — 본체 find_cases.js(READ ONLY·한도·마스킹은 거기서)
  const FC = require('./find_cases.js');
  TOOLS.push(FC.toolDef());
  HANDLERS.find_cases = async (a, cctx) => {
    if (!fcOpen(cctx && cctx.tier)) throw new Error(CLOSED_MSG);
    try { return await FC.findCases(withPooled, a, cctx); }
    catch (e) { if (['BAD_REQUEST', 'BUSY'].includes(e.code)) throw e; if (e.code === '57014' || /statement timeout/i.test(e.message)) throw new Error('사례 카드 조회가 시간 제한에 걸렸습니다. code·months·inst 로 범위를 좁혀 다시 시도하세요.'); process.stderr.write('[find_cases] ' + (e.code || '') + ' ' + e.message + '\n'); throw new Error('조회 실패(잠시 후 다시 시도)'); }
  };
  // FindCasesPlus: list_catalog 에 find_cases 어휘(주제·유형·결과·코드) kind 를 덧붙인다 — 기존 kind 는 원래 핸들러 그대로(등급 닫힘이면 새 kind 는 거부)
  const lc0 = HANDLERS.list_catalog, lcT = TOOLS.find(t => t.name === 'list_catalog');
  if (lc0 && lcT && lcT.inputSchema && lcT.inputSchema.properties && lcT.inputSchema.properties.kind && Array.isArray(lcT.inputSchema.properties.kind.enum)) {
    _lcOrig = JSON.parse(JSON.stringify(lcT));
    lcT.inputSchema.properties.kind.enum = [...lcT.inputSchema.properties.kind.enum, ...FC.CATALOG_KINDS];
    lcT.inputSchema.properties.code = { type: 'string', description: 'case_* kind 에서 코드 한정' };
    HANDLERS.list_catalog = async (a, cctx) => {
      if (!(a && FC.CATALOG_KINDS.includes(a.kind))) return lc0(a, cctx);
      if (!fcOpen(cctx && cctx.tier)) throw new Error(CLOSED_MSG);
      try { return await FC.catalogExt(withPooled, a); }
      catch (e) { if (e.code === 'BAD_REQUEST') throw e; process.stderr.write('[list_catalog:case] ' + (e.code || '') + ' ' + e.message + '\n'); throw new Error('목록 조회 실패(잠시 후 다시 시도)'); }
    };
  }
}

if (SQL_TOOL) {   // SqlTool: 읽기 전용 SQL 도구 — 본체 sql_tool.js(검증·READ ONLY·한도·정책 고지). DB 접속은 SQL_TOOL_PG* env(전용 읽기 전용 롤), 없으면 호출 시 «설정되지 않음» 오류
  const { resolveInst } = require('./inst_alias.js');
  TOOLS.push(SQLT.toolDef());
  HANDLERS.query_sql = async (a, cctx) => {
    if (!SQLT.open(cctx && cctx.tier)) throw new Error(CLOSED_MSG);
    try { return await SQLT.querySql(a, cctx, resolveInst); }
    catch (e) { if (['BAD_REQUEST', 'BUSY'].includes(e.code)) throw e; process.stderr.write('[query_sql] ' + (e.code || '') + ' ' + e.message + '\n'); throw new Error(/설정되지 않았/.test(e.message) ? e.message : '조회 실패(잠시 후 다시 시도)'); }
  };
  const lc1 = HANDLERS.list_catalog, lcS = TOOLS.find(t => t.name === 'list_catalog');
  if (lc1 && lcS && lcS.inputSchema && lcS.inputSchema.properties && lcS.inputSchema.properties.kind && Array.isArray(lcS.inputSchema.properties.kind.enum)) {
    lcS.inputSchema.properties.kind.enum = [...lcS.inputSchema.properties.kind.enum, SQLT.CATALOG_KIND];
    HANDLERS.list_catalog = async (a, cctx) => {
      if (!(a && a.kind === SQLT.CATALOG_KIND)) return lc1(a, cctx);
      if (!SQLT.open(cctx && cctx.tier)) throw new Error(CLOSED_MSG);
      try { return SQLT.sqlGuide(a, cctx); } catch (e) { process.stderr.write('[list_catalog:sql_guide] ' + e.message + '\n'); throw new Error('SQL 가이드를 불러오지 못했습니다(잠시 후 다시 시도)'); }
    };
  }
  if (process.env.SQL_TOOL_CATALOG_HINT === 'on') {   // c13 후보(기본 off): list_catalog(kind=institutions) 0건 → 약칭이면 정식명 안내, 아니면 «확인할 수 없음» 종결 문구(탐색 루프 완화)
    const lc2 = HANDLERS.list_catalog;
    HANDLERS.list_catalog = async (a, cctx) => {
      const out = await lc2(a, cctx);
      if (!(a && a.kind === 'institutions' && out && out.kind === 'institutions' && out.total === 0 && Array.isArray(out.items) && !out.items.length && SQLT.open(cctx && cctx.tier))) return out;
      let alias = null; try { const r = a.q ? resolveInst(String(a.q)) : null; if (r && r !== a.q) alias = r; } catch { /* 힌트 없이 */ }
      return { ...out, not_found_hint: alias ? `«${a.q}» 는 약칭일 수 있습니다 — 정식명 «${alias}» 로 한 번 더 조회하세요.` : '공시 대상 목록에 없음 → «확인할 수 없음» 으로 답하세요(약칭이면 정식명으로 한 번만 더 확인하고, 같은 조회를 반복하지 마세요).' };
    };
  }
}

// ── MCP stdio 루프 (줄단위 JSON-RPC 2.0) ─────────────────────────────────────

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');

// 🔴 전송 계층 분리(2026-09-21): dispatch 는 «응답 객체를 반환»한다(알림이면 null).
//    stdio 는 그 결과를 stdout 에 쓰고, HTTP(mcp_http.js)는 본문으로 돌려준다.
//    한 곳에서 프로토콜을 처리해야 두 전송의 동작이 갈라지지 않는다.
async function dispatch(req, tier, label) {   // label: 서빙이 판정한 키 별칭(질의 로그 전용)
  const { id, method, params } = req;
  if (method === 'initialize') {
    return ({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'alio-rag', version: '1.0.0' },
    } });
  }
  if (method === 'notifications/initialized' || String(method).startsWith('notifications/')) return null; // 알림은 무응답
  if (method === 'ping') return ({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return ({ jsonrpc: '2.0', id, result: { tools: toolsFor(tier) } });
  if (method === 'tools/call') {
    const name = params?.name;
    const fn = (name === 'scan_documents' && DEEP && !deepOpen(tier)) || (name === 'find_cases' && FIND_CASES && !fcOpen(tier)) || (name === 'query_sql' && SQL_TOOL && !SQLT.open(tier)) ? async () => { throw new Error(CLOSED_MSG); } : HANDLERS[name];
    if (!fn) return ({ jsonrpc: '2.0', id, error: { code: -32602, message: '알 수 없는 도구: ' + name } });
    const _ql = qlog.begin('mcp', name, tier, params?.arguments, label), _t0 = Date.now();
    const _slowLog = ok => { const SLOW = process.env.SLOW_LOG_MS === undefined ? 3000 : +process.env.SLOW_LOG_MS, ms = Date.now() - _t0; if (SLOW > 0 && ms >= SLOW) process.stderr.write(`[mcp-slow] ${name} ${ok ? 'ok' : 'err'} ${ms}ms${params?.arguments?.hybrid ? ' hybrid' : ''}${params?.arguments?.semantic ? ' semantic' : ''}\n`); };   // 검색어·인자 값은 남기지 않는다
    try {
      const out = maskOut(await fn(params?.arguments || {}, { tier, label }), tier);
      _ql.end({ out });
      _slowLog(true);
      return ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] } });
    } catch (e) {
      _ql.end({ err: qlog.errOf(e) });
      _slowLog(false);
      let msg = e.message;
      if (e.code === '57014' || /statement timeout/i.test(msg)) {   // 원 오류(코드)는 로그에만 — 에이전트에는 다음 행동을 알려 준다
        process.stderr.write(`[mcp] ${name}: statement_timeout (code ${e.code || '57014'}): ${msg}\n`);
        const _ta = params?.arguments || {}, _kw = String(_ta.keyword || '').trim();
        msg = '검색이 시간 제한에 걸렸습니다. '
          + (_ta.body && _kw.length < 3 ? '2자 이하 짧은 검색어를 body=true(본문 검색)로 찾으면 오래 걸립니다 — body=false(조제목 검색)로 하거나 3자 이상의 구체적인 검색어를 쓰세요. '
            : _ta.body ? 'body=true(본문 검색)는 느립니다 — body=false 로 먼저 찾거나 검색어를 더 구체적으로 하세요. ' : '')
          + 'inst 필터·corpus 지정·limit 축소·더 구체적인 키워드로 다시 시도하세요(같은 요청을 그대로 반복하지 마세요).';
      }
      return ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '오류: ' + msg }], isError: true } });
    }
  }
  if (id !== undefined) return ({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  return null;
}

// stdio 전용 래퍼 — 종전 동작 그대로.
async function handle(req) {
  const res = await dispatch(req, 'internal', 'stdio');   // stdio 는 DB 자격증명을 로컬에서 직접 쓰는 방식 — 종전 동작(internal) 유지
  if (res) send(res);
}

// 🔴 require 되면 stdio 루프를 띄우지 않는다 — mcp_http.js 가 dispatch 만 쓴다.
module.exports = { dispatch, TOOLS, HANDLERS, pool };

if (require.main === module) {
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    handle(req).catch(e => process.stderr.write('[mcp] ' + e.message + '\n'));
  }
});
process.stdin.on('end', () => { pool.end().finally(() => process.exit(0)); });
}
