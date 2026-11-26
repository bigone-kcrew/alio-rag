'use strict';
/**
 * 질의 로그 (2026-10-22) — QUERY_LOG=1 일 때만 동작. 정책: docs/plans/2026-10-22_query_logging_policy.md
 * 목적: 독립 평가 집합 · 0건/실패 패턴 · 지연 분포. 모델 학습·외부 전송·개별 사용자 추적에 쓰지 않는다.
 * 기록: 분 단위 시각, 도구, 등급, 클라이언트 라벨(client — 키 «이름», 정책 docs/plans/2026-10-22_query_label_usage_policy.md), 코퍼스, 모드, 마스킹된 질의(≤200자), 필터 값, 건수, 상위 3 doc_id, 지연, 경고.
 * 미기록: IP·키 값·키 해시·토큰·User-Agent·헤더·응답 본문·제목·실명(라벨 ↔ 사람 매핑은 로그와 분리 보관). (호출부가 헤더/요청 객체를 넘기지 않는다 + 필드 화이트리스트)
 * 한계: 질의 속 «이름» 은 탐지할 수 없다.
 * 쓰기: 응답 뒤 setImmediate → 메모리 큐 → 배치 appendFile(fsync 없음). 실패·상한·큐 초과는 삼키고 stderr 경고 1줄.
 */
const fs = require('fs'), path = require('path');
const { maskQueryForLog } = require('./mask_pii.js');

const KST = 9 * 3600e3;
const kstIso = (ms = Date.now()) => new Date(ms + KST).toISOString();   // UTC 필드 = KST 벽시계

