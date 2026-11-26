'use strict';
/**
 * 표 청크 머리글 부착(G2-C). 표 문서는 열 이름이 1번 청크에만 있고 2번째 이후 청크에는 «표 제목 행(rows[0])» 만 반복된다(rag_next/chunk_doc.js).
 * 그래서 응답 행(공시 표 청크)의 첫 줄이 1번 청크의 어느 줄과 같으면(= 반복된 제목 행) 그 줄 다음의 «데이터 행 이전» 줄들(최대 3줄·400자)을 table_header 로 붙인다.
 * 1번 청크 자신·반복 제목 행이 없는 청크(산문 문서)는 건드리지 않는다. 열 이름을 못 찾으면 키를 달지 않는다. ATTACH_TABLE_HEADER=off 로 끈다(기본 on).
 * 조회는 응답 행의 doc_id 묶음당 1회(SELECT … seq=1), 프로세스 내 LRU 캐시. 실패는 삼키지 않고 note 로 돌려준다(검색 결과는 유지).
 */
const ON = () => process.env.ATTACH_TABLE_HEADER !== 'off';
const CACHE_MAX = 3000, MAX_LINES = 3, MAX_CHARS = 400;
// 데이터 행 판정: 숫자로 시작(번호 열) · 소수 토큰 · 정수 토큰 3개 이상 — 머리글 줄에는 보통 없다(연도 열 «2024 2025» 처럼 정수 2개까지는 허용)
const isDataLine = l => /^\d+[\s.]/.test(l) || /(^|\s)\d+\.\d+(\s|$)/.test(l) || (l.match(/(^|\s)\d+(?=\s|$)/g) || []).length >= 3;
// ── c6(TABLE_HEADER_V2=on): 제목 행 반복이 없는 표 청크(공백 나열·파이프 이어붙임 — 20905·21021 외 31601·70451·21311 등)용 «1번 청크 열 이름 줄» 추정 ──
// 진단(2026-11-24 실측 40문서/코드): 기존 headerFrom 은 «2번째 청크 첫 줄 = 1번 청크의 어느 줄» 일 때만 붙는데, 이 코드들은 첫 줄 반복이 0건(적용 범위 문제, 머리글 감지 실패 아님).
// 추정 규칙: 1번 청크 앞 16줄에서 «열 이름 줄»(3토큰 이상·순수 숫자 토큰 25% 이하·문장 종결 아님) 바로 다음 줄이 데이터 줄(숫자 포함)인 첫 줄. 구분자·본문은 바꾸지 않고 별도 필드로만 준다.
const V2 = () => process.env.TABLE_HEADER_V2 === 'on';
const toks = l => l.split(/[\s|]+/).filter(Boolean), numTok = t => /^[\d.,\-–~%()]+$/.test(t);
const headerLike = l => { const t = toks(l); return t.length >= 3 && l.length <= 200 && t.filter(numTok).length / t.length <= 0.25 && !/[.。다요함음]$/.test(l.trim()) && !/^[□○ㅇ※·\-•]/.test(l.trim()); };
const dataLike = l => /\d/.test(l || '') && (toks(l).filter(numTok).length >= 2 || /^\s*\|/.test(l));
/** 청크1 + 행 본문 → {text, source, confidence} | null. 1) 제목 행 반복(high) 2) 1번 청크 열 이름 줄 추정(medium: 다음 줄이 파이프·숫자 표 행 / low: 숫자 포함 줄) */
const numCount = l => toks(l).filter(numTok).length;
const cols = l => /^\s*\|/.test(l) ? l.split('|').map(x => x.trim()).filter(Boolean).length : toks(l).length;
const CONTACT_TBL = /(작성자|담당자|감독자|확인자|연락처|전화|TEL|Tel|FAX|팩스|성명|이메일|E-?mail|내선)/;   // 연락처·담당자 표: 머리글을 덧붙이면 개인 연락처 열 이름이 붙어 오해·노출 위험
function headerFor(chunk1, rowBody) {
  const h = headerFrom(chunk1, rowBody); if (h) return { text: h, source: 'title_repeat', confidence: 'high' };
  if (!V2()) return null;
  if (CONTACT_TBL.test(String(rowBody || '').slice(0, 300)) || CONTACT_TBL.test(String(chunk1 || '').slice(0, 600))) return null;   // c8
  const c1 = String(chunk1 || ''), rb = String(rowBody || '');
  if (!rb || c1.slice(0, 80) === rb.slice(0, 80)) return null;                      // 1번 청크 자신
  const rl = rb.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3);
  const myRow = rl.find(l => numCount(l) >= 3 || (/^\s*\|/.test(l) && cols(l) >= 3));
  if (!myRow) return null;                                                           // 이 청크가 표 행(숫자·대시 3토큰 이상, 또는 파이프 3칸 이상)처럼 보일 때만 — 산문·주석 청크에는 붙이지 않는다
  if (rl.some((l, i) => headerLike(l) && dataLike(rl[i + 1]))) return null;           // 이 청크가 이미 자기 머리글을 가짐
  const lines = c1.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 16);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!headerLike(lines[i]) || !dataLike(lines[i + 1])) continue;
    // 1번 청크도 «표» 여야 한다(키-값·산문 문서 배제): 아래 3줄 중 표 행 2줄 이상 / 숫자 6토큰 이상 넓은 행 1줄 / 파이프 3칸 이상 행
    const below = lines.slice(i + 1, i + 4), tab = below.filter(l => numCount(l) >= 3).length, wide = below.some(l => numCount(l) >= 6), pipe = /^\s*\|/.test(lines[i + 1]) && cols(lines[i + 1]) >= 3;
    if (!(tab >= 2 || wide || pipe)) continue;
    if (Math.abs(cols(lines[i]) - cols(myRow)) > 2) continue;                          // 열 수가 크게 다르면 다른 표의 머리글
    const t = lines[i].length > 300 ? lines[i].slice(0, 300) + '…' : lines[i];
    if (rb.includes(t)) return null;
    return { text: t, source: 'chunk1_heuristic', confidence: pipe || wide || tab >= 2 ? 'medium' : 'low' };
  }
  return null;
}
const cache = new Map();   // doc_id → 1번 청크 앞 1500자('' = 없음). Map 삽입순서로 LRU 근사
const stats = { calls: 0, queries: 0, ms: 0, docs: 0, attached: 0 };

