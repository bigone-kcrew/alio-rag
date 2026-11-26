'use strict';
/**
 * 적재 전 게이트 (load_pg.js 가 쓴다). DB 접근 없음 — 스테이징 파일만 읽는다(단위시험 가능).
 *
 *  A. scanStaging  : 코퍼스별 문서 수·청크 0개·잘림(truncated)·낮은 커버리지 비율 보고 + «거부 로그» 파일 + 규칙 세트(ruleset) 일관성
 *  B. checkUnique  : 고유 해시 수(embed_queue 건수)가 사전 산정값 EXPECT_UNIQUE 의 ±허용오차(기본 5%) 안인가
 *  C. specCompatible: 이전 적재의 embed_spec 과 이번 것이 같은 «해시 정의»인가(컷·접두·청커·차원) — 한 DB 에 두 정의가 섞이지 않게
 *
 * 거부 로그(outDir): zero_chunk_docs.tsv · truncated_docs.tsv · excluded_docs.tsv(소스 장애 페이지 등) · gate_report.json
 *   (loader 가 적재 중에 모으는 blank_body_articles.tsv·cut_truncated_chunks.tsv 는 load_pg.js 가 같은 폴더에 쓴다)
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const ZERO_STATUS = new Set(['no_articles', 'empty']);
const tsv = a => a.map(v => (v == null ? '' : String(v).replace(/[\t\r\n]+/g, ' '))).join('\t') + '\n';

async function* jsonl(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const l of rl) if (l.trim()) yield JSON.parse(l);
}

async function scanStaging(dir, corpora, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const w = n => { const s = fs.createWriteStream(path.join(outDir, n)); return s; };
  const zero = w('zero_chunk_docs.tsv'), trunc = w('truncated_docs.tsv'), excl = w('excluded_docs.tsv');
  zero.write(tsv(['corpus', 'doc_id', 'parse_status', 'content_chars']));
  trunc.write(tsv(['corpus', 'doc_id', 'n_articles', 'content_chars', 'covered_chars']));
  excl.write(tsv(['corpus', 'rel_path', 'reason']));
  const rep = { staging: dir, corpora: {}, ruleset: { values: [], missing: [] }, problems: [] };
  for (const co of corpora) {
    const st = { docs: 0, zero_chunk: 0, truncated: 0, low_coverage: 0, chunked: 0, excluded: 0 };
    for await (const d of jsonl(path.join(dir, `docs_${co}.jsonl`))) {
      st.docs++;
      if (d.n_articles === 0 || ZERO_STATUS.has(d.parse_status)) { st.zero_chunk++; zero.write(tsv([co, d.doc_id, d.parse_status, d.content_chars])); }
      if (d.parse_status === 'truncated') { st.truncated++; trunc.write(tsv([co, d.doc_id, d.n_articles, d.content_chars, d.covered_chars])); }
      if (d.parse_status === 'low_coverage') st.low_coverage++;
      if (d.parse_status === 'chunked') st.chunked++;
    }
    st.zero_ratio = st.docs ? +(st.zero_chunk / st.docs).toFixed(4) : 0;
    const cf = path.join(dir, `coverage_${co}.json`);
    if (fs.existsSync(cf)) {
      const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
      for (const f of c.source_error_page_files || []) { st.excluded++; excl.write(tsv([co, f, 'source_error_page'])); }
      for (const e of c.excluded_rule_docs || []) { st.excluded++; excl.write(tsv([co, 'sha1:' + e.h, e.reason])); }   // 개인 기록 색인 제외 — 경로 대신 해시
      if (c.incremental_since) st.incremental_since = c.incremental_since;
      if (c.ruleset) { if (!rep.ruleset.values.includes(c.ruleset)) rep.ruleset.values.push(c.ruleset); } else rep.ruleset.missing.push(co);
    } else rep.ruleset.missing.push(co);
    rep.corpora[co] = st;
  }
  await Promise.all([zero, trunc, excl].map(s => new Promise(r => s.end(r))));
  // 같은 적재에 규칙 세트가 둘 이상 섞이면 중단(코퍼스마다 청커가 다르면 해시 정의가 갈린다)
  if (rep.ruleset.values.length > 1) rep.problems.push(`스테이징 ruleset 혼재: ${rep.ruleset.values.join(', ')}`);
  rep.chunker = rep.ruleset.values.length === 1 ? rep.ruleset.values[0] : 'unknown';
  fs.writeFileSync(path.join(outDir, 'gate_report.json'), JSON.stringify(rep, null, 2));
  return rep;
}

function checkUnique(actual, expect, tol = 0.05) {
  const lo = Math.floor(expect * (1 - tol)), hi = Math.ceil(expect * (1 + tol));
  return { ok: actual >= lo && actual <= hi, actual, expect, lo, hi, ratio: +(actual / expect).toFixed(4) };
}

// embed_spec 비교 — index= 는 임베딩 후 바뀔 수 있어 제외하고 model·dim·prefix·cut·chunker 가 같아야 «같은 해시 정의».
// model 은 openrouter/ollama 표기 차이를 흡수하려고 비교하지 않는다(ALLOWED_MODELS 가 따로 막는다).
function specCompatible(a, b) {
  const parse = s => Object.fromEntries(String(s || '').split('|').slice(1).map((x, i) => (x.includes('=') ? x.split('=') : ['dim', x])));
  const pa = parse(a), pb = parse(b);
  const diff = ['dim', 'prefix', 'cut', 'chunker'].filter(k => pa[k] !== pb[k]);
  return { ok: diff.length === 0, diff };
}

// git 리비전(+dirty 표시). 컨테이너에 .git 이 없으면 CODE_REV 환경변수, 그것도 없으면 null.
function codeRev(cwd) {
  if (process.env.CODE_REV) return process.env.CODE_REV;
  try {
    const run = (...a) => execFileSync('git', a, { cwd, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const rev = run('rev-parse', 'HEAD');
    return run('status', '--porcelain', '--untracked-files=no') ? rev + '-dirty' : rev;
  } catch { return null; }
}

// 적재 중 모으는 거부 로그(빈 본문 조문·컷으로 잘리는 청크) — 줄 단위 TSV
function openRejectLog(outDir, name, header) {
  fs.mkdirSync(outDir, { recursive: true });
  const s = fs.createWriteStream(path.join(outDir, name));
  s.write(tsv(header));
  return { n: 0, write(row) { this.n++; s.write(tsv(row)); }, end: () => new Promise(r => s.end(r)) };
}

module.exports = { scanStaging, checkUnique, specCompatible, codeRev, openRejectLog, tsv };