// 질의 마스킹: maskQueryForLog(이메일 전부·7자리↑ 숫자열) 앞에 «전화·주민·사업자번호» 를 통째로 가린다(마지막 4자리도 남기지 않음). 마스킹 «뒤에» 자른다(숫자열 중간 절단 방지).
// 2026-10-23: 키·긴 16진 해시 패턴을 «먼저» 적용한다. 숫자 12자 이상이 이어진 키는 주민·전화 패턴이 먼저 가운데를 가려 키가 둘로 쪼개지고, 남은 앞 6자+뒤 32자가 로그에 그대로 남는 누출이 있었다(시험 12회 중 2회 재현).
const FULL = [/rag_ext_[0-9a-f]{4,}/gi, /\b[0-9a-f]{32,}\b/gi, /\d{6}[-\s]?[1-8]\d{6}/g, /0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g, /\d{3}-\d{2}-\d{5}/g, /rag_ext_[0-9a-f●]{8,}/gi, /\b[0-9a-f●]{40,}\b/gi];   // 10-22: 사용자가 질의에 붙여넣은 발급 키·긴 16진 해시도 가린다
function maskQ(q, max = 200) {
  let s = String(q == null ? '' : q).slice(0, 2000);
  for (const re of FULL) s = s.replace(re, m => '●'.repeat(m.length));
  return maskQueryForLog(s).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

// 라벨(10-22): 서빙이 이미 판정한 «별칭 문자열» 만 받는다(키 값·해시·접두는 이 모듈로 오지 않는다). 형식 밖이면 'invalid', 없으면 'unknown'.
const LABEL_RE = /^[a-z0-9._-]{1,32}$/;
// QueryStudy ⑥: client 라벨 → cls(prod|test|warm). 규칙은 설정(QLOG_CLS_FILE=JSON {warm:[정규식…],test:[…]} 또는 기본 내장). 라벨 없는 익명·unknown 은 prod. QLOG_CLS=off 면 cls 없이 v=1(종전).
const CLS_ON = process.env.QLOG_CLS !== 'off';
const CLS_DEFAULT = { warm: ['^warm', '^monitor', '^probe'], test: ['^test', '^querystudy', '^mcp(expose|fix|deep)', '^(rt|red)', '^g\\d', 'abuse', '^verify', '^bench', '^smoke'] };
const CLS_RULES = (() => { let r = CLS_DEFAULT; try { if (process.env.QLOG_CLS_FILE) r = { ...CLS_DEFAULT, ...JSON.parse(require('fs').readFileSync(process.env.QLOG_CLS_FILE, 'utf8')) }; } catch { /* 기본 규칙 */ } const c = l => (l || []).map(x => new RegExp(x, 'i')); return { warm: c(r.warm), test: c(r.test) }; })();
const clsOf = l => { const s = typeof l === 'string' ? l : ''; return CLS_RULES.warm.some(r => r.test(s)) ? 'warm' : CLS_RULES.test.some(r => r.test(s)) ? 'test' : 'prod'; };
const labelOf = l => (l === undefined || l === null ? 'unknown' : typeof l === 'string' && LABEL_RE.test(l) ? l : 'invalid');
const bool = v => v === true || v === '1' || v === 'true';
const str = (v, n = 40) => (typeof v === 'string' && v ? maskQ(v, n) : undefined);
// 필터: MCP(snake) · REST(camel) 양쪽 이름을 받아 화이트리스트 키로만 내보낸다.
function filters(a) {
  const f = {}, set = (k, v) => { if (v !== undefined && v !== null && v !== false && v !== '') f[k] = v; };
  set('inst', str(a.inst)); set('ministry', str(a.ministry)); set('type', str(a.type));
  set('usecase', Array.isArray(a.usecase) ? a.usecase.slice(0, 8).map(x => str(String(x), 20)).filter(Boolean).join(',') : str(a.usecase, 60));
  set('year', /^\d{4}$/.test(String(a.year || '')) ? String(a.year) : undefined);
  const asOf = a.as_of !== undefined ? a.as_of : a.asOf;
  set('as_of', /^\d{4}-?\d{2}-?\d{2}$/.test(String(asOf || '')) ? String(asOf) : undefined);
  set('section', ['본칙', '부칙', '별표'].includes(a.section) ? a.section : undefined);
  set('all_versions', bool(a.all_versions !== undefined ? a.all_versions : a.allVersions));
  set('body', bool(a.body)); set('distinct_inst', bool(a.distinct_inst) || bool(a.group));
  set('latest_only', bool(a.latest_only !== undefined ? a.latest_only : a.latestOnly));
  set('collapse_off', a.collapse_dup === false || a.collapse === false);
  set('more', bool(a.noRewrite));   // «더 있음» 페이지네이션 — 평가 후보 추출 시 중복 제거용
  const lim = parseInt(a.limit, 10); if (Number.isFinite(lim)) f.limit = Math.min(300, Math.max(1, lim));
  return f;
}
const modeOf = a => (bool(a.hybrid) ? 'hybrid' : bool(a.semantic) ? 'semantic' : 'keyword');
// ── SqlAudit(2026-11-25 후보 c12): query_sql 감사 기록. SQL_TOOL_AUDIT=on 일 때만(기본 off — off 면 기록 바이트 동일). 호출 시점에 env 를 읽는다.
// 기록: 정규화 SQL(리터럴·주석·인용 식별자·달러 인용 → 자리표시자)+해시·참조 뷰·params 개수·행 수·정책 경고 코드·거부 코드·소요 ms. 미기록: params 값·리터럴·결과 셀·키/IP(기존 규약).
const audit = () => process.env.SQL_TOOL_AUDIT === 'on';
const SQL_IN_MAX = 8000, SQL_OUT_MAX = 1000, IDENT_MAX = 40;
function normSql(sqlIn) {   // 선형 스캐너 — 정규식 백트래킹 없음. 닫히지 않은 따옴표·주석은 «끝까지» 버린다(내용 누출 방지).
  const s = String(sqlIn).slice(0, SQL_IN_MAX).replace(/[\u0000-\u001f\u007f]/g, ' '), n = s.length; let o = '', i = 0;
  const push = t => { o += (o && !/[ (]$/.test(o) && !/^[),;]/.test(t) ? ' ' : '') + t; };
  while (i < n) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && s[i + 1] === '-') { i = s.indexOf('\n', i); if (i < 0) break; continue; }              // 줄 주석(내용 버림)
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); if (e < 0) break; i = e + 2; continue; }   // 블록 주석
    if (c === "'" || ((c === 'E' || c === 'e' || c === 'N' || c === 'n' || c === 'B' || c === 'b' || c === 'X' || c === 'x') && s[i + 1] === "'") || ((c === 'U' || c === 'u') && s[i + 1] === '&' && s[i + 2] === "'")) {
      const esc = /[Ee]/.test(c); let j = s.indexOf("'", i) + 1;
      for (; j < n; j++) { if (esc && s[j] === '\\') { j++; continue; } if (s[j] === "'") { if (s[j + 1] === "'") { j++; continue; } break; } }
      push('?s'); i = j + 1; if (j >= n) break; continue;                                                    // 닫히지 않으면 j>=n → 나머지 전부 버림
    }
    if (c === '"') { let j = i + 1; for (; j < n; j++) { if (s[j] === '"') { if (s[j + 1] === '"') { j++; continue; } break; } } push('"?q"'); i = j + 1; if (j >= n) break; continue; }
    if (c === '$') {
      const d = /^\$(\d{1,2})(?![\w$])/.exec(s.slice(i, i + 4)); if (d) { push('$' + d[1]); i += d[0].length; continue; }   // 바인딩 $1 은 유지
      const t = /^\$[A-Za-z_]?[\w]{0,20}\$/.exec(s.slice(i, i + 24));                                         // $$…$$ / $tag$…$tag$
      if (t) { const e = s.indexOf(t[0], i + t[0].length); push('?s'); if (e < 0) break; i = e + t[0].length; continue; }
      i++; continue;
    }
    const num = /^(\d+(\.\d+)?([eE][+-]?\d+)?|\.\d+)(?![A-Za-z_À-￿\d])/.exec(s.slice(i, i + 40));
    if (num) { push('?n'); i += num[0].length; continue; }
    const w = /^[A-Za-z_À-￿\d][\wÀ-￿$.]*/.exec(s.slice(i, i + 200));
    if (w) { const t = w[0].toLowerCase(); push(t.length > IDENT_MAX ? t.slice(0, IDENT_MAX) + '…' : t); i += w[0].length; continue; }
    push(c); i++;
  }
  o = o.replace(/\?[sn](?: ?, ?\?[sn])+/g, '?l');   // IN (…, …, …) 목록 접기(길이 정보도 줄임)
  const h = require('crypto').createHash('sha256').update(o).digest('hex').slice(0, 16);
  let m = o; for (const re of FULL) m = m.replace(re, x => '●'.repeat(x.length));
  m = maskQueryForLog(m).replace(/[\u0000-\u001f\u007f]/g, ' ');
  return { s: m.length > SQL_OUT_MAX ? m.slice(0, SQL_OUT_MAX) + '…' : m, h, views: [...new Set([...o.matchAll(/\b(?:from|join) ([a-z_][a-z0-9_.]*)/g)].map(x => x[1].split('.').pop().slice(0, IDENT_MAX)))].slice(0, 8) };
}
const sqlBase = a => {   // begin 용: 입력 형태가 이상해도 던지지 않는다
  const sq = a && a.sql, np = Array.isArray(a && a.params) ? Math.min(a.params.length, 99) : 0;
  if (typeof sq !== 'string') return { sq: { bad: sq === undefined ? 'none' : typeof sq, np } };
  const r = normSql(sq); return { sq: { h: r.h, len: sq.length, np, v: r.views, s: r.s } };
};
const SQL_WARN = [[/이사회 개최 횟수/, 'board_count'], [/합계행 검증 불일치|sum_check≠ok/, 'sum_not_ok'], [/검증 통과 문서» 만의 합계/, 'sum_scope'], [/기관 조건이 없는 집계/, 'agg_no_inst'], [/LIKE 검색/, 'like_inst'], [/행이 잘렸/, 'truncated'], [/개인정보 패턴/, 'pii_masked']];
const SQL_REJ = [[/이사회 개최 횟수/, 'board_count'], [/주석/, 'comment'], [/여러 문장/, 'multi_stmt'], [/SELECT 또는 WITH/, 'not_select'], [/허용되지 않은 표/, 'rel_denied'], [/시스템 카탈로그/, 'catalog'], [/허용되지 않은 함수/, 'func_denied'], [/허용되지 않은 키워드/, 'kw_denied'], [/원천 열/, 'pii_col'],
  [/RECURSIVE/, 'recursive'], [/합계\(SUM\)/, 'sum_no_check'], [/비용 추정/, 'cost'], [/실행 시간/, 'timeout'], [/SQL 오류/, 'sql_error'], [/바인딩 개수/, 'bind'], [/params/, 'params'], [/따옴표|문자열|E\/U&|달러|허용되지 않는 문자|괄호|형 변환|표 이름|스키마|FROM 절|FOR UPDATE|빈 식별자/, 'lexical'],
  [/너무 깁니다/, 'too_long'], [/sql 이 비어/, 'empty'], [/호출 한도/, 'rate'], [/동시 실행/, 'conc'], [/허용되지 않은 객체/, 'obj_denied']];