/** 순수 함수: 1번 청크 본문 + 행 본문 → 머리글 문자열 | null */
function headerFrom(chunk1, rowBody) {
  const lines = String(chunk1 || '').split('\n').map(l => l.trim());
  const first = String(rowBody || '').split('\n')[0].trim();
  if (!first || lines.length < 3) return null;
  const k = lines.slice(0, 8).findIndex(l => l === first);
  if (k < 0) return null;                                   // 제목 행 반복이 없다 — 표 연속 청크가 아님
  const head = [];
  for (const l of lines.slice(k + 1, k + 1 + MAX_LINES)) {
    if (!l || isDataLine(l)) break;
    head.push(l);
  }
  if (!head.length) return null;
  const text = head.join('\n');
  if (String(rowBody).includes(text)) return null;          // 이 행이 이미 머리글을 담고 있다(1번 청크)
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '…' : text;
}

/** rows 의 공시 행에 table_header 부착. idOf(row) → documents.doc_id. 반환 {rows, note} (키는 추가만, 순서·개수 불변) */
async function attachTableHeaders(run, rows, idOf) {
  if (!ON()) return { rows, note: null };
  const t0 = Date.now(); stats.calls++;
  const want = new Map();
  for (const r of rows) {
    if (r.corpus !== 'disclosure' || !r.body) continue;
    const id = idOf(r); if (id) want.set(id, 1);
  }
  const need = [...want.keys()].filter(id => !cache.has(id));
  let note = null;
  if (need.length) {
    try {
      stats.queries++; stats.docs += need.length;
      const got = await run(`SELECT doc_id, left(body, 1500) AS body FROM articles WHERE doc_id = ANY($1::text[]) AND seq = 1`, [need]);
      const m = new Map(got.map(x => [x.doc_id, x.body]));
      for (const id of need) { cache.set(id, m.get(id) || ''); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }
    } catch (e) { note = 'table_header 조회 실패: ' + String(e.message).slice(0, 80); }
  }
  const out = rows.map(r => {
    if (r.corpus !== 'disclosure' || !r.body) return r;
    const c1 = cache.get(idOf(r)); if (!c1) return r;
    const h = headerFor(c1, r.body);
    if (!h) return r;
    stats.attached++;
    return { ...r, table_header: h.text, ...(h.source !== 'title_repeat' ? { header_source: h.source, header_confidence: h.confidence } : {}) };   // 기존(제목 행 반복) 부착은 응답 바이트 불변
  });
  stats.ms += Date.now() - t0;
  return { rows: out, note };
}
module.exports = { attachTableHeaders, headerFrom, headerFor, v2On: V2, stats, _cache: cache };
