'use strict';
/**
 * SqlTool: query_sql(읽기 전용 SQL) + list_catalog(kind=sql_guide). 클라이언트 LLM 이 SQL 을 쓰고 서버는 «검증·제한·고지» 만 한다(서버 LLM 호출 0).
 * 플래그: MCP_SQL_TOOL=on(기본 off — 도구 목록·응답 바이트 동일) · MCP_SQL_TOOL_EXTERNAL=on(기본 off — external·미지정 tier 비노출).
 * 방어(겹겹): ① 토큰 검증기(SELECT/WITH 만·다중문·주석·달러인용·DML/DDL 키워드·함수 허용목록·관계 허용목록·pg_ 접두·information_schema 차단)
 *   ② 전용 DB 롤(SELECT 권한이 허용 뷰에만 — 제안 DDL: pkg/sql_tool_role.sql) ③ READ ONLY 트랜잭션+statement_timeout+search_path 고정
 *   ④ EXPLAIN 비용 상한(거대 조인 사전 차단) ⑤ 행 상한(LIMIT 래핑)·셀·응답 바이트 상한 ⑥ 동시·분당 한도.
 * 접속: SQL_TOOL_PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD(없으면 도구가 «설정되지 않음» 오류) · SQL_TOOL_SCHEMA(운영=rag_sql, 시험 사본=public).
 * 정책 계층(policy): 항상 coverage 고지 · 합계 질의의 sum_check 강제(SUM 이 있고 sum_check 언급이 없으면 거부) · 전기관 집계 scope 경고 · sum_check≠ok 행 경고 · 유사 기관명 LIKE 경고 · 0건 고지.
 */
const fs = require('fs'), path = require('path');

const bad = m => Object.assign(new Error(m), { code: 'BAD_REQUEST' });
const intEnv = (k, d, lo, hi) => { const n = parseInt(process.env[k], 10); return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : d)); };
const csv = s => String(s == null ? '' : s).split(',').map(x => x.trim()).filter(Boolean);

// ── 허용 객체(뷰 이름은 스키마 SQL_TOOL_SCHEMA 안의 단순 이름) ──
const DEFAULT_INTERNAL = 'institutions,item_codes,b2_bizcost,b2_board,b2_contrib,b2_donation,b2_lawsuit,c2_audit_opinion,c2_board_meeting,c2_board_agenda,c2_eval_score,c2_finding_item,doc_fields';
const DEFAULT_EXTERNAL = 'institutions,item_codes,b2_bizcost,b2_contrib,b2_donation,b2_lawsuit,c2_audit_opinion,c2_eval_score,doc_fields';   // 자유 서술 열이 있는 이사회·지적 표는 external 제외
const SUMCHECK_TABLES = ['b2_bizcost', 'b2_donation', 'b2_contrib'];   // 합계행 검증 열(sum_check)이 있는 표
// c14 후보: SQL_TOOL_VIEWS_EXPAND=on(기본 off) 이면 경영평가 종합등급 뷰 3개(internal·external)와 계약 공개 뷰 2개(internal 만 — external 에 열려면 SQL_TOOL_TABLES_EXTERNAL 로 명시)를 허용 목록에 더한다. off 면 허용 목록·가이드·도구 목록이 c13 과 동일.
const EXPAND_ALL = 'c2_eval_overall,c2_eval_overall_correction,c2_eval_overall_conflict', EXPAND_INTERNAL = 'contract_public,contract_small_agg';
const CONTRACT_TABLES = ['contract_public'];   // 금액 열 amount_won 의 합·평균은 amount_flag 조건 필요(SQL_TOOL_CONTRACT_SUM=off|warn|reject, 기본 off)
function cfg() {
  const e = process.env;
  return { schema: e.SQL_TOOL_SCHEMA || 'rag_sql', maxRows: intEnv('SQL_TOOL_MAX_ROWS', 200, 1, 1000), timeoutMs: intEnv('SQL_TOOL_TIMEOUT_MS', 5000, 500, 30000),
    maxCost: +e.SQL_TOOL_MAX_COST || 3e6, perMin: intEnv('SQL_TOOL_PER_MIN', 30, 1, 10000), conc: intEnv('SQL_TOOL_CONC', 2, 1, 8), maxBytes: intEnv('SQL_TOOL_MAX_BYTES', 60000, 5000, 500000),
    tables: { internal: new Set(csv(e.SQL_TOOL_TABLES_INTERNAL || DEFAULT_INTERNAL + (e.SQL_TOOL_VIEWS_EXPAND === 'on' ? ',' + EXPAND_ALL + ',' + EXPAND_INTERNAL : ''))), external: new Set(csv(e.SQL_TOOL_TABLES_EXTERNAL || DEFAULT_EXTERNAL + (e.SQL_TOOL_VIEWS_EXPAND === 'on' ? ',' + EXPAND_ALL : ''))) },
    externalOn: e.MCP_SQL_TOOL_EXTERNAL === 'on' };
}
const tierKey = tier => (tier === 'internal' || tier === 'master') ? 'internal' : 'external';
const open = tier => process.env.MCP_SQL_TOOL === 'on' && (tierKey(tier) === 'internal' || cfg().externalOn);

