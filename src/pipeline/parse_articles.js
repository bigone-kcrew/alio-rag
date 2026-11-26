#!/usr/bin/env node
/**
 * 조항 파서 (RAG/PostgreSQL 이식 1단계)
 * md 문서를 조(제N조/제N조의N) 단위로 분해해 JSONL 스테이징 파일 생성.
 *
 * 사용법:
 *   node rag/parse_articles.js legal    # legal-md 115건 (파일럿)
 *   node rag/parse_articles.js bylaws   # institution-bylaws-md 기관별내규
 *   node rag/parse_articles.js ca       # alio-md 내 단체협약 md
 *
 * 증분(일일 델타용, 2026-08-18 추가) — `parse_disclosure.js` 와 같은 규약:
 *   --since <ISO|epoch_ms>  mtime 이 그보다 최신인 md 만 파싱(신규 + 재변환·정비분 모두 잡는다)
 *   --out <dir>             스테이징 출력 override — **전체 스테이징을 덮지 않으려면 필수**
 *   ⚠️ `--since` 만 주고 `--out` 을 안 주면 `_ops/_rag_staging` 의 전체 판이 **델타로 축소**된다.
 *      그 상태로 전량 재적재를 돌리면 나머지 문서가 통째로 사라진다 — 그래서 둘을 같이 쓴다.
 *
 * 출력: _ops/_rag_staging/{docs,articles}_<corpus>.jsonl + coverage_<corpus>.json
 *  docs 레코드: doc_id, corpus, rel_path, inst_code, inst_name, ministry, category,
 *               doc_title, doc_type, doc_date, meta(frontmatter), n_articles,
 *               content_chars, covered_chars, coverage, parse_status
 *  articles 레코드: doc_id, seq, section(본칙|부칙), chapter, art_no, art_sub,
 *                   title, text, n_chars
 */
const fs = require('fs');
const path = require('path');
const { chunkDoc, stripFrontmatter, RULESET } = require('./chunk_doc');   // 규칙 세트 식별자는 청커 사본과 같은 값

const ROOT = path.join(__dirname, '..', 'data');
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

const _argv = process.argv.slice(2);
const OUT = _argv.includes('--out') ? path.resolve(_argv[_argv.indexOf('--out') + 1])
                                    : path.join(__dirname, '..', 'ops', '_rag_staging');
// --since: mtime 필터. 값이 숫자면 epoch ms, 아니면 ISO 문자열로 읽는다.
const SINCE = _argv.includes('--since')
  ? (isNaN(+_argv[_argv.indexOf('--since') + 1]) ? Date.parse(_argv[_argv.indexOf('--since') + 1]) : +_argv[_argv.indexOf('--since') + 1])
  : null;

const CORPORA = {
  legal:  { base: path.join(ROOT, 'legal-md', '법령자료'), match: f => f.endsWith('.md') },
  bylaws: { base: path.join(ROOT, 'institution-bylaws-md', '기관별내규'), match: f => f.endsWith('.md') },
  ca:     { base: path.join(ROOT, 'alio-md', '자료', '기관별공시'), match: f => f.endsWith('.md') && f.includes('단체협약') },
};

