'use strict';
/**
 * 조문 앵커 art_key — (doc_id, art_key) 가 외부 연결(온톨로지·북마크·평가셋)의 키다. articles.id(행 번호)는 재적재마다 바뀐다.
 *
 * 규칙(결정적: 같은 문서·같은 파서 규칙이면 항상 같은 키)
 *   조문 문서(anchor_level='article'):
 *     art_no 있음 → `제N조` / `제N조의M`
 *     없음, 제목 있음 → `t:<정규화 제목>`(NFC·공백 압축·최대 80자)
 *     둘 다 없음 → `@<seq>`(문서 내 순번)
 *     부칙(section='부칙')이면 앞에 `부칙/`
 *   문서 수준 앵커(anchor_level='document': 공시 청크·ca 폴백 청크):
 *     전부 `@<seq>` — 청커 규칙·본문이 바뀌면 순번이 움직이므로 «문서 수준(doc_id+body_md5)만» 쓰라는 표시다.
 *   중복: 첫 번째는 그대로, 이후는 `#2`, `#3` … (파일 순서=seq 순서). 접미 결과가 이미 쓰였으면 다음 번호.
 */
const MAX_TITLE = 80;

function normTitle(t) {
  return String(t).normalize('NFC').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

function baseKey(a, level) {
  const seqKey = '@' + a.seq;
  if (level === 'document') return seqKey;
  let k;
  if (a.art_no != null) k = `제${a.art_no}조` + (a.art_sub != null ? `의${a.art_sub}` : '');
  else { const t = a.title ? normTitle(a.title) : ''; k = t ? 't:' + t : seqKey; }
  return a.section === '부칙' ? '부칙/' + k : k;
}

// 문서 하나의 조문 배열(seq 오름차순) → art_key 배열
function assignArtKeys(articles, level = 'article') {
  const used = new Set(), out = [];
  let prevSeq = -Infinity;
  for (const a of articles) {
    if (!(a.seq > prevSeq)) throw new Error(`art_key: seq 가 오름차순이 아님(doc ${a.doc_id}, seq ${a.seq})`);
    prevSeq = a.seq;
    const b = baseKey(a, level);
    let k = b, n = 1;
    while (used.has(k)) k = `${b}#${++n}`;
    used.add(k); out.push(k);
  }
  return out;
}

// 문서 수준 앵커 판정 — 공시 코퍼스 전부, 그리고 청커로 만든 문서(parse_status='chunked', ca 폴백 포함)
function anchorLevel(doc) {
  return doc.corpus === 'disclosure' || doc.parse_status === 'chunked' ? 'document' : 'article';
}

// 스테이징 articles JSONL 스트림(문서별로 연속·seq 오름차순) → {a, key} 스트림. 문서 경계에서만 버퍼를 비운다.
// 같은 doc_id 가 떨어져서 다시 나오면(정렬 깨짐) 중복 판정이 틀어지므로 중단한다.
async function* keyedArticles(iter, levelOf) {
  let cur = null, buf = [];
  const finished = new Set();
  const flush = function* () {
    const keys = assignArtKeys(buf, levelOf(cur));
    for (let i = 0; i < buf.length; i++) yield { a: buf[i], key: keys[i] };
    finished.add(cur); buf = [];
  };
  for await (const a of iter) {
    if (a.doc_id !== cur) {
      if (cur !== null) yield* flush();
      if (finished.has(a.doc_id)) throw new Error(`art_key: ${a.doc_id} 의 조문이 연속되어 있지 않음(스테이징 정렬 깨짐)`);
      cur = a.doc_id;
    }
    buf.push(a);
  }
  if (cur !== null) yield* flush();
}

module.exports = { assignArtKeys, anchorLevel, normTitle, keyedArticles };
