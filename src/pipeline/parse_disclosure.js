#!/usr/bin/env node
/**
 * 공시자료(disclosure) 청커 — alio-md/자료/기관별공시 의 비조문형 문서를
 * 검색용 청크로 분해해 JSONL 스테이징 생성. (조문 파서 parse_articles.js와 별개)
 *
 * 사용법:
 *   node rag/parse_disclosure.js            # 전체
 *   node rag/parse_disclosure.js --limit 300  # 앞 300파일만(테스트)
 *   node rag/parse_disclosure.js --sample 3   # 청크 샘플 3건 출력
 *
 * 출력: _ops/_rag_staging/{docs,articles}_disclosure.jsonl + coverage_disclosure.json
 *  - 청크는 articles 레코드 형태로 저장(section='본칙', art_no=null) → 기존 적재·검색 재사용
 */
const fs = require('fs');
const path = require('path');
const { once } = require('events');

const ROOT = path.join(__dirname, '..', 'data');
const _argv = process.argv.slice(2);
// --out <dir>: 스테이징 출력 override(수시 델타는 별도 디렉터리로 → 전체 스테이징 안 건드림)
const OUT = _argv.includes('--out') ? path.resolve(_argv[_argv.indexOf('--out') + 1])
                                    : path.join(__dirname, '..', 'ops', '_rag_staging');
// --under <substr[,substr]>: 경로에 해당 문자열 포함 파일만 파싱(수시 델타=채용 서브트리만)
const UNDER = _argv.includes('--under')
  ? _argv[_argv.indexOf('--under') + 1].split(',').map(s => s.trim()).filter(Boolean) : null;
// --since <ISO|epoch_ms>: mtime이 이보다 최신인 md만 파싱(진짜 델타 — 신규 + 재변환/OCR개선분 모두 잡음)
const SINCE = _argv.includes('--since')
  ? (isNaN(+_argv[_argv.indexOf('--since') + 1]) ? Date.parse(_argv[_argv.indexOf('--since') + 1]) : +_argv[_argv.indexOf('--since') + 1])
  : null;
const BASE = path.join(ROOT, 'alio-md', '자료', '기관별공시');

// 문서당 최대 청크(거대 OCR 덤프 방어). 40 → 120 → **2000**(2026-08-10, 사용자 결정).
// ⚠️ 이 상한은 내규 쪽 HARD_CAP 과 성격이 다르다 — **넘으면 쪼개는 게 아니라 뒤쪽을 버린다**(truncated).
//    120 에서 실제로 걸리던 것은 OCR 덤프가 아니라 **정상 대형 문서**였다(경영평가 보고서·결산서·
//    국회 예비심사보고서). 08-10 실측(200KB↑ md 3,647건 전수, CAP 무한대로 열어 진짜 청크 수 측정):
//      잘리는 문서 2,200건 · 버려지던 글자 **2.93억 자** · 진짜 청크 수 p50 265 · p95 467 · p99 747 · 최대 2,762
//      CAP 400→92.3% 해소 / 800→99.2% / 1200→99.9% / 2000→100%(잔여 1건)
//    400 에서 2000 까지 늘려도 **추가 청크는 3만(+9%)뿐**이라(비용 곡선이 400에서 평평) 낮게 잡을 실익이 없다.
//    상한을 완전히 없애지는 않는다 — 원래 목적인 거대 OCR 덤프 방어선은 남긴다.
// 청커·파서 규칙 세트 식별자 — load_runs.embed_spec 에 기록된다(chunker=). 청킹/조문 파싱 규칙을 바꾸면 «함께» 올린다(= 해시가 바뀐다).
// 세 파일(chunk_doc.js·parse_disclosure.js·parse_articles.js)의 값은 같아야 한다 — _test_chunker_copy.js 가 검사.
const RULESET = 'chunk-v4-cut3500-abs3200+ca-fallback-A+gfm';
const CHUNK_CAP = 2000;
const TARGET_DIV = 40;          // 적응형 target 산정 분모(청크≈내용/TARGET_DIV). CHUNK_CAP과 분리 — cap 변경이 청크 크기에 영향 안 주게
const TARGET_MAX = 2500;        // 청크 상한(4000→2500). 과대 청크의 임베딩 의미 희석 완화(검색 정밀도↑)
const MIN_CHUNK_CHARS = 40;     // 이보다 짧은 조각은 «버리지 않고» 직전 청크에 흡수(없으면 다음 청크 앞·단독 청크). 글자·숫자가 하나도 없는 조각만 버린다(emit)
const { EMBED_CUT, EMBED_PREFIX_ALLOWANCE } = require('./embed_spec');
const EMBED_MAX = EMBED_CUT - EMBED_PREFIX_ALLOWANCE;   // 흡수 한도(=3200). 컷(3500)에서 접두·제목 여유(300)를 뺀다(embed_spec.js 단일 정의) — 흡수 후 이 길이를 넘기면 흡수하지 않고 별도 청크
const OVERLAP = 120;