// ── 조문 경계 패턴 ─────────────────────────────────────────────
// 행 시작(선택적 md 헤더/굵게 표식) + 제N조[의M] + (제목) 또는 공백 제목
const RE_ART = /^(?:#{1,6}\s*)?(?:\*{1,2}\s*)?제\s*(\d{1,4})\s*조(?:\s*의\s*(\d{1,3}))?(?:\s*\(([^)\n]{1,80})\))?(.*)$/;
// 제목 없는 "제N조 ..."가 실은 조문 인용인 경우 배제 (예: "제3조 및 제4조에 따라")
const RE_REF_TAIL = /^\s*(?:제\d|및|또는|내지|부터|까지|에\s|의\s|와\s|과\s|은\s|는\s|을\s|를\s|이\s|가\s|에서|으로|로\s)/;
const RE_CHAPTER = /^(?:#{1,6}\s*)?(?:\*{1,2}\s*)?제\s*(\d{1,3})\s*(장|절|편|관)\s*(.*)$/;
const RE_ADDENDUM = /^(?:#{1,6}\s*)?(?:\*{1,2}\s*)?부\s?칙\s*(?:$|[<(（【[]|제\d|\d)/;

// 별표·별지·서식 경계 (2026-08-01 신설)
// 왜: 별표/별지/서식에는 「제N조」 경계가 없어서, 직전 조문(대부분 부칙)이 문서 끝까지 전부
//   흡수한다. 실측 최대 **922,890자짜리 '부칙' 청크**(한국철도공사 비유동자산 회계처리
//   시행세칙) — 임베딩은 4,000자에서 잘리므로 뒤 91.8만 자가 검색에서 사라진다.
//   내규 전체로는 15,066청크가 4,000자를 넘고 **1억 7,660만 자**가 벡터에 안 담겼다.
//   위임전결규정의 전결표처럼 노무 실무 핵심자료가 여기 묻혀 있었다.
// 오탐 방지: 본문 중 "별표 1과 같다" 같은 인용과 구분하려고 **줄머리 + (대괄호형 | 헤딩 | 짧은 줄)**
//   조건을 건다. tableMode 배타 조건과 같은 취지(문서 구조 신호가 확실할 때만 경계로 인정).
const RE_ANNEX = /^(?:#{1,6}\s*)?(?:\*{1,2}\s*)?[\[<【(]?\s*(별표|별지|서식|양식)\s*(\d{0,3})/;
const RE_ANNEX_BRACKET = /^(?:#{1,6}\s*)?(?:\*{1,2}\s*)?[\[<【(]\s*(별표|별지|서식|양식)/;
const RE_ANNEX_HEAD = /^#{1,6}\s/;
function annexBoundary(line) {
  const m = line.match(RE_ANNEX);
  if (!m) return null;
  const bare = stripMd(line).trim();
  // 대괄호로 감쌌거나 / 마크다운 헤딩이거나 / 줄 자체가 짧으면 제목 줄로 본다
  const looksHeading = RE_ANNEX_BRACKET.test(line) || RE_ANNEX_HEAD.test(line) || bare.length <= 40;
  if (!looksHeading) return null;
  return bare.replace(/\s+/g, ' ').slice(0, 80);
}

// 한 청크가 임베딩 입력 상한을 넘으면 조용히 잘리므로(embed_articles.js MAX_CHARS=4000)
// 그 전에 문단/줄 경계로 쪼갠다. 상한은 넉넉히 잡되 무한 성장만 막는 것이 목적.
const HARD_CAP = 4000;
const RE_DOCTYPE = /(시행규칙|시행령|법률|기본법|특별법|단체협약|노사합의|취업규칙|규정|지침|규칙|세칙|요령|기준|매뉴얼|가이드라인|편람|예규|고시|훈령|법)/;
// 표 형식 조문(신구조문 대비표 등) — 한 줄이 통째로 표의 한 행이라 행 시작 앵커에 걸리지 않는다(#115).
// 예: `| 개<br>정 | 제2장 조합활동<br>제14조(근로시간면제자의 구분 및 처우)<br>① … | 제14조(…)<br>… |`
// 협약 하위 p5의 42%가 이 유형이고 노조 활용가치가 가장 높은 문서(단체협약 개정 대비표)다.
// 병합·중첩 표는 kordoc이 GFM 대신 HTML <table>로 낸다 — 신구조문 대비표 다수가 이 형태다
const RE_TROW = /^\s*(?:\|.*\|\s*$|<tr[\s>])/i;          // GFM 표 행 또는 HTML <tr> 행
const RE_TSEP = /^\s*\|[\s:|-]+\|\s*$/;                  // 구분선 `| --- |`
// 셀 시작 또는 <br> 직후에 오는 `제N조(제목)` — 문장 속 인용("제3조에 따라")과 구분하려고 제목 괄호를 요구한다
// 제목에 `|`가 있으면 변환 과정에서 조 제목이 셀 경계에 걸쳐 쪼개진 것이다 — 경계로 삼지 않는다
// (실측: 그런 행을 조문으로 잡으면 제목이 "공시자료의 | 점검·확인"처럼 깨지고 coverage가 오히려 떨어진다).
const RE_TART = /(?:^\s*\||<br\s*\/?>|<t[dh][^>]*>|\|)\s*제\s*(\d{1,4})\s*조(?:\s*의\s*(\d{1,3}))?\s*[（(]([^)）\n|]{1,80})[)）]/i;

function stripMd(s) { return s.replace(/\*{1,2}/g, '').trim(); }

// ── HTML 잡음(임베딩·검색용 본문 text 에만 적용. off 는 원문 md 기준이라 영향 없음) ─────────────
// ⚠️ parse_disclosure.js 의 htmlNoise 와 같은 규칙 — 한쪽만 고치지 말 것(_test_parse_table.js 가 동일성 검사).
//  · 변환기 이력 주석(<!-- source/converted_at/ocr -->)은 본문·contentChars 어디에도 넣지 않는다 →
//    머리말·꼬리 주석을 지운 md 와 안 지운 md 가 같은 조문·같은 text_hash 를 낸다.
//  · 태그는 «알려진 HTML 태그»만 지운다(`<137>`·`<개정 2020.1.1>`·`<MBC>` 는 본문). 종전 `<[^>]+>` 는 이것까지 지웠다.
//  · 엔티티는 태그 제거 뒤에 푼다. &amp; 는 마지막.
const RE_COMMENT_LINE = /^\s*(?:<!--.*?-->\s*)+$/;
const HTML_COMMENT = /<!--.*?-->/g;
const HTML_BLOCK = /<\/?(?:table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|hr|p|div|ul|ol|li)(?=[\s/>])[^>]*>/gi;
const HTML_INLINE = /<\/?(?:span|sup|sub|font|strong|em|img)(?=[\s/>])[^>]*>/gi;
const HTML_ENT = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'" };
const entCp = cp => (cp >= 32 && cp < 0x110000 && !(cp >= 0x7f && cp < 0xa0) && !(cp >= 0xd800 && cp < 0xe000)) ? String.fromCodePoint(cp) : ' ';
function stripTags(s, br) {           // 주석·태그만(엔티티는 건드리지 않음 — 이중 디코드 방지)
  return s.replace(HTML_COMMENT, '').replace(/<br\s*\/?>/gi, br).replace(HTML_BLOCK, ' ').replace(HTML_INLINE, '');
}
function decodeEnt(s) {
  return s.replace(/&(nbsp|lt|gt|quot|apos);|&#(\d{1,7});|&#x([0-9a-f]{1,6});/gi,
      (m, n, d, x) => n ? HTML_ENT[n.toLowerCase()] : entCp(d ? +d : parseInt(x, 16)))
    .replace(/&amp;/g, '&');
}
// 표 행을 읽을 수 있는 본문으로 편다 — <br>은 줄바꿈, 셀 구분은 개행. 엔티티는 flush 에서 한 번만 푼다.
function tableText(line) {
  const cells = /<t[dh][\s>]/i.test(line)
    ? line.split(/<\/?t[dhr][^>]*>/i)                       // HTML 표: 셀 태그로 자른다
    : line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
  return cells.map(c => stripTags(c, '\n').trim())
    .filter(Boolean).join('\n').trim();
}
// 표 모드가 아닌 문서의 본문 한 줄 → 태그 정리된 줄(여러 줄일 수 있음). 정리 결과가 빈데 원문이 비지 않았으면 '' 대신 null
// (`<tr>`·`<table>` 같은 구조 태그만 있는 줄이 빈 줄=문단 경계로 둔갑하지 않게).
function bodyLine(line) {
  if (!/[<&]/.test(line)) return line;
  const c = /<t[dh][\s>]/i.test(line) ? tableText(line) : stripTags(line, '\n').replace(/[ \t]+$/, '');
  return (c.trim() === '' && line.trim() !== '') ? null : c;
}

function parseFrontmatter(lines) {
  if (lines[0] !== '---') return { meta: null, bodyStart: 0 };
  for (let i = 1; i < Math.min(lines.length, 40); i++) {
    if (lines[i] === '---') {
      const meta = {};
      for (let j = 1; j < i; j++) {
        const m = lines[j].match(/^(\w[\w_]*):\s*'?(.*?)'?\s*$/);
        if (m) meta[m[1]] = m[2];
      }
      return { meta, bodyStart: i + 1 };
    }
  }
  return { meta: null, bodyStart: 0 };
}

function parseDoc(text) {
  const lines = text.split(/\r?\n/);
  const { meta, bodyStart } = parseFrontmatter(lines);
  const articles = [];
  let cur = null, chapter = '', section = '본칙';
  let contentChars = 0;

  // \ub77c\uc778\ubcc4 \uc6d0\ubb38 char offset (\ubdf0\uc758 "md fetch+\uc2ac\ub77c\uc774\uc2a4"\uc6a9 \u2014 CRLF \ud3ec\ud568 \uc6d0\ubb38 \ubb38\uc790\uc5f4 \uae30\uc900)
  const lineOffs = new Array(lines.length);
  {
    let li = 0;
    const re = /\r?\n/g; let mm;
    lineOffs[0] = 0;
    while ((mm = re.exec(text)) && li + 1 < lines.length) { lineOffs[++li] = mm.index + mm[0].length; }
  }

  const flush = (endOff) => {
    if (!cur) return;
    // 본문 정리: 줄 단위로 태그·주석을 걷고(bodyLine) 엔티티를 한 번 푼다. 표 모드의 buf 는 이미 tableText 결과(태그 없음).
    cur.text = decodeEnt(cur.buf.join('\n').split('\n').map(bodyLine).filter(l => l !== null).join('\n'))
      .replace(/[\u2028\u2029\u0085]/g, '\n').trim();
    cur.n_chars = cur.text.length;
    delete cur.buf;
    if (cur._s != null) { cur.off = [cur._s, endOff != null ? endOff : text.length]; delete cur._s; }
    if (cur.n_chars <= 0) { cur = null; return; }

    if (cur.n_chars <= HARD_CAP) { articles.push(cur); cur = null; return; }

    // \uc0c1\ud55c \ucd08\uacfc \u2192 \uc904 \uacbd\uacc4\ub85c \ubd84\ud560\ud574 \uc804\ub7c9\uc744 \uc784\ubca0\ub529 \ub300\uc0c1\uc73c\ub85c \ub0a8\uae34\ub2e4(\uc885\uc804\uc5d4 4,000\uc790 \ub4a4\uac00 \uc720\uc2e4).
    // art_no/title\uc740 \uc720\uc9c0\ud558\uace0 2\ud3b8 \uc774\uc0c1\uc77c \ub54c\ub9cc \uc81c\ubaa9\uc5d0 (n/N)\uc744 \ubd99\uc5ec \uc778\uc6a9 \uc2dc \uad6c\ubd84\ud55c\ub2e4.
    const parts = [];
    let acc = [], len = 0;
    for (const ln of cur.text.split('\n')) {
      // \ud55c \uc904 \uc790\uccb4\uac00 \uc0c1\ud55c\uc744 \ub118\uc73c\uba74(\uac70\ub300 HTML \ud45c \ub4f1) \uadf8 \uc904\ub9cc \ubb38\uc790 \ub2e8\uc704\ub85c \ucabc\uac20\ub2e4
      if (ln.length > HARD_CAP) {
        if (acc.length) { parts.push(acc.join('\n')); acc = []; len = 0; }
        for (let p = 0; p < ln.length; p += HARD_CAP) parts.push(ln.slice(p, p + HARD_CAP));
        continue;
      }
      if (len + ln.length + 1 > HARD_CAP && acc.length) { parts.push(acc.join('\n')); acc = []; len = 0; }
      acc.push(ln); len += ln.length + 1;
    }
    if (acc.length) parts.push(acc.join('\n'));

    // ⚠️ 편별 증거 스팬(off)을 따로 계산한다 — `{...cur}` 만 하면 **모든 편이 원 조문 전체 범위**를
    //    가리킨다(2026-08-12 전수 실측: 분할 그룹 10,468 중 10,428=99.6% 가 그 상태였다).
    //    온톨로지 설계안 §5 G4(증거 스팬)가 이 값을 전제로 하므로 부정확하면 스팬 기반 기능이 성립하지 않는다.
    //    본문(text)·text_hash 는 바뀌지 않으므로 **재임베딩과 무관**하다.
    //    방법: 원문 구간에서 각 편의 첫 줄을 앞에서부터 찾아 시작점을 잡고, 끝은 다음 편의 시작점으로 둔다.
    //    못 찾으면(정규화로 문자열이 어긋난 경우) 그 편만 원 조문 전체 범위로 폴백한다 — 추측하지 않는다.
    const artStart = cur.off ? cur.off[0] : null;
    const artEnd = cur.off ? cur.off[1] : null;
    let starts = null;
    if (artStart != null) {
      const src = text.slice(artStart, artEnd);
      let cursor = 0;
      starts = parts.map((t) => {
        const head = (t.split('\n').find((l) => l.trim()) || '').trim();
        if (!head) return null;
        const rel = src.indexOf(head, cursor);
        if (rel < 0) return null;
        cursor = rel + head.length;
        return artStart + rel;
      });
      if (starts.some((s) => s == null)) starts = null;   // 하나라도 실패하면 편별 스팬을 주장하지 않는다
    }

    parts.forEach((t, idx) => {
      const a = {
        ...cur,
        seq: articles.length + 1,
        title: parts.length > 1 && cur.title ? `${cur.title} (${idx + 1}/${parts.length})` : cur.title,
        text: t,
        n_chars: t.length,
      };
      if (starts) a.off = [starts[idx], idx + 1 < starts.length ? starts[idx + 1] : artEnd];
      articles.push(a);
    });
    cur = null;
  };

  // 표 모드: 「제N조(제목)」을 담은 표 행이 3개 이상이면서, **본문에는 조문이 사실상 없는** 문서만
  // 표로 조문을 적은 문서(신구조문 대비표 등)로 본다.
  // 본문 조문이 이미 있는 문서에서 표까지 훑으면 표 안의 법령 인용(「국민체육진흥법」제14조…)을
  // 조문으로 오인해 coverage가 오히려 떨어진다(실측 2건). 그래서 문서 단위로 배타 적용한다.
  const body = lines.slice(bodyStart);
  const plainArts = body.filter(l => !RE_TROW.test(l) && RE_ART.test(l)).length;
  const tableArts = body.filter(l => RE_TROW.test(l) && RE_TART.test(l)).length;
  const tableMode = tableArts >= 3 && plainArts < 3;

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    if (RE_COMMENT_LINE.test(line)) continue;                 // 변환기 이력 주석 줄: 조문·contentChars 어디에도 넣지 않는다
    // 표 행은 마크업(`|`)을 뺀 길이로 센다 — 파이프까지 분모에 넣으면 coverage가 실제보다 낮게 나온다
    const isTRow = tableMode && RE_TROW.test(line);
    // 분모도 text 와 같은 정리 기준(태그 제거 후)으로 센다 — 안 그러면 태그 마크업이 분모에만 남아 coverage 가 내려간다
    contentChars += isTRow ? (RE_TSEP.test(line) ? 0 : tableText(line).length) : (bodyLine(line) ?? '').trim().length;

    if (isTRow) {
      if (RE_TSEP.test(line)) continue;                       // 구분선은 버린다
      const tm = line.match(RE_TART);
      if (tm) {
        // 표 한 행 = 조문 한 건. 신구조문 대비표는 같은 행에 현행·개정안이 나란히 있고
        // 그 대조 자체가 정보라서 행을 쪼개지 않고 통째로 담는다(제목·조번호는 첫 조문에서 딴다).
        flush(lineOffs[i]);
        cur = {
          seq: articles.length + 1, section, chapter,
          art_no: parseInt(tm[1], 10), art_sub: tm[2] ? parseInt(tm[2], 10) : null,
          title: stripMd(decodeEnt(stripTags(tm[3], ' '))).replace(/\s+/g, ' '),
          buf: [tableText(line)], _s: lineOffs[i],
        };
        continue;
      }
      if (cur) cur.buf.push(tableText(line));                 // 조문 없는 행(머리행 등)은 앞 조문에 붙인다
      continue;
    }

    // 별표·별지·서식 = 새 청크 경계. 부칙 뒤에 붙어 문서 끝까지 흡수되던 문제를 여기서 끊는다.
    const annex = annexBoundary(line);
    if (annex) {
      flush(lineOffs[i]);
      section = '별표'; chapter = '';
      // 제목 줄 내용도 본문에 남긴다(부칙 핸들러와 동일). 비우면 그 줄 문자가 coverage에서 빠져
      // 별표가 많은 문서일수록 coverage가 내려간다(실측: 표본 300건 중 179건 하락).
      cur = { seq: articles.length + 1, section, chapter, art_no: null, art_sub: null,
              title: annex, buf: [stripMd(line)], _s: lineOffs[i] };
      continue;
    }

    if (RE_ADDENDUM.test(line)) {
      flush(lineOffs[i]); section = '부칙'; chapter = '';
      // 부칙 전문이 한 줄(또는 이어지는 줄들)에 담긴 경우도 청크로 수집
      cur = { seq: articles.length + 1, section, chapter, art_no: null, art_sub: null,
              title: '부칙', buf: [stripMd(line).replace(/^부\s?칙\s*/, '')], _s: lineOffs[i] };
      continue;
    }
    const ch = line.match(RE_CHAPTER);
    if (ch) { flush(lineOffs[i]); chapter = '제' + ch[1] + ch[2] + (ch[3] ? ' ' + stripMd(ch[3]) : ''); continue; }

    const m = line.match(RE_ART);
    if (m) {
      const title = m[3] ? stripMd(m[3]) : '';
      const tail = m[4] || '';
      // 제목 괄호가 없고 꼬리가 조문 인용 형태면 경계로 보지 않음
      if (!title && RE_REF_TAIL.test(tail)) {
        if (cur) cur.buf.push(line);
        continue;
      }
      flush(lineOffs[i]);
      cur = {
        seq: articles.length + 1, section, chapter,
        art_no: parseInt(m[1], 10), art_sub: m[2] ? parseInt(m[2], 10) : null,
        title, buf: [], _s: lineOffs[i],
      };
      const rest = title ? tail.trim() : stripMd(tail);
      if (!title && rest) { // "제1조 목 적" 형태: 짧으면 제목, 길면 본문
        if (rest.length <= 30 && !/[.다]$/.test(rest)) { cur.title = rest; }
        else cur.buf.push(rest);
      } else if (rest) cur.buf.push(rest);
      continue;
    }
    if (cur) cur.buf.push(line);
  }
  flush();
  const covered = articles.reduce((s, a) => s + a.n_chars, 0);
  return { meta, articles, contentChars, covered };
}

// ── 코퍼스별 메타 추출 ─────────────────────────────────────────
function docMeta(corpus, rel, meta) {
  const d = { inst_code: null, inst_name: null, ministry: null, category: null, doc_date: null };
  const base = path.basename(rel, '.md');
  if (corpus === 'legal') {
    d.category = rel.split('/')[0];
    d.ministry = (meta && (meta.ministry || meta.authority)) || null;
    d.doc_title = (meta && meta.title) || base;
    d.doc_date = (meta && (meta.effective_date || meta.amended_at)) || null;
  } else {
    const seg = rel.split('/')[0]; // [부처]기관명_C0000
    const m = seg.match(/^\[([^\]]+)\](.+)_(C\d+)$/);
    if (m) { d.ministry = m[1]; d.inst_name = m[2]; d.inst_code = m[3]; }
    const dm = base.match(/_(\d{8})$/) || base.match(/(\d{4})년/);
    if (dm) d.doc_date = dm[1];
    d.doc_title = base.replace(/_\d{8}$/, '');
  }
  const t = d.doc_title.match(RE_DOCTYPE);
  d.doc_type = corpus === 'ca' ? '단체협약' : (t ? t[1] : '기타');
  return d;
}

// ca 폴백 청커 = parse_disclosure.js 와 같은 chunkDoc 사본(chunk_doc.js). ⚠️ 한쪽만 고치지 말 것.
function caFallback(text, docTitle) {
  const lines = stripFrontmatter(text);
  const body = lines.join('\n');
  const hang = (body.match(/[가-힣]/g) || []).length;
  const ns = body.replace(/<[^>]+>/g, '').replace(/[|\s]/g, '').length || 1;
  // 변환 잡음(폰트 인코딩 깨짐 등 한글비율<5%)은 색인을 오염시키므로 제외 — no_articles 로 남겨 재변환(OCR) 대상으로 넘긴다.
  if (hang < 30 || (ns >= 200 && hang / ns < 0.05)) return null;
  const { chunks, contentChars: cc } = chunkDoc(lines);
  {
    const articles = chunks.map((t, i) => ({ seq: i + 1, section: '본칙', chapter: null, art_no: null, art_sub: null,
      title: docTitle, text: t.replace(/\u0000/g, ''), n_chars: t.replace(/\u0000/g, '').length }));
    const covered = articles.reduce((s, a) => s + a.n_chars, 0);
    if (covered < 100) return null;                      // «해당 사항이 없는 항목입니다» 등 안내문 제외
    return { articles, contentChars: cc, covered };
  }
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

// ── 메인 ──────────────────────────────────────────────────────
const corpus = process.argv[2];
if (!CORPORA[corpus]) { console.error('사용법: node parse_articles.js <legal|bylaws|ca>'); process.exit(1); }
const { base, match } = CORPORA[corpus];
fs.mkdirSync(OUT, { recursive: true });

const docsOut = fs.createWriteStream(path.join(OUT, `docs_${corpus}.jsonl`));
const artsOut = fs.createWriteStream(path.join(OUT, `articles_${corpus}.jsonl`));
const stat = { fallback: 0, docs: 0, withArticles: 0, articles: 0, coverageSum: 0, zero: [], low: [] };

// ── 소스 장애 페이지 배제 (2026-08-01 신설 · 2026-08-02 조건 축소) ─────────────
// 사고: ALIO 상세 페이지가 장애일 때 HTTP 200으로 안내 페이지를 반환하고, 수집기가 그걸
//   공시 본문으로 저장했다(610건). 그래서 적재 단계에도 방어를 둔다.
//
// ⚠️ **초판 조건은 틀렸다.** 「보고서 구조 표지(report_logo|보고서명|문서목차) 부재」를
//   오염 신호로 넣었는데, 전수 스캔에서 **162,404건 중 146,915건(90.5%)이 마커 부재**였다.
//   alio-md의 md 대부분은 **첨부 변환본**이라 그런 마커가 애초에 없다.
//   초판 검증이 "오탐 0"이라고 한 것은 `content.md` 1,132건만 본 것이었고,
//   그 부류는 상세페이지 HTML에서 왔으므로 마커를 갖는다 — **표본 집단을 잘못 골랐다.**
//   그 조건을 살려두면 disclosure 코퍼스 90%가 배제된다.
// → 판정은 **장애 문구 단독**으로 한다. 전수 실측 매치 7건(전부 408바이트).
//   문구가 바뀌면 새어 나가지만, 정상 문서를 대량 버리는 위험이 훨씬 크다.
const SRC_ERROR_PHRASES = /서비스에 접속할 수 없습니다|기술적인 문제로 일시적/;
const isSourceErrorPage = (text) => SRC_ERROR_PHRASES.test(String(text || ''));
const tainted = [];
const { excludeReason, relHash } = require('./exclude_rules');
const excludedRule = [];   // 색인 제외 규칙에 걸린 문서 {h: 경로 sha1[:12], rule, reason} — 경로·이름은 남기지 않는다

let _skippedOld = 0;
for (const abs of walk(base)) {
  if (!match(abs)) continue;
  // 증분: mtime 이 기준보다 오래된 파일은 건너뛴다. 파일 통계 실패는 «오래됨»으로 보지 않는다
  //   — 못 읽은 것과 안 바뀐 것을 섞으면 조용히 빠진다(이 저장소가 여러 번 밟은 유형).
  if (SINCE != null) {
    let mt = null;
    try { mt = fs.statSync(abs).mtimeMs; } catch { mt = null; }
    if (mt != null && mt < SINCE) { _skippedOld++; continue; }
  }
  const rel = path.relative(base, abs);
  { const ex = excludeReason(rel); if (ex) { excludedRule.push({ h: relHash(rel), rule: ex.id, reason: ex.reason }); continue; } }   // 색인 제외(개인 기록) — seen·LIMIT 에 넣지 않는다
  const text = fs.readFileSync(abs, 'utf8');
  // 장애 페이지는 문서로 만들지 않는다(빈 결과로 흡수하지 않고 목록에 남겨 재수집 대상으로 넘긴다).
  if (isSourceErrorPage(text)) { tainted.push(rel); continue; }
  let { meta, articles, contentChars, covered } = parseDoc(text);
  const dm = docMeta(corpus, rel, meta);
  // ca 비조문 폴백(2026-10-06): 조문(제N조)이 없는 협약 부속문서(합의서·의결서·회의록·개정요약)는
  //   공시 파서가 단체협약 경로를 건너뛰므로(parse_disclosure.js) 여기서 못 받으면 어느 코퍼스에도 청크가 없다.
  let fallback = false;
  if (articles.length === 0 && corpus === 'ca' && !_argv.includes('--no-ca-fallback')) {
    const fb = caFallback(text, dm.doc_title);
    if (fb) { articles = fb.articles; contentChars = fb.contentChars; covered = fb.covered; fallback = true; }
  }
  const doc_id = `${corpus}:${rel}`;
  const coverage = contentChars ? +(covered / contentChars).toFixed(3) : 0;
  const parse_status = fallback ? 'chunked' : articles.length === 0 ? 'no_articles' : coverage < 0.5 ? 'low_coverage' : 'ok';

  docsOut.write(JSON.stringify({
    doc_id, corpus, rel_path: rel, ...dm, ...stampOf(rel), meta: corpus === 'legal' ? meta : undefined,
    n_articles: articles.length, content_chars: contentChars, covered_chars: covered,
    coverage, parse_status,
  }) + '\n');
  for (const a of articles) artsOut.write(JSON.stringify({ doc_id, ...a }) + '\n');

  stat.docs++; stat.articles += articles.length;
  if (fallback) stat.fallback++;
  else if (articles.length) { stat.withArticles++; stat.coverageSum += coverage; }
  if (parse_status === 'no_articles') stat.zero.push(rel);
  else if (parse_status === 'low_coverage') stat.low.push(rel);
}
docsOut.end(); artsOut.end();

const report = {
  ruleset: RULESET, corpus, docs: stat.docs, docs_with_articles: stat.withArticles,
  docs_fallback_chunked: stat.fallback, docs_no_articles: stat.zero.length, docs_low_coverage: stat.low.length,
  articles: stat.articles,
  avg_coverage_of_parsed: stat.withArticles ? +(stat.coverageSum / stat.withArticles).toFixed(3) : 0,
  no_articles_samples: stat.zero.slice(0, 20), low_coverage_samples: stat.low.slice(0, 20),
  // 배제한 소스 장애 페이지 — 0이 아니면 **재수집이 필요하다는 신호**다. 조용히 넘기지 않는다.
  source_error_pages: tainted.length,
  source_error_page_files: tainted,
  excluded_rule: excludedRule.length,
  excluded_rule_docs: excludedRule,
  // 증분 실행 표시 — 이 필드가 있으면 **전량이 아니라 델타 판**이다. 없으면 전량.
  //   (스테이징만 보고 «문서가 줄었다»고 오독하는 것을 막는다.)
  incremental_since: SINCE != null ? new Date(SINCE).toISOString() : null,
  skipped_older: SINCE != null ? _skippedOld : null,
};
fs.writeFileSync(path.join(OUT, `coverage_${corpus}.json`), JSON.stringify(report, null, 2));
if (process.env.MD_STAMPS_TSV) console.log(`[stamps] 매핑 ${stampHit} · 미매핑(NULL) ${stampMiss}`);
console.log(JSON.stringify(report, null, 2));