const sqlRejCode = m => { for (const [re, c] of SQL_REJ) if (re.test(m)) return c; return null; };
const errOf = e => {
  const m = String((e && e.message) || ''), c = e && e.code;
  if (audit() && (c === 'BAD_REQUEST' || c === 'BUSY')) { const rc = sqlRejCode(m); if (rc) return 'rej:' + rc; }   // query_sql 거부 사유 코드(감사 on 일 때만)
  return c === '57014' || /statement timeout|시간 제한/i.test(m) ? 'timeout' : /없음:|없습니다/.test(m) ? 'not_found' : /필요합니다/.test(m) ? 'bad_args' : 'error';
};
const top3 = rows => (Array.isArray(rows) ? rows : []).map(r => r && (r.doc_id || (r.corpus && r.rel_path ? r.corpus + ':' + r.rel_path : ''))).filter(Boolean).slice(0, 3).map(s => String(s).slice(0, 200));

// 응답 객체(MCP out / REST payload) → {n, top, w}
function summarize(tool, out, a) {
  if (!out || typeof out !== 'object') return {};
  const w = [];
  for (const d of (Array.isArray(out.degraded) ? out.degraded : [])) w.push('degraded:' + String(d).slice(0, 20));
  if (out.candidates_exhausted) w.push('candidates_exhausted');
  if (out.hint) w.push('zero_hint');
  if (out.series_warning) w.push('series_warning');
  if (a && bool(a.hybrid) && out.semantic === false) w.push('hybrid_semantic_off');
  if (out.rewritten) w.push('rewritten');
  if (out.understood && out.understood.inst) w.push('understood_inst');
  if (tool === 'query_sql' && audit()) {
    const p = out.policy || {}, ws = [].concat(p.warnings || []).map(x => { const r = SQL_WARN.find(([re]) => re.test(String(x))); return r ? r[1] : 'other'; });
    if (p.zero_hint) ws.push('zero_rows'); if (p.inst_alias_hint) ws.push('alias_hint'); if (out.truncated && !ws.includes('truncated')) ws.push('truncated');
    return { n: Number.isFinite(out.row_count) ? out.row_count : undefined, w: [...new Set(ws)] };
  }
  if (tool === 'get_document') return { n: out.articles_shown, top: top3(out.document ? [out.document] : []), w };
  if (tool === 'get_article') return { n: Array.isArray(out.articles) ? out.articles.length : undefined, top: out.doc_id ? [String(out.doc_id).slice(0, 200)] : [], w };
  return { n: Number.isFinite(out.count) ? out.count : undefined, top: top3(out.rows), w };
}

