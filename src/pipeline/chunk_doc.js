'use strict';
// ca 비조문 폴백용 문단 누적 청커 — parse_disclosure.js(청크 패치 v2 적용본) 의 상수·stripFrontmatter·htmlNoise·cleanLine·chunkDoc 을
// 그대로 옮긴 «동일 사본»이다(2026-10-06). ⚠️ parse_disclosure.js 의 해당 구간을 고치면 여기도 같이 고칠 것
// (후속 과제: parse_disclosure.js 가 이 파일을 require 하도록 정리).
const fs = require('fs');
const path = require('path');
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

module.exports = { chunkDoc, stripFrontmatter, RULESET };