// ── 토큰화 ──
const KW_BANNED = new Set(['insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke', 'copy', 'set', 'reset', 'do', 'call', 'execute', 'prepare', 'deallocate', 'lock', 'vacuum', 'analyze', 'analyse',
  'cluster', 'refresh', 'listen', 'notify', 'unlisten', 'load', 'discard', 'comment', 'security', 'explain', 'into', 'returning', 'begin', 'commit', 'rollback', 'savepoint', 'start', 'declare', 'fetch', 'move', 'close', 'import', 'reindex', 'checkpoint', 'merge', 'show', 'abort', 'end']);
const NON_FUNC = new Set(['in', 'as', 'from', 'join', 'on', 'and', 'or', 'not', 'where', 'select', 'over', 'values', 'using', 'exists', 'any', 'all', 'some', 'when', 'then', 'else', 'by', 'having', 'union', 'intersect', 'except', 'lateral', 'case', 'between', 'is', 'like', 'ilike', 'similar', 'filter', 'within', 'group', 'order', 'limit', 'offset', 'distinct', 'with', 'materialized', 'recursive', 'interval', 'array', 'row']);
const FUNCS = new Set(['count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'lower', 'upper', 'initcap', 'substr', 'substring', 'left', 'right', 'length', 'char_length', 'round', 'floor', 'ceil', 'ceiling', 'abs', 'trunc',
  'to_char', 'to_date', 'to_number', 'date_trunc', 'extract', 'date_part', 'age', 'row_number', 'rank', 'dense_rank', 'ntile', 'lag', 'lead', 'first_value', 'last_value', 'percentile_cont', 'percentile_disc',
  'string_agg', 'array_agg', 'greatest', 'least', 'concat', 'concat_ws', 'replace', 'btrim', 'ltrim', 'rtrim', 'trim', 'position', 'cast', 'numeric', 'decimal', 'varchar', 'char', 'bool_and', 'bool_or', 'stddev', 'variance', 'now', 'make_date', 'mod', 'sign']);