function make(cfg = {}) {
  const on = cfg.on !== undefined ? cfg.on : process.env.QUERY_LOG === '1';
  const dir = cfg.dir || process.env.QUERY_LOG_DIR || '/qlog';
  const maxBytes = (cfg.maxMb || parseFloat(process.env.QUERY_LOG_MAX_MB) || 20) * 1048576;
  const keepDays = cfg.keepDays || parseInt(process.env.QUERY_LOG_KEEP_DAYS || '90', 10);
  const maxQueue = cfg.maxQueue || 500;
  const NOOP = { end() {}, payload() {} };
  const stat = { written: 0, dropped_queue: 0, dropped_cap: 0, failed: 0 };
  const warned = new Map();
  const warn = (key, msg) => { const n = Date.now(); if (n - (warned.get(key) || 0) < 3600e3) return; warned.set(key, n); try { process.stderr.write('[qlog] ' + msg + '\n'); } catch {} };
  const q = []; let pumping = false;

  async function pump() {
    if (pumping) return; pumping = true;
    try {
      while (q.length) {
        const day = q[0].day, lines = [];
        while (q.length && q[0].day === day) lines.push(q.shift().line);
        const buf = lines.join('');
        try {
          await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
          const file = path.join(dir, `qlog_${day}.jsonl`);
          let size = 0; try { size = (await fs.promises.stat(file)).size; } catch {}   // ponytail: 프로세스 둘이 쓰면 상한은 근사(±배치 크기)
          if (size + buf.length > maxBytes) { stat.dropped_cap += lines.length; warn('cap' + day, `일 상한 ${(maxBytes / 1048576)}MB 도달 — ${day} 기록 중단`); continue; }
          await fs.promises.appendFile(file, buf, { mode: 0o600 });
          stat.written += lines.length;
        } catch (e) { stat.failed += lines.length; warn('fail', '쓰기 실패(요청에는 영향 없음): ' + (e && e.code || e && e.message)); }
      }
    } finally { pumping = false; }
  }
  function enqueue(rec) {
    try {
      if (q.length >= maxQueue) { stat.dropped_queue++; warn('queue', `큐 ${maxQueue} 초과 — 기록 버림`); return; }
      const k = kstIso();
      rec = { v: CLS_ON ? 2 : 1, t: k.slice(0, 16) + '+09:00', ...rec };
      q.push({ day: k.slice(0, 10).replace(/-/g, ''), line: JSON.stringify(rec) + '\n' });
      setImmediate(() => pump().catch(() => {}));
    } catch {}
  }

  // 보존 삭제: 파일명 날짜 기준. 시작 시 1회 + 6시간마다.
  async function purge(nowMs = Date.now()) {
    try {
      const cut = kstIso(nowMs - keepDays * 86400e3).slice(0, 10).replace(/-/g, '');
      for (const f of await fs.promises.readdir(dir)) {
        const m = /^qlog_(\d{8})\.jsonl$/.exec(f);
        if (m && m[1] < cut) await fs.promises.unlink(path.join(dir, f)).catch(() => {});
      }
    } catch {}
  }
  if (on) { purge(); setInterval(() => purge(), 6 * 3600e3).unref(); }

  // begin: 호출부는 «인자 객체(MCP arguments / REST args)» 와 등급만 넘긴다 — 요청·헤더 객체를 받지 않는다.
  function begin(src, tool, tier, a, label) {
    if (!on) return NOOP;
    try {
      a = a && typeof a === 'object' ? a : {};
      const t0 = process.hrtime.bigint(), isSearch = tool === 'search_corpus' || tool === 'search_extra' || tool === '/api/search';
      const base = { src, tool, tier: ['internal', 'external', 'master'].includes(tier) ? tier : 'unknown', client: labelOf(label), ...(CLS_ON ? { cls: clsOf(label) } : {}) };
      if (isSearch) Object.assign(base, { corpus: ['all', 'legal', 'bylaws', 'ca', 'disclosure'].includes(a.corpus) ? a.corpus : 'all', mode: modeOf(a), q: maskQ(a.keyword), qlen: String(a.keyword || '').length, f: filters(a) });
      else if (tool === 'query_sql' && audit()) Object.assign(base, sqlBase(a));
      else Object.assign(base, { doc: str(String(a.doc_id || ''), 200), ...(a.art_no !== undefined && Number.isFinite(parseInt(a.art_no, 10)) ? { art: parseInt(a.art_no, 10) } : {}) });
      let sum = {}, cached, ended = false;
      return {
        payload(p, isCached) { try { sum = summarize(tool, p, a); if (isCached) cached = true; } catch {} },
        end({ out, err, status } = {}) {
          if (ended) return; ended = true;
          setImmediate(() => { try {   // 응답을 보낸 뒤
            if (out !== undefined) sum = summarize(tool, out, a);
            const rec = { ...base, n: sum.n, top: sum.top, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), w: sum.w && sum.w.length ? sum.w : undefined };
            if (cached) rec.cached = true;
            if (status !== undefined) rec.status = status;
            if (err) rec.err = err; else if (status >= 400) rec.err = status === 408 ? 'timeout' : 'http_' + status;
            enqueue(rec);
          } catch {} });
        },
      };
    } catch { return NOOP; }
  }
  // REST 어댑터: 응답이 닫힐 때(close) 기록 — 캐시 히트·오류 반환 경로를 하나씩 고치지 않는다.
  function rest(res, tier, a, label) {
    const h = begin('rest', '/api/search', tier, a, label);
    if (h === NOOP) return h;
    let done = false;
    res.on('close', () => { if (done) return; done = true; h.end({ status: res.statusCode, ...(res.writableFinished ? {} : { err: 'aborted' }) }); });
    return h;
  }
  return { on, dir, begin, rest, purge, enqueue, stat, flush: async () => { const tick = () => new Promise(r => setImmediate(r)); await tick(); await tick(); while (q.length || pumping) { await pump(); await tick(); } }, errOf, maskQ };
}

module.exports = Object.assign(make(), { make, maskQ, errOf, filters, labelOf, clsOf, normSql });