// ── 내부 감사용 이력(parser_ver·converted_at·ocr_kind) — 응답·임베딩·해시에 쓰이지 않는다 ──────
// 출처: 정리 후 매니페스트에서 build_md_stamps_tsv.js 로 뽑은 TSV(코퍼스별 1개). MD_STAMPS_TSV 로 지정(없으면 전부 NULL).
// 열: path\tparser_ver\tconverted_at\tocr_kind\tbody_md5\tsrc_md5\torigin  (앞 4열은 구판과 호환 — 뒤 3열이 없어도 동작)
// path = 매니페스트 path 에서 코퍼스 기준 폴더(--prefix, 예 `자료/기관별공시/`)를 뗀 상대경로 = 이 파서의 `rel`. 매핑 실패는 NULL 로 두고 끝에 건수를 보고한다.
const STAMPS = new Map();
if (process.env.MD_STAMPS_TSV) {
  for (const l of fs.readFileSync(process.env.MD_STAMPS_TSV, 'utf8').split('\n')) {
    const [k, pv, ca, pm, bm, sm, og] = l.split('\t');
    if (k) STAMPS.set(k, { parser_ver: pv || null, converted_at: ca || null, ocr_kind: pm || null, body_md5: bm || null, src_md5: sm || null, origin: og || null });
  }
}
const NO_STAMP = { parser_ver: null, converted_at: null, ocr_kind: null, body_md5: null, src_md5: null, origin: null };
let stampHit = 0, stampMiss = 0;
const stampOf = rel => { const s = STAMPS.get(rel); if (s) { stampHit++; return s; } stampMiss++; return NO_STAMP; };

const args = process.argv.slice(2);
const LIMIT = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : 0;
const SAMPLE = args.includes('--sample') ? parseInt(args[args.indexOf('--sample') + 1], 10) : 0;

// ── doc_id 키 정책 (2026-10-03, PLAN_누락재발방지 «매니페스트 관리 설계» §3) ─────────────────────────
// 종전 doc_id = `disclosure:<md 상대경로>` — 폴더 개명·회차 정정·이관마다 doc_id 가 바뀌어 DB·앵커·링크가 깨진다.
// stable 모드: `disclosure:<apba_id>:<공시번호>:a:<sha1(원본파일명)[:10]>`(첨부 변환본) /
//             `disclosure:<apba_id>:<공시번호>:c:<sha1(md 파일명)[:10]>`(본문 등 원본 없는 md).
//   - 공시번호 = 같은 폴더 manifest.json 의 report.disclosure_no, apba_id = 기관 폴더명 접미(_Cxxxx).
//   - 같은 공시가 두 기관 폴더에 있는 경우(473건 실측)도 apba_id 가 달라 충돌하지 않는다.
//   - 폴더 메타가 없으면(게시판형 등) 종전 경로 키로 폴백한다. 한 실행 안에서 키가 충돌해도 폴백한다(통계에 센다).
// 기본은 'path'(출력이 종전과 동일) — S4(DB 적재) 착수 때 'stable' 로 전환한다. 전환은 한 번에, 전량(`--doc-id-mode stable`).
const DOC_ID_MODE = args.includes('--doc-id-mode') ? args[args.indexOf('--doc-id-mode') + 1] : (process.env.DOC_ID_MODE || 'path');
if (!['path', 'stable'].includes(DOC_ID_MODE)) { console.error('--doc-id-mode path|stable'); process.exit(2); }
const _sha1 = (x) => require('crypto').createHash('sha1').update(String(x)).digest('hex');
const _folderMeta = new Map();
function folderMeta(dir) {
  if (_folderMeta.has(dir)) return _folderMeta.get(dir);
  let r = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const dno = String(j?.report?.disclosure_no || '').trim();
    if (dno) r = dno;
  } catch { /* 메타 없음 */ }
  _folderMeta.set(dir, r);
  return r;
}
function fmField(text, name) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3); if (end < 0) return null;
  const m = text.slice(4, end).match(new RegExp('^' + name + ':\\s*(.*)$', 'm')); if (!m) return null;
  let v = m[1].trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
  else if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
  return v || null;
}
function stableDocId(abs, text, rel) {
  // 첨부 하위폴더(공시 폴더 안쪽)의 md 는 manifest 가 «상위»에 있다 — 공시 폴더(기관/서식/회차)까지 올라가며 찾는다(2026-10-03:
  //   직접 manifest 없는 74,610건 중 49,100건이 상위에서 발견됐다). 하위경로가 다르면 같은 원본명도 다른 키가 된다.
  const parts = rel.split(path.sep), dirs = parts.slice(0, -1);
  let dno = null, sub = '';
  for (let n = dirs.length; n >= 3 && !dno; n--) {
    dno = folderMeta(path.join(path.dirname(abs), ...Array(dirs.length - n).fill('..')));
    if (dno) sub = dirs.slice(n).join('/');
  }
  const apba = (parts[0].match(/_(C\d+)$/) || [])[1];
  if (!dno || !apba) return null;
  // 🔴 2026-10-07: 키에 넣는 하위경로는 «매니페스트 위치 아래»(sub)가 아니라 «회차 폴더 아래 전체 꼬리»(dirs.slice(3))다.
  //   매니페스트가 제목 하위폴더 «자기 자리»에 있으면 sub 가 비어, 같은 공시 폴더의 `내용.md` 들이 한 키로 합쳐졌다
  //   (공시 39.3만 중 충돌 키 3,093개·문서 32,121건 → 꼬리를 쓰면 1,735개·3,475건, 대부분 같은 공시의 회차폴더 중복 사본).
  //   회차 폴더 이름(2026 / 2026-0825)은 여전히 키에 넣지 않는다(회차 정정에 안정).
  sub = dirs.slice(3).join('/');
  const of = fmField(text, 'original_file');
  return of ? `disclosure:${apba}:${dno}:a:${_sha1(sub ? sub + '/' + of : of).slice(0, 10)}` : `disclosure:${apba}:${dno}:c:${_sha1(sub ? sub + '/' + path.basename(abs) : path.basename(abs)).slice(0, 10)}`;
}
const _idSeen = new Map();