const CAST_TYPES = new Set(['text', 'int', 'integer', 'int4', 'int8', 'bigint', 'smallint', 'numeric', 'decimal', 'float', 'float4', 'float8', 'real', 'double', 'precision', 'date', 'timestamp', 'timestamptz', 'boolean', 'bool', 'varchar', 'char', 'interval']);
const SPECIAL_FROM = new Set(['extract', 'substring', 'trim', 'position', 'overlay', 'date_part']);   // 이 함수 괄호 안의 FROM 은 관계 지정이 아니다
const FROM_END = new Set(['where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'intersect', 'except', 'window', 'select', 'on', 'using', 'fetch', 'for']);
const JOIN_NOISE = new Set(['natural', 'left', 'right', 'inner', 'cross', 'full', 'outer', 'lateral', 'only']);

function tokenize(sql) {
  const t = []; let i = 0; const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') throw bad('SQL 주석(--)은 허용되지 않습니다.');
    if (c === '/' && sql[i + 1] === '*') throw bad('SQL 주석(/* */)은 허용되지 않습니다.');
    if (c === "'") {
      let j = i + 1, s = '';
      for (;;) { if (j >= n) throw bad('문자열 따옴표가 닫히지 않았습니다.'); if (sql[j] === "'") { if (sql[j + 1] === "'") { s += "'"; j += 2; continue; } break; } if (sql[j] === '\\' ) throw bad('문자열 안 역슬래시는 허용되지 않습니다.'); s += sql[j++]; }
      const prev = t[t.length - 1]; if (prev && prev.k === 'w' && /^(e|u&|b|x|n)$/i.test(prev.v) && prev.end === i) throw bad('E/U&/B/X 접두 문자열은 허용되지 않습니다.');
      t.push({ k: 's', v: s, i }); i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, s = '';
      for (;;) { if (j >= n) throw bad('식별자 따옴표가 닫히지 않았습니다.'); if (sql[j] === '"') { if (sql[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += sql[j++]; }
      if (!s) throw bad('빈 식별자는 허용되지 않습니다.'); t.push({ k: 'q', v: s, i }); i = j + 1; continue;
    }
    if (c === '$') { const m = /^\$(\d{1,2})(?![\w$])/.exec(sql.slice(i)); if (!m) throw bad('달러 인용($$)·$ 기호는 허용되지 않습니다(값 바인딩은 $1 형식).'); t.push({ k: 'p', v: +m[1], i }); i += m[0].length; continue; }
    if (c === ';') { t.push({ k: 'o', v: ';', i }); i++; continue; }
    if (c === '\\' || c === '\u0000') throw bad('허용되지 않는 문자입니다.');
    const num = /^(\d+(\.\d+)?([eE][+-]?\d+)?|\.\d+)/.exec(sql.slice(i));
    if (num) { t.push({ k: 'n', v: num[0], i }); i += num[0].length; continue; }
    const w = /^[A-Za-z_À-￿][\wÀ-￿$]*/.exec(sql.slice(i));
    if (w) { t.push({ k: 'w', v: w[0], l: w[0].toLowerCase(), i, end: i + w[0].length }); i += w[0].length; continue; }
    t.push({ k: 'o', v: c, i }); i++;
  }
  return t;
}

/**
 * 검증. 통과하면 {sql(끝 세미콜론 제거), maxParam, feats}, 아니면 BAD_REQUEST. allowed: Set(허용 표 이름), schema: 허용 스키마.
 */
function validate(sqlIn, allowed, schema) {
  if (typeof sqlIn !== 'string' || !sqlIn.trim()) throw bad('sql 이 비어 있습니다.');
  if (sqlIn.length > 6000) throw bad('SQL 이 너무 깁니다(6,000자 이하).');
  const tk = tokenize(sqlIn);
  const semi = tk.map((x, i) => (x.k === 'o' && x.v === ';') ? i : -1).filter(i => i >= 0);
  if (semi.length > 1 || (semi.length === 1 && semi[0] !== tk.length - 1)) throw bad('여러 문장(;)은 허용되지 않습니다 — SELECT 한 문장만 보내세요.');
  if (semi.length === 1) tk.pop();
  if (!tk.length) throw bad('sql 이 비어 있습니다.');
  const first = tk[0];
  if (!(first.k === 'w' && (first.l === 'select' || first.l === 'with'))) throw bad('SELECT 또는 WITH 로 시작하는 읽기 전용 질의만 허용됩니다.');
  // 1차: CTE 이름(본문이 닫힌 뒤부터 유효)
  const pairs = {}, st = []; tk.forEach((x, i) => { if (x.k === 'o' && x.v === '(') st.push(i); else if (x.k === 'o' && x.v === ')') { const o = st.pop(); if (o === undefined) throw bad('괄호가 맞지 않습니다.'); pairs[o] = i; } });
  if (st.length) throw bad('괄호가 맞지 않습니다.');
  const cte = new Map();   // name → closeIdx
  tk.forEach((x, i) => { if (x.k === 'w' && x.l === 'as') { let j = i + 1; while (tk[j] && tk[j].k === 'w' && ['not', 'materialized'].includes(tk[j].l)) j++; const nm = tk[i - 1];
    if (tk[j] && tk[j].v === '(' && nm && (nm.k === 'w' || nm.k === 'q') && !NON_FUNC.has(nm.l) && tk[i - 2] && ((tk[i - 2].k === 'w' && ['with', 'recursive'].includes(tk[i - 2].l)) || tk[i - 2].v === ',')) cte.set((nm.l || nm.v.toLowerCase()), pairs[j]); } });
  if (tk.some(x => x.k === 'w' && x.l === 'recursive')) throw bad('WITH RECURSIVE 는 허용되지 않습니다.');
  const feats = { tables: new Set(), agg: false, sum: false, sumcheck: false, instFilter: false, likeInst: false, hasWhere: false, params: 0, groupBy: false, instNameLits: [] };
  const fstack = [];   // 괄호별 {fn, inFrom, expect}
  let top = { fn: null, inFrom: false, expect: false };
  const relOK = (nameTok, idx) => {
    const nm = (nameTok.l || nameTok.v.toLowerCase());
    if (/^pg_|^information_schema$|^sql_/.test(nm)) throw bad('시스템 카탈로그 접근은 허용되지 않습니다.');
    if (cte.has(nm) && cte.get(nm) < idx) return;
    if (!allowed.has(nm)) throw bad(`허용되지 않은 표입니다: ${nm.slice(0, 40)} — 사용 가능: ${[...allowed].join(', ')}`);
    feats.tables.add(nm);
  };
  for (let i = 0; i < tk.length; i++) {
    const x = tk[i], nx = tk[i + 1], pv = tk[i - 1];
    if (x.k === 'p') { feats.params = Math.max(feats.params, x.v); continue; }
    if (x.k === 'o') {
      if (x.v === '(') { const fnTok = pv && (pv.k === 'w') && !NON_FUNC.has(pv.l) ? pv : null;
        if (fnTok && !FUNCS.has(fnTok.l) && !(tk[i - 2] && ((tk[i - 2].k === 'w' && tk[i - 2].l === 'as') || tk[i - 2].v === ')'))) throw bad(`허용되지 않은 함수입니다: ${fnTok.v.slice(0, 30)} — 집계·문자열·날짜 기본 함수만 가능합니다.`);
        if (fnTok && FUNCS.has(fnTok.l) && !(tk[i - 2] && tk[i - 2].l === 'as')) { if (['count', 'sum', 'avg', 'min', 'max', 'string_agg', 'array_agg', 'bool_and', 'bool_or', 'stddev', 'variance', 'percentile_cont', 'percentile_disc'].includes(fnTok.l)) { feats.agg = true; if (fnTok.l === 'sum') feats.sum = true; if (fnTok.l === 'avg') feats.avg = true; } }
        if (top.inFrom && top.expect) top.expect = false;
        fstack.push(top); top = { fn: fnTok ? fnTok.l : null, inFrom: false, expect: false };
        if (nx && nx.k === 'w' && nx.l === 'select' || (nx && nx.k === 'w' && nx.l === 'with')) top.fn = null;
      } else if (x.v === ')') { top = fstack.pop() || top; if (top.inFrom && top.afterRel) { /* 서브쿼리 뒤 별칭 */ } }
      else if (x.v === ',' && top.inFrom && !top.expectBlock) { top.expect = true; }
      else if (x.v === ':' && nx && nx.v === ':') { const ty = tk[i + 2]; if (!ty || ty.k !== 'w' || !CAST_TYPES.has(ty.l)) throw bad('허용되지 않은 형 변환입니다(text·int·numeric·date 등만).'); }
      else if (x.v === '.' ) { /* a.b */ }
      continue;
    }
    if (x.k === 'w' || x.k === 'q') {
      const l = x.l || x.v.toLowerCase();
      if (x.k === 'w' && KW_BANNED.has(l)) throw bad(`허용되지 않은 키워드입니다: ${x.v.toUpperCase()} — 읽기 전용 SELECT 만 가능합니다.`);
      if (/^(source_file|raw|raw_text|raw_json|passwd|password)$/.test(l)) throw bad('개인정보 처리 전 원천 열은 제공되지 않습니다.');
      if (/^pg_|^information_schema$|^sql_|^current_setting$|^set_config$|^dblink|^lo_/.test(l)) throw bad('시스템 카탈로그·시스템 함수 접근은 허용되지 않습니다.');
      if (x.k === 'w' && l === 'for' && nx && nx.k === 'w' && ['update', 'share', 'no', 'key'].includes(nx.l)) throw bad('FOR UPDATE/SHARE 는 허용되지 않습니다.');
      if (x.k === 'w' && (l === 'from' || l === 'join') && !(top.fn && SPECIAL_FROM.has(top.fn) && l === 'from')) { top.inFrom = true; top.expect = true; continue; }
      if (x.k === 'w' && FROM_END.has(l)) { if (l === 'where') feats.hasWhere = true; top.inFrom = false; top.expect = false; if (l === 'group') feats.groupBy = true; }
      if (x.k === 'w' && JOIN_NOISE.has(l)) continue;
      if (top.inFrom && top.expect) {   // 관계 이름 자리
        if (x.k === 'o') continue;
        top.expect = false;
        if (nx && nx.v === '(') throw bad('FROM 절 함수(표 반환 함수)는 허용되지 않습니다.');
        if (nx && nx.v === '.') {   // schema.table
          const tb = tk[i + 2]; if (!tb || (tb.k !== 'w' && tb.k !== 'q')) throw bad('표 이름이 올바르지 않습니다.');
          if (l !== schema.toLowerCase()) throw bad('허용되지 않은 스키마입니다.');
          relOK(tb, i); i += 2; continue;
        }
        relOK(x, i); continue;
      }
      // 기능 표지
      if (x.k === 'w' || x.k === 'q') {
        if (l === 'sum_check') feats.sumcheck = true;
        if (l === 'amount_flag') feats.amountFlag = true;
        if (l === 'inst_code' || l === 'inst_name' || l === 'ministry') { if (nx && (['=', 'i'].includes(nx.v) || (nx.k === 'w' && ['in', 'like', 'ilike'].includes(nx.l)) || (nx.v === '<' || nx.v === '>' || nx.v === '!'))) feats.instFilter = true; }
        if ((l === 'inst_name') && nx && nx.k === 'w' && ['like', 'ilike'].includes(nx.l)) feats.likeInst = true;
        if ((l === 'inst_name') && nx && nx.v === '=' && tk[i + 2] && tk[i + 2].k === 's') feats.instNameLits.push(tk[i + 2].v);
        if ((l === 'inst_name') && nx && nx.k === 'w' && nx.l === 'in') { for (let j = i + 2; j < tk.length && tk[j].v !== ')'; j++) if (tk[j].k === 's') feats.instNameLits.push(tk[j].v); }
        if ((l === 'inst_code') && nx && nx.v === '=' ) feats.instFilter = true;
      }
    }
  }
  feats.boardCount = boardCount(tk, feats.tables);
  return { sql: sqlIn.trim().replace(/;\s*$/, ''), feats };
}

// ── 이사회 개최 횟수 집계 탐지(c13 후보, SQL_TOOL_BOARD_COUNT=off|warn|reject — 기본 off) ──
// 이사회 표는 문서 단위 부분 적재라 회의 수를 세면 실제 개최 횟수가 아니다. «안건 수·안건 유형·결과별 건수» 는 허용한다.
// ponytail: 토큰 휴리스틱(SQL 의미 분석 아님) — 서브쿼리 우회·window 로 회의 수를 세는 변형은 못 잡음. 정확 차단이 아니라 «흔한 패턴» 의 안전망.
const MEET_KEYS = new Set(['meeting_no', 'meeting_date', 'doc_id']);
const BOARD_ONLY = new Set(['c2_board_meeting', 'institutions', 'item_codes']);
function boardCount(tk, tables) {
  const hasM = tables.has('c2_board_meeting'), hasB = tables.has('b2_board'); if (!hasM && !hasB) return false;
  const W = (x, l) => x && x.k === 'w' && x.l === l;
  const clauseIdents = (from) => {   // from 위치의 GROUP BY/ORDER BY 절 식별자(같은 깊이, 다음 절 키워드·닫는 괄호 전까지)
    const ids = []; let d = 0; for (let j = from; j < tk.length; j++) { const y = tk[j]; if (y.v === '(') d++; else if (y.v === ')') { if (d === 0) break; d--; } else if (d === 0 && y.k === 'w' && ['having', 'order', 'limit', 'offset', 'union', 'intersect', 'except', 'window', 'group'].includes(y.l) && j > from) break; if (y.k === 'w') ids.push(y.l); } return ids; };
  let perMeeting = false;   // GROUP BY meeting_* 면 count(*) 는 회의 안의 행(안건) 수 — 회의 수가 아님
  tk.forEach((x, i) => { if (W(x, 'group') && W(tk[i + 1], 'by') && clauseIdents(i + 2).some(k => MEET_KEYS.has(k))) perMeeting = true; });
  let anyCount = false, distinctMeet = false;
  for (let i = 0; i < tk.length; i++) {
    const x = tk[i];
    if (W(x, 'max') && tk[i + 1] && tk[i + 1].v === '(') { let d = 1, hit = false; for (let j = i + 2; j < tk.length && d; j++) { if (tk[j].v === '(') d++; else if (tk[j].v === ')') d--; else if (tk[j].k === 'w' && tk[j].l === 'meeting_no') hit = true; } if (hit) return true; }   // max(meeting_no)
    if (W(x, 'count') && tk[i + 1] && tk[i + 1].v === '(') {
      anyCount = true; const arg = []; let d = 1; for (let j = i + 2; j < tk.length && d; j++) { if (tk[j].v === '(') d++; else if (tk[j].v === ')') { d--; if (!d) break; } arg.push(tk[j]); }
      if (W(arg[0], 'distinct') && arg.some(y => y.k === 'w' && MEET_KEYS.has(y.l))) return true;   // count(distinct meeting_no|meeting_date|doc_id)
      if (hasM && !perMeeting && [...tables].every(t => BOARD_ONLY.has(t))) return true;   // 회의 표만 count(...) — 행 = 회의
    }
    if (W(x, 'distinct') && !(tk[i - 1] && tk[i - 1].v === '(') && tk.slice(i + 1, i + 5).some(y => y.k === 'w' && MEET_KEYS.has(y.l))) distinctMeet = true;   // SELECT DISTINCT meeting_date … 를 바깥에서 count
  }
  if (anyCount && distinctMeet) return true;
  if (hasM) { const o = tk.findIndex((x, i) => W(x, 'order') && W(tk[i + 1], 'by')); if (o >= 0) { const ids = clauseIdents(o + 2), k = tk.findIndex((x, i) => i > o && W(x, 'limit')); if (ids.includes('meeting_no') && ids.includes('desc') && k >= 0 && tk[k + 1] && tk[k + 1].v === '1') return true; } }   // ORDER BY meeting_no DESC LIMIT 1 = 최대 회차
  return false;
}
const CONTRACT_SUM_MSG = '거절: 계약 금액(amount_won)의 합계·평균은 amount_flag 조건을 함께 쓰세요(예: WHERE amount_flag IS NULL). 단위 의심·이상치·금액 없음 행은 amount_flag 에 사유가 있어 합계에서 빼야 합니다. 그래도 «기관 총액» 은 아닙니다(500만원 이하 소액 합산은 contract_small_agg 별도, 적재 범위 한정).';
const BOARD_MSG = '이사회 개최 횟수(회의 수) 집계로 보입니다 — 이사회 표(b2_board·c2_board_meeting)는 문서 단위 부분 적재라 meeting_no 최대·회의 수 count 는 실제 개최 횟수가 아닙니다. 안건 수·안건 유형·결과별 건수 집계는 가능하지만 «개최 횟수» 는 «확인할 수 없음» 으로 답하세요.';

// ── 연결·한도 ──
let POOL = null, poolKey = '';
function pool() {
  const e = process.env; if (!e.SQL_TOOL_PGHOST || !e.SQL_TOOL_PGUSER) throw new Error('SQL 도구가 설정되지 않았습니다(관리자 설정 필요).');
  const key = [e.SQL_TOOL_PGHOST, e.SQL_TOOL_PGPORT, e.SQL_TOOL_PGDATABASE, e.SQL_TOOL_PGUSER].join('|');
  if (POOL && key === poolKey) return POOL;
  const { Pool } = require('pg');
  POOL = new Pool({ host: e.SQL_TOOL_PGHOST, port: +e.SQL_TOOL_PGPORT || 5432, database: e.SQL_TOOL_PGDATABASE, user: e.SQL_TOOL_PGUSER, password: e.SQL_TOOL_PGPASSWORD, max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
    application_name: 'mcp_query_sql' });
  POOL.on('error', er => process.stderr.write('[sql_tool pool] ' + er.message + '\n')); poolKey = key; return POOL;
}
let running = 0; const hits = [];
function admit(c) {
  const now = Date.now(); while (hits.length && now - hits[0] > 60000) hits.shift();
  if (hits.length >= c.perMin) throw Object.assign(new Error(`query_sql 호출 한도(분당 ${c.perMin}회)를 넘었습니다. 잠시 후 다시 시도하세요.`), { code: 'BUSY' });
  if (running >= c.conc) throw Object.assign(new Error('query_sql 동시 실행 한도를 넘었습니다. 잠시 후 다시 시도하세요.'), { code: 'BUSY' });
  hits.push(now);
}

const COVERAGE = '적재·공개된 표본 기준입니다(전수 아님 가능). 0건≠자료 없음. 결과에 없는 값은 추정·보간하지 말고 «확인할 수 없음» 으로 답하세요.';
const p2 = n => String(n).padStart(2, '0');   // c12 후보: DATE 는 로컬 자정의 Date 로 파싱되므로 toISOString(UTC)이 KST 에서 하루 앞당겨진다 → 로컬 날짜 성분 사용
const cell = v => v instanceof Date ? `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}` : (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v);

async function querySql(a, cctx, aliasLookup) {
  const c = cfg(), tier = cctx && cctx.tier, allowed = c.tables[tierKey(tier)];
  const v = validate(a && a.sql, allowed, c.schema);
  const params = Array.isArray(a.params) ? a.params : (a.params == null ? [] : (() => { throw bad('params 는 배열이어야 합니다.'); })());
  if (params.length > 10) throw bad('params 는 10개 이하입니다.');
  for (const p of params) if (!(p === null || ['string', 'number', 'boolean'].includes(typeof p)) || (typeof p === 'string' && p.length > 300)) throw bad('params 값은 문자열·숫자·불리언·null 만 가능합니다.');
  if (v.feats.params !== params.length) throw bad(`바인딩 개수 불일치: SQL 의 최대 $N=${v.feats.params}, params ${params.length}개.`);
  const f = v.feats, warnings = [];
  if (f.sum && [...f.tables].some(t => SUMCHECK_TABLES.includes(t)) && !f.sumcheck) throw bad('거부: 업무추진비·기부·출연 금액의 합계(SUM)는 합계행 검증 열 sum_check 를 함께 쓰세요(예: WHERE sum_check=\'ok\' 로 검증 통과 문서만, 또는 sum_check 를 SELECT/GROUP BY 에 포함해 상태를 확인). sum_check≠ok 합계는 총액으로 쓸 수 없습니다.');
  // c14 후보: 계약 금액(amount_won) 합계·평균은 amount_flag(NULL=신뢰 가능) 조건 필수. 서버는 «언급 여부» 만 본다(sum_check 규칙과 같은 수준) — 올바른 조건(IS NULL)인지는 못 막는다.
  const ctMode = process.env.SQL_TOOL_CONTRACT_SUM, ctUse = [...f.tables].some(t => CONTRACT_TABLES.includes(t));
  if (ctMode && ctMode !== 'off' && ctUse && (f.sum || f.avg) && !f.amountFlag) {
    if (ctMode === 'reject') throw bad(CONTRACT_SUM_MSG);
    warnings.push('경고: ' + CONTRACT_SUM_MSG);
  }
  const bcMode = process.env.SQL_TOOL_BOARD_COUNT;   // c13 후보: off(기본)|warn|reject
  if (f.boardCount && bcMode === 'reject') throw bad('거부: ' + BOARD_MSG);
  if (f.boardCount && bcMode === 'warn') warnings.push('경고: ' + BOARD_MSG);
  admit(c); running++;
  const t0 = Date.now(); let cl;
  try {
    cl = await pool().connect();
    await cl.query('BEGIN READ ONLY');
    await cl.query(`SET LOCAL statement_timeout = ${c.timeoutMs}`); await cl.query('SET LOCAL lock_timeout = 1000'); await cl.query('SET LOCAL work_mem = \'16MB\'');
    await cl.query(`SELECT set_config('search_path', $1, true)`, [c.schema.replace(/[^\w]/g, '')]);
    const wrapped = `SELECT * FROM (${v.sql}\n) AS _q LIMIT ${c.maxRows + 1}`;
    let plan; try { plan = (await cl.query({ text: 'EXPLAIN (FORMAT JSON) ' + wrapped, values: params })).rows[0]['QUERY PLAN'][0].Plan; } catch (e) { throw e; }
    if (plan['Total Cost'] > c.maxCost) throw bad(`거부: 질의 비용 추정이 너무 큽니다(${Math.round(plan['Total Cost']).toLocaleString('en-US')} > ${c.maxCost.toLocaleString('en-US')}). 조인 조건·기간·기관 필터를 추가하세요.`);
    const r = await cl.query({ text: wrapped, values: params, rowMode: 'array' });
    await cl.query('ROLLBACK');
    const names = []; for (const f of r.fields) { let nm = f.name || '?column?', k = 2; while (names.includes(nm)) nm = f.name + '_' + k++; names.push(nm); }   // 같은 이름 열은 _2·_3 으로 구분(값 덮어쓰기 방지)
    let rows = r.rows.map(a => Object.fromEntries(names.map((k, i) => [k, cell(a[i])])));
    if ((process.env.MASK_PII || '') !== '0') {   // 마스킹(mcp_server 의 maskOut 은 고정 필드명만 처리하므로 결과 셀 전체를 여기서 가린다): 등급별 옵션·MASK_PII_V2 는 mask_pii.maskOptsForTier 그대로. 순수 숫자열(금액)은 주민번호 오탐을 피하려고 건너뜀
      const MP = require('./mask_pii.js'), mo = MP.maskOptsForTier(tier); let mc = 0;
      rows = rows.map(row => { const o = {}; for (const k of Object.keys(row)) { const v = row[k]; if (typeof v === 'string' && !/^-?\d+(\.\d+)?$/.test(v)) { const m = MP.maskText(v, mo); o[k] = m.text; if (m.text !== v) mc++; } else o[k] = v; } return o; });
      if (mc) warnings.push(`개인정보 패턴(휴대폰·주민번호·이메일) ${mc}개 셀을 가렸습니다.`);
    }
    const truncated = rows.length > c.maxRows; if (truncated) rows = rows.slice(0, c.maxRows);
    let bytes = Buffer.byteLength(JSON.stringify(rows)), cut = false; while (bytes > c.maxBytes && rows.length > 1) { rows = rows.slice(0, Math.ceil(rows.length / 2)); bytes = Buffer.byteLength(JSON.stringify(rows)); cut = true; }
    const cols = names;
    // ── 정책 계층 ──
    if (cols.includes('sum_check')) { const n = rows.filter(x => x.sum_check !== 'ok').length; if (n) warnings.push(`결과 ${n}행의 sum_check≠ok(검증 불일치·단위 보정·합계행 없음) — 해당 행의 금액은 총액으로 쓰지 말고 «총액 확정 불가» 로 고지하세요.`); }
    if (f.sum && f.sumcheck) warnings.push('sum_check 조건을 쓴 합계는 «검증 통과 문서» 만의 합계입니다 — 통과하지 못한 기관·연도는 빠져 있어 전체 합계가 아닙니다.');
    if (f.agg && !f.instFilter) warnings.push('기관 조건이 없는 집계입니다: 적재·검증 통과 기관만의 값이며 «모든 공공기관 전체» 합계·건수가 아닙니다. 답에는 «적재 범위 기준» 임을 쓰고, 전체·확정으로 단정하지 마세요(전수 불가 질문은 «전수 확인 불가» 로 답).');
    if (ctMode && ctMode !== 'off' && ctUse && f.agg) {   // c14 후보: 계약 집계 고지(적재 범위·전수 아님·합계 신뢰 조건)
      warnings.push('계약 표(contract_public)는 수의계약(70301) 공시 중 적재된 행 기준입니다 — 경쟁입찰·전체 계약이 아니며 사택·주거 임대차·합계행·500만원 이하 소액 합산(contract_small_agg 별도)은 빠져 있고, 행 수는 계약 건수와 같지 않습니다(중복 제출 약 1% 잔존). 금액 합계·순위는 원문 대조에서 일부 문서가 ±2% 밖이므로 «참고용(전수·확정 아님)» 으로 고지하고, 업체명(counterparty)은 규칙 정규화라 다른 업체가 합쳐지거나 같은 업체가 갈라질 수 있습니다.');
      if (f.sum && f.amountFlag) warnings.push('amount_flag 조건을 쓴 합계는 금액이 확인된 행만의 합계입니다 — 제외된 행(단위 의심·금액 없음 등)이 있어 실제 총액보다 작을 수 있습니다.');
    }
    if (f.likeInst) warnings.push('기관명 LIKE 검색은 유사 명칭(예: 한국도로공사·한국도로교통공단)을 섞을 수 있습니다 — 정확 일치(inst_name=\'…\')를 쓰고 반환된 기관명을 확인하세요.');
    if (truncated || cut) warnings.push(`행이 잘렸습니다(최대 ${c.maxRows}행${cut ? '·응답 크기 상한' : ''}) — 집계·필터로 줄이세요. 잘린 결과로 «전체» 를 단정하지 마세요.`);
    const out = { columns: cols, rows, row_count: rows.length, truncated: truncated || cut, ms: Date.now() - t0, policy: { coverage: COVERAGE, ...(warnings.length ? { warnings } : {}) } };
    if (!rows.length) {
      out.policy.zero_hint = '0건입니다: 해당 기관·연도·항목이 적재되지 않았거나 조건이 맞지 않을 수 있습니다 — 값을 지어내지 말고 «확인할 수 없음» 으로 답하거나 기관명(정식명)·연도 조건을 다시 확인하세요.';
      if (aliasLookup && f.instNameLits.length) { const hint = f.instNameLits.map(s => { try { const r2 = aliasLookup(s); return r2 && r2 !== s ? { input: s, alias_of: r2 } : null; } catch { return null; } }).filter(Boolean); if (hint.length) out.policy.inst_alias_hint = hint; }
    }
    return out;
  } catch (e) {
    if (cl) { try { await cl.query('ROLLBACK'); } catch { /* ignore */ } }
    if (e.code === 'BAD_REQUEST' || e.code === 'BUSY') throw e;
    const code = String(e.code || '');
    if (code === '57014') throw bad(`거부: 실행 시간 ${c.timeoutMs / 1000}초 초과 — 필터·기간·기관 조건을 추가하세요.`);
    if (['42601', '42703', '42883', '42804', '42725', '42702', '42803', '42P10', '42846'].includes(code) || /^22/.test(code)) throw bad('SQL 오류: ' + String(e.message).replace(/\s+/g, ' ').slice(0, 200) + (e.position ? ` (위치 ${e.position})` : '') + ' — SQL 을 고쳐 다시 시도하세요.');
    if (code === '42P01' || code === '42501') throw bad(`허용되지 않은 객체입니다 — 사용 가능한 표: ${[...allowed].join(', ')}`);
    process.stderr.write('[sql_tool] ' + code + ' ' + String(e.message).slice(0, 200) + '\n');
    throw new Error('조회 실패(잠시 후 다시 시도)');
  } finally { running--; if (cl) cl.release(); }
}

// ── 가이드(생성기 산출물 data/sql_guide.json) ──
let G = null, gm = -1, gchk = 0;
function loadGuide() {
  const now = Date.now(); if (G && now - gchk < 30000) return G; gchk = now;
  const cands = [process.env.SQL_TOOL_GUIDE, path.join(__dirname, 'data', 'sql_guide.json'), path.join(__dirname, 'sql_guide.default.json')].filter(Boolean);
  for (const f of cands) { try { const m = fs.statSync(f).mtimeMs; if (G && gm === f + m) return G; G = JSON.parse(fs.readFileSync(f, 'utf8')); gm = f + m; return G; } catch { /* 다음 후보 */ } }
  return G;
}
function sqlGuide(a, cctx) {
  const g = loadGuide(); if (!g) throw new Error('SQL 가이드가 준비되지 않았습니다.');
  const c = cfg(), allowed = c.tables[tierKey(cctx && cctx.tier)], q = a && a.q ? String(a.q).toLowerCase() : '';
  let secs = g.tables.filter(t => allowed.has(t.name));
  if (q) { const m = secs.filter(t => t.name.includes(q)), m2 = secs.filter(t => (t.md || '').toLowerCase().includes(q)); if (m.length || m2.length) secs = m.length ? m : m2; }
  const md = [g.header_md, ...secs.map(t => t.md), ...(q ? [] : [g.footer_md || ''])].filter(Boolean).join('\n\n');
  return { kind: 'sql_guide', version: g.version, generated_at: g.generated_at, tool: 'query_sql', tables: secs.map(t => t.name), guide_md: md };
}

function toolDef() {
  return { name: 'query_sql', description: '공시 표 읽기 전용 SQL(SELECT만·200행). 먼저 list_catalog(kind=sql_guide)로 표·열·규칙 확인. 적재 표본 기준(전수·합계 단정 금지).',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' }, params: { type: 'array', items: {}, description: '$1.. 바인딩' } }, required: ['sql'] } };
}
module.exports = { querySql, sqlGuide, toolDef, validate, tokenize, cfg, open, COVERAGE, CATALOG_KIND: 'sql_guide', tierKey, _internal: { hits, get running() { return running; } } };