function* walk(dir, depth = 0) {
  // 이름순 정렬 — doc_id 충돌 시 «먼저 걸린 쪽이 안정 키»라서 순회 순서가 결정적이어야 한다(readdir 순서는 보장되지 않는다).
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // --under 가지치기: 기관(depth 0) 밑으로는 경로에 토큰 없는 카테고리 서브트리 스킵(전수 walk 방지)
      if (UNDER && depth >= 1 && !UNDER.some(u => p.includes(u))) continue;
      yield* walk(p, depth + 1);
    } else yield p;
  }
}

function stripFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] === '---') {
    for (let i = 1; i < Math.min(lines.length, 40); i++) {
      if (lines[i] === '---') return lines.slice(i + 1);
    }
  }
  return lines;
}

// HTML 잡음 제거(임베딩 입력용). ⚠️ parse_articles.js 의 htmlNoise 와 같은 규칙 — 한쪽만 고치지 말 것.
//  · 한 줄 <!-- 주석 --> : 변환기 이력(source/converted_at/ocr). 머리말·꼬리 주석을 지운 md 와 안 지운 md 가
//    같은 청크·같은 text_hash 를 내게 하려면 «청크 산정 전»에 없애야 한다(contentChars→target 이 달라진다).
//  · 태그는 «알려진 HTML 태그»만 지운다. `<MBC>`·`<attachment>`·`<137>`·`<개정 2020.1.1>` 은 본문이다.
//  · 엔티티는 태그 제거 «뒤»에 푼다(&lt;b&gt; 가 태그로 오인돼 지워지지 않게). &amp; 는 마지막.
const HTML_COMMENT = /<!--.*?-->/g;
const HTML_BLOCK = /<\/?(?:table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|hr|p|div|ul|ol|li)(?=[\s/>])[^>]*>/gi;
const HTML_INLINE = /<\/?(?:span|sup|sub|font|strong|em|img)(?=[\s/>])[^>]*>/gi;
const HTML_ENT = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'" };
const entCp = cp => (cp >= 32 && cp < 0x110000 && !(cp >= 0x7f && cp < 0xa0) && !(cp >= 0xd800 && cp < 0xe000)) ? String.fromCodePoint(cp) : ' ';
function htmlNoise(s) {
  s = s.replace(HTML_COMMENT, '').replace(/<br\s*\/?>/gi, ' ').replace(HTML_BLOCK, ' ').replace(HTML_INLINE, '');
  return s.replace(/&(nbsp|lt|gt|quot|apos);|&#(\d{1,7});|&#x([0-9a-f]{1,6});/gi,
      (m, n, d, x) => n ? HTML_ENT[n.toLowerCase()] : entCp(d ? +d : parseInt(x, 16)))
    .replace(/&amp;/g, '&');
}

// 한 줄을 검색용 텍스트로 정리. 버릴 줄이면 null.
function cleanLine(raw) {
  let s = raw;
  if (s.includes('<!--')) { s = s.replace(HTML_COMMENT, ''); if (!s.trim()) return null; }   // 주석뿐인 줄은 줄째 버린다
  if (/alio\.go\.kr/.test(s)) return null;                        // 포털 링크/nav
  if (/^\s*#{0,6}\s*!\[/.test(s)) return null;                    // 이미지(로고/CI)
  if (/\[(PDF|파일)[^\]]*다운로드\]|javascript:void/.test(s)) return null;
  if (/^\s*(#{1,6}\s*)?(문서\s*목차|첨부파일|보고서명)\s*$/.test(s)) return null;
  if (/^\s*\|?[\s:|]*-{2,}[\s:|-]*\|?\s*$/.test(s)) return null;  // 표 구분행
  if (/^\s*\|.*\|\s*$/.test(s)) s = s.replace(/\|/g, '  ');        // 표 데이터행 → 셀 텍스트
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');                  // [t](url) → t
  s = s.replace(/\*\*?/g, '').replace(/^\s*#{1,6}\s*/, '');       // 굵게/헤딩 표식 제거
  s = htmlNoise(s);
  s = s.replace(/[\u3000\u00a0]/g, ' ').replace(/\s+$/, '');
  return s;
}

// 글자·숫자가 하나라도 있으면 내용이다(종전: 40자↑ AND 한글/영문 — 짧은 꼬리·숫자표를 버렸다).
const hasContent = t => /[가-힣A-Za-z0-9]/.test(t);

const isTableRow = l => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = l => /^\s*\|?[\s:|]*-{2,}[\s:|-]*\|?\s*$/.test(l);
// 2026-10-07: gfm 출력의 중첩 표 관계 주석 `<!-- <table id=… parent_id=… /> -->` 를 표 시작으로 오인해 문서 나머지를 청크 1개로 삼키던 결함 수정 — 주석을 먼저 지운 줄만 본다.
const isHtmlTableStart = l => /<table[\s>]/i.test(l.replace(/<!--.*?-->/g, ''));

// 표 행을 검색용 텍스트로(셀 구분=이중공백), 링크/굵게 제거
function cleanTableRow(raw) {
  let s = raw.trim().replace(/^\|/, '').replace(/\|$/, '');
  s = s.split('|').map(c => c.trim()).join('  ');
  s = htmlNoise(s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*?/g, ''));
  return s.replace(/[　 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// 정리된 행들(0=헤더)을 행 경계로 분할(넘치면 헤더 반복, char 중간 절단 없음)
function chunkRows(rows, target) {
  rows = rows.filter(Boolean);
  if (!rows.length) return [];
  const header = rows[0], data = rows.slice(1);
  if (data.length === 0) return [header];
  const out = [];
  let cur = [header], len = header.length;
  for (const row of data) {
    if (len + row.length + 1 > target && cur.length > 1) {
      out.push(cur.join('\n'));
      cur = [header, row]; len = header.length + row.length + 1;
    } else { cur.push(row); len += row.length + 1; }
  }
  if (cur.length > 1) out.push(cur.join('\n'));
  return out;
}

// markdown |표| 원행 → 정리 행 배열
function mdTableRows(rows) {
  const out = [];
  for (const r of rows) { if (isTableSep(r)) continue; const c = cleanTableRow(r); if (c) out.push(c); }
  return out;
}

// HTML <table> 블록텍스트 → 정리 행 배열(행 경계=<tr>·</tr>, 셀 경계=<th>/<td> 여닫이, <br>→공백, 태그 제거)
// ⚠️ 종전엔 `<tr>…</tr>` · `<td>…</td>` 를 정규식으로 «짝지어» 뽑아서, 중첩 표(kordoc 병합표)의 안쪽 `</td>` 에서
//    바깥 셀이 끝난 것으로 읽고 **안쪽 표 뒤에 이어지는 바깥 셀 본문을 통째로 버렸다**(`</table><br>※ …동의합니다</td></tr>`
//    — 2026-10-06 공시 2,588건 중 1,000여 건에서 «원문에 있는데 청크에 없는 줄» 로 실측). 경계로 쪼개면 짝이 틀어져도 잃지 않는다.
function htmlTableRows(blockText) {
  const out = [];
  const t = blockText.replace(HTML_COMMENT, '')
    .replace(/<\/?tr(?:\s[^>]*)?>/gi, '\uE000')
    .replace(/<\/?t[hd](?:\s[^>]*)?>/gi, '\uE001');
  for (const row of t.split('\uE000')) {
    const cells = row.split('\uE001').map(c =>
      htmlNoise(c).replace(/[\u3000\u00a0]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const line = cells.join('  ').trim();
    if (line) out.push(line);
  }
  return out;
}

// 긴 문단을 단어 경계로 분할(char 중간 절단 방지)
function splitByWords(p, target) {
  const out = [];
  let cur = '';
  for (const w of p.split(' ')) {
    if (cur && cur.length + 1 + w.length > target) { out.push(cur); cur = ''; }
    cur += (cur ? ' ' : '') + w;
  }
  if (cur) out.push(cur);
  return out;
}

// 문단 누적 청킹(적응형 크기·오버랩·상한). 표(연속 |행| 2줄↑)는 평탄화 전에 분리해
// 행 경계로 분할 — 표 중간 절단 방지. 비(非)표 문서는 기존과 동일 동작.
function chunkDoc(rawLines) {
  // 1) 원문 기준 표(markdown/HTML)/텍스트 블록 분절(표 구조 살아있는 상태에서)
  const seq = [];             // {type:'rows',rows:[정리행]} | {type:'text',paras}
  let contentChars = 0;
  const addText = (buf) => {
    const cleaned = [];
    for (const l of buf) { const c = cleanLine(l); if (c !== null) cleaned.push(c); }
    const paras = cleaned.join('\n').split(/\n{2,}/)
      .map(p => p.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    contentChars += paras.reduce((s, p) => s + p.length, 0);
    seq.push({ type: 'text', paras });
  };
  const addRows = (rows) => {
    rows = rows.filter(Boolean);
    if (!rows.length) return;
    contentChars += rows.reduce((s, r) => s + r.length, 0);
    seq.push({ type: 'rows', rows });
  };
  for (let i = 0; i < rawLines.length; ) {
    if (isHtmlTableStart(rawLines[i])) {                 // HTML <table> 블록
      const buf = [];
      while (i < rawLines.length) { const end = /<\/table>/i.test(rawLines[i]); buf.push(rawLines[i++]); if (end) break; }
      const rows = htmlTableRows(buf.join('\n'));
      if (rows.length) addRows(rows); else addText(buf);
      continue;
    }
    if (isTableRow(rawLines[i])) {                        // markdown |표| 블록(2줄↑)
      const raw = [];
      while (i < rawLines.length && isTableRow(rawLines[i])) raw.push(rawLines[i++]);
      if (raw.length >= 2) { addRows(mdTableRows(raw)); continue; }
      i -= raw.length;                                    // 단일 |행| → 텍스트
    }
    const buf = [];                                       // 텍스트 블록(다음 표 시작 전까지)
    while (i < rawLines.length
           && !isHtmlTableStart(rawLines[i])
           && !(isTableRow(rawLines[i]) && i + 1 < rawLines.length && isTableRow(rawLines[i + 1]))) buf.push(rawLines[i++]);
    addText(buf);
  }
  if (contentChars === 0) return { chunks: [], contentChars: 0, truncated: false };

  const target = Math.max(1000, Math.min(TARGET_MAX, Math.round(contentChars / TARGET_DIV)));
  const chunks = [];
  let cur = '';
  let truncated = false;
  const capHit = () => chunks.length >= CHUNK_CAP;
  // 청크 방출. 짧은 조각(<MIN_CHUNK_CHARS)은 버리지 않는다 — 종전엔 버려서, 변환기 꼬리 주석이 «떠받치던»
  // 짧은 꼬리 본문("해당사항 없음", "…이사장 귀중")이 주석을 지우면 사라졌다(2026-10-06 실측 7.8%).
  //  ① 앞 청크가 있으면 그 뒤에 이어 붙인다(읽는 순서 유지, 4000자 상한 안에서만)
  //  ② 없으면 carry 로 들고 있다가 다음 청크 앞에 붙이고, 끝까지 없으면 단독 청크
  //  글자·숫자가 하나도 없는 조각(기호·구분선뿐)만 버린다.
  let carry = '';
  const emit = (raw) => {
    const t = raw.trim();
    if (!hasContent(t)) return;
    if (t.length < MIN_CHUNK_CHARS) {
      const last = chunks.length - 1;
      if (last >= 0 && chunks[last].length + 1 + t.length <= EMBED_MAX) { chunks[last] += '\n' + t; return; }
      carry = carry ? carry + '\n' + t : t;
      return;
    }
    chunks.push(carry ? carry + '\n' + t : t); carry = '';
  };
  const push = () => { emit(cur); cur = ''; };

  outer:
  for (const s of seq) {
    if (s.type === 'rows') {                           // 표(markdown·HTML) → 행 경계 분할
      if (cur) { push(); if (capHit()) { truncated = true; break; } }
      for (const tc of chunkRows(s.rows, target)) {
        if (capHit()) { truncated = true; break outer; }
        emit(tc);
      }
      continue;
    }
    for (const p of s.paras) {
      if (p.length > target) {                       // 긴 문단 → 단어 경계 분할
        if (cur) { push(); if (capHit()) { truncated = true; break outer; } }
        for (const piece of splitByWords(p, target)) {
          if (capHit()) { truncated = true; break outer; }
          emit(piece);
        }
        continue;
      }
      if (cur && cur.length + 1 + p.length > target) {
        const prev = cur;
        push();
        if (capHit()) { truncated = true; break outer; }
        cur = prev.slice(-OVERLAP) + ' ';            // 오버랩
      }
      cur += (cur ? ' ' : '') + p;
    }
  }
  if (!capHit()) push();
  if (carry) chunks.push(carry);                       // 앞 청크가 끝내 없던 짧은 내용(문서 전체가 짧은 경우 포함)

  return { chunks, contentChars, truncated };
}

// 기간 폴더 이름 규칙 — 수집기 periodFolderName()이 만드는 세 형태를 모두 받는다.
//   2026 (종전) · 2026Q2 (분기 서식) · 2022-0422 (연 다회 공시, 공시일 MMDD)
const PERIOD_SEG = /^(\d{4})(?:Q([1-4])|-(\d{4}))?$/;

function docMeta(rel) {
  const segs = rel.split(path.sep);
  const m = (segs[0] || '').match(/^\[([^\]]+)\](.+)_(C\d+)$/);
  const ministry = m ? m[1] : null, inst_name = m ? m[2] : null, inst_code = m ? m[3] : null;
  // ⚠️ 기간 세그먼트는 `2026` 하나가 아니다(2026-08-02 규칙 변경).
  //    한 해에 2건 이상 올라오는 공시를 한 폴더에 겹쳐 담다가 **439건이 자기 메타·본문을 잃어서**
  //    회차를 경로로 구분하게 됐다: 분기 서식은 `2026Q2`, 연 다회 공시는 `2022-0422`(공시일 MMDD).
  //    `/^\d{4}$/`로만 찾으면 그 폴더들에서 **연도가 통째로 null이 된다.**
  const pm = segs.map(s => PERIOD_SEG.exec(s)).find(Boolean);
  const yearSeg = pm ? pm[1] : null;
  const quarter = pm && pm[2] ? pm[2] : null;
  const mmdd = pm && pm[3] ? pm[3] : null;
  // 카테고리 세그먼트(숫자코드_항목명) 중 연도 직전의 가장 깊은 것 = 실제 항목.
  // 상위그룹(예: 기관운영)이 한 단계 더 낀 예외 경로에서도 하위항목(인력관리 등)을 집음.
  const yi = segs.findIndex(s => PERIOD_SEG.test(s));
  const endIdx = yi === -1 ? segs.length - 1 : yi;   // 파일명(basename)은 제외
  const catSegs = segs.slice(1, endIdx).filter(s => /^\d+_/.test(s));
  const scdSeg = catSegs.length ? catSegs[catSegs.length - 1] : (segs[1] || '');
  const itemName = scdSeg.includes('_') ? scdSeg.slice(scdSeg.indexOf('_') + 1) : scdSeg;
  const base = path.basename(rel, '.md');
  const dm = base.match(/\((\d{8})\)/) || base.match(/(\d{8})/) || base.match(/\((\d{4})[.\-)]/);
  // 파일명 날짜 > 폴더의 MMDD > 연도. 폴더가 회차를 알고 있으면 그걸 쓴다.
  const doc_date = dm ? dm[1] : (mmdd ? `${yearSeg}${mmdd}` : yearSeg);
  const doc_title = base.replace(/\(\d{8}\)\s*$/, '').replace(/\(첨부\)/g, '').trim() || base;
  return { inst_code, inst_name, ministry, category: scdSeg || null,
           doc_title, doc_type: itemName || '공시', doc_date,
           // 회차를 경로에서 알아냈으면 버리지 말고 실어 보낸다(분기 추이 조회용).
           // period_year는 doc_date에 이미 들어 있어 만들지 않는다 — 저장 안 할 필드는 애초에 안 만든다.
           period_quarter: quarter };
}

fs.mkdirSync(OUT, { recursive: true });
const docsOut = fs.createWriteStream(path.join(OUT, 'docs_disclosure.jsonl'));
const artsOut = fs.createWriteStream(path.join(OUT, 'articles_disclosure.jsonl'));
docsOut.on('error', e => { console.error('docs 쓰기 실패:', e); process.exit(1); });
artsOut.on('error', e => { console.error('articles 쓰기 실패:', e); process.exit(1); });
const stat = { files: 0, docs: 0, chunks: 0, empty: 0, truncated: 0, skippedCa: 0 };
let seen = 0, samplesShown = 0;

// 동기 루프는 이벤트 루프를 막아 수 GB가 스트림 버퍼에 통째로 쌓였다가
// 종료 flush에서 writev 실패로 죽는 사고가 있었음(2026-07-17, 4GiB 절단+중복) — drain 대기 필수.
async function write(stream, line) {
  if (!stream.write(line)) await once(stream, 'drain');
}

// ── 소스 장애 페이지 배제 (2026-08-02 신설) ──────────────────────────────────
// 사고: ALIO 상세 페이지가 장애일 때 **HTTP 200으로 안내 페이지(408바이트)**를 반환하고,
//   수집기의 산출 판정이 `markdown.length > 0`만 봐서 공시 본문으로 저장했다(610건 발생,
//   그중 398건은 07-18 적재를 타 DB·임베딩까지 진입해 3주간 라이브 검색에 노출).
// ⚠️ 08-01에 `parse_articles.js`에 같은 가드를 넣었지만 **그 파일은 disclosure를 다루지 않는다**
//   (CORPORA = legal|bylaws|ca). 도달 불가 코드였고, 실제 방어는 여기 있어야 한다.
// ⚠️ 판정은 **장애 문구 단독**이다. 「보고서 구조 표지 부재」를 조건에 넣으면
//   alio-md 162,404건 중 **146,915건(90.5%)**이 배제된다 — 대부분이 첨부 변환본이라
//   그런 마커가 애초에 없다(전수 실측). 크기 기준도 금지: 「해당 사항이 없는 항목입니다」가
//   761~800바이트로 정상 존재한다(222건).
const SRC_ERROR_PHRASES = /서비스에 접속할 수 없습니다|기술적인 문제로 일시적/;
const isSourceErrorPage = (text) => SRC_ERROR_PHRASES.test(String(text || ''));
const taintedDocs = [];
const { excludeReason, relHash, isAlias, aliasesOf } = require('./exclude_rules');
let aliasSkipped = 0;   // 재게시 별칭(DUP_MAP)으로 건너뛴 문서 수
// ── 중복 «표시»(색인 제외 아님, 2026-10-09 사용자 확정): DUP_MARK=1 이면 모든 doc 의 meta 에 안정 키 2개를 단다.
//   dup_group  = md5(기관|항목|하위경로|본문해시) — 같은 기관·항목·하위경로의 다른 회차 재게시가 같은 키(회차 폴더는 키에서 뺀다)
//   body_group = md5(기관|본문해시)               — 같은 기관 안 같은 본문(공고·계약마다 붙는 양식 포함)
// 개수(dup_n·회차 목록)는 저장하지 않는다 — 질의 시점에 meta 키 distinct 로 센다(증분에서 낡지 않게). 기관 간에는 절대 묶지 않는다(기관이 키에 포함).
const DUP_MARK = process.env.DUP_MARK === '1';
const _md5 = s => require('crypto').createHash('md5').update(s).digest('hex');
const ROUND_RE = /^\d{4}(?:-\d{4}|Q[1-4])?(?:__.*)?$/;
function dupKeys(rel, bodyMd5, bodyLen) {
  const parts = String(rel).split(path.sep).join('/').split('/');
  const inst = (parts[0].match(/_(C\d{4})$/) || [])[1] || parts[0];   // 기관코드만(기관명·부처 변경에 키가 쪼개지지 않게)
  const item = parts[1] || '';
  const norm = x => x.replace(/__(?:idx|sn)\d+/g, '').replace(/\s*\(\d+\)(?=\.md$|$)/, '').replace(/\s+/g, ' ').trim();   // 수집 접미(__idx·__sn)·« (1)» 접미·공백 정규화
  const sub = (ROUND_RE.test(parts[2] || '') ? parts.slice(3) : parts.slice(2)).map(norm).join('/');
  if (bodyLen < 500) return { trivial: true };   // 상투구 수준 짧은 본문(500자 미만)은 접지 않는다(서로 다른 원본일 수 있음)
  return { dup_group: _md5([inst, item, sub, bodyMd5].join('|')), body_group: _md5([inst, bodyMd5].join('|')) };
}
const excludedRule = [];   // 색인 제외 규칙에 걸린 문서 {h: 경로 sha1[:12], rule, reason} — 경로·이름은 남기지 않는다

async function main() {
for (const abs of walk(BASE)) {
  if (!abs.endsWith('.md')) continue;
  if (UNDER && !UNDER.some(u => abs.includes(u))) continue;      // 부분 파싱(--under)
  if (abs.includes('단체협약')) { stat.skippedCa++; continue; }  // 이미 ca 코퍼스
  if (SINCE) { let st; try { st = fs.statSync(abs); } catch { continue; } if (st.mtimeMs <= SINCE) continue; }  // 델타(--since)
  const rel = path.relative(BASE, abs);
  { const ex = excludeReason(rel); if (ex) { excludedRule.push({ h: relHash(rel), rule: ex.id, reason: ex.reason }); continue; } }   // 색인 제외(개인 기록) — seen·LIMIT 에 넣지 않는다
  if (isAlias(rel)) { aliasSkipped++; continue; }   // 재게시 별칭 — 대표 doc 의 meta.aliases 로만 남는다(DUP_MAP 있을 때만)
  const pathId = `disclosure:${rel}`;
  seen++;
  if (LIMIT && seen > LIMIT) break;

  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  let doc_id = pathId;
  if (DOC_ID_MODE === 'stable') {
    const sid = stableDocId(abs, text, rel);
    if (sid && !_idSeen.has(sid)) { doc_id = sid; _idSeen.set(sid, rel); }
    else if (sid) { stat.idCollision = (stat.idCollision || 0) + 1; console.warn(`doc_id 충돌 → 경로 키로 폴백: ${rel} ↔ ${_idSeen.get(sid)}`); }
    else stat.idPathFallback = (stat.idPathFallback || 0) + 1;
  }
  // 장애 페이지는 문서로 만들지 않는다. 빈 결과로 흡수하지 않고 목록에 남겨 재수집 대상으로 넘긴다.
  if (isSourceErrorPage(text)) { taintedDocs.push(rel); continue; }
  const { chunks, contentChars, truncated } = chunkDoc(stripFrontmatter(text));
  const dm = docMeta(rel);
  const parse_status = chunks.length === 0 ? 'empty' : (truncated ? 'truncated' : 'chunked');
  const covered = chunks.reduce((s, c) => s + c.length, 0);
  const coverage = contentChars ? +(Math.min(1, covered / contentChars)).toFixed(3) : 0;

  await write(docsOut, JSON.stringify({
    doc_id, corpus: 'disclosure', rel_path: rel, ...dm, ...stampOf(rel),
    ...((aliasesOf(rel) || DUP_MARK) ? { meta: { ...(aliasesOf(rel) ? { aliases: aliasesOf(rel) } : {}), ...(DUP_MARK ? dupKeys(rel, stampOf(rel).body_md5 || _md5(stripFrontmatter(text).join('\n').trim()), stripFrontmatter(text).join('\n').trim().length) : {}) } } : {}),
    ...(DOC_ID_MODE === 'stable' && doc_id !== pathId ? { key_mode: 'stable', disclosure_no: doc_id.split(':')[2], apba_id: doc_id.split(':')[1] } : {}),
    n_articles: chunks.length, coverage, parse_status,
    // 이미 계산해 놓고 출력에 안 넣던 값(2026-08-02). coverage(비율)만으로는 **절단 절대량을 복원할 수 없다** —
    // 공시 7,918건이 40청크에서 잘렸는데 몇 자가 잘렸는지 DB로 산출할 방법이 없었다.
    content_chars: contentChars, covered_chars: covered,
  }) + '\n');
  for (let i = 0; i < chunks.length; i++) {
    // PostgreSQL TEXT는 NUL(0x00)을 저장 못 함 — OCR/변환 산출물에 섞여 들어와 적재 전체가 깨진 사고(2026-07-17, 1건)
    const body = chunks[i].replace(/\u0000/g, '');
    await write(artsOut, JSON.stringify({
      doc_id, seq: i + 1, section: '본칙', chapter: null, art_no: null, art_sub: null,
      title: dm.doc_title.replace(/\u0000/g, ''), text: body, n_chars: body.length,
    }) + '\n');
  }

  stat.files++; stat.docs++; stat.chunks += chunks.length;
  if (chunks.length === 0) stat.empty++;
  if (truncated) stat.truncated++;

  if (SAMPLE && samplesShown < SAMPLE && chunks.length) {
    console.log(`\n--- 샘플 [${dm.doc_type}] ${dm.doc_title} (${chunks.length}청크) ---`);
    console.log(chunks[0].slice(0, 300));
    samplesShown++;
  }
}
// flush 완료까지 대기 — 여기서 실패하면 스테이징이 불완전하므로 반드시 비정상 종료
await Promise.all([
  new Promise((res, rej) => docsOut.end(err => err ? rej(err) : res())),
  new Promise((res, rej) => artsOut.end(err => err ? rej(err) : res())),
]);

const report = {
  ruleset: RULESET, base_files_scanned: seen, docs: stat.docs, chunks: stat.chunks,
  empty_docs: stat.empty, truncated_docs: stat.truncated, skipped_ca: stat.skippedCa,
  // 항상 기록한다 — 키가 없으면 '0건'과 '가드 미실행'이 화면상 구분되지 않는다(초판 결함).
  source_error_pages: taintedDocs.length,
  source_error_page_files: taintedDocs.slice(0, 200),
  alias_skipped: aliasSkipped,
  excluded_rule: excludedRule.length,
  excluded_rule_docs: excludedRule,
  avg_chunks_per_doc: stat.docs ? +(stat.chunks / stat.docs).toFixed(2) : 0,
};
fs.writeFileSync(path.join(OUT, 'coverage_disclosure.json'), JSON.stringify(report, null, 2));
if (process.env.MD_STAMPS_TSV) console.log(`[stamps] 매핑 ${stampHit} · 미매핑(NULL) ${stampMiss}`);
console.log('\n' + JSON.stringify(report, null, 2));
}

main().catch(e => { console.error('parse_disclosure 실패:', e); process.exit(1); });
