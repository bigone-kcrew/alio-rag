'use strict';
// 색인 제외 규칙(개인 기록 유형). 규칙 정본=exclude_rules.json — 파싱(parse_disclosure·parse_articles)이 파일을 «문서로 만들기 전에» 거른다.
// 기록은 경로 해시(sha1 앞 12자)와 규칙 id 만 남긴다(파일명에 이름이 있으므로 경로·이름을 로그·스테이징에 옮기지 않는다).
// ⚠️ 규칙을 늘리면 이미 적재된 문서는 DB 에서 자동으로 지워지지 않는다(delta 는 «있는 문서»만 교체) — 손으로 지울 것.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, 'exclude_rules.json'), 'utf8'))
  .map(r => ({ id: r.id, reason: r.reason, re: new RegExp(r.pattern, 'u') }));

// rel: 코퍼스 base 기준 상대 경로. 일치하면 {id, reason}, 아니면 null.
function excludeReason(rel) {
  const s = String(rel).split(path.sep).join('/');
  const r = RULES.find(x => x.re.test(s));
  return r ? { id: r.id, reason: r.reason } : null;
}
const relHash = rel => crypto.createHash('sha1').update(String(rel)).digest('hex').slice(0, 12);

// ── 재게시 별칭(2026-10-09) — DUP_MAP(=ops/dup_map_repost_*.json) 이 «있을 때만» 동작한다. 없으면 기존 동작 그대로.
// 같은 기관·항목·하위경로의 다른 회차 재게시: 대표(최근 회차)만 색인하고 별칭 경로는 대표 doc 의 meta.aliases 로 남긴다.
// 지도의 rel 은 장부 기준('자료/기관별공시/' 포함) — 파서 rel 은 이 접두를 뗀 형태. 적용 직전 ops/dup_map_guard.js 로 지도를 검증할 것.
const PFX = '자료/기관별공시/';
const ALIAS = new Set(), REP = new Map();
if (process.env.DUP_MAP) {
  for (const g of JSON.parse(fs.readFileSync(process.env.DUP_MAP, 'utf8')).list) {
    const rels = g.aliases.map(x => x.rel.replace(PFX, ''));
    rels.forEach(r => ALIAS.add(r));
    REP.set(g.representative.replace(PFX, ''), rels);
  }
}
const norm = rel => String(rel).split(path.sep).join('/');
const isAlias = rel => ALIAS.has(norm(rel));
const aliasesOf = rel => REP.get(norm(rel)) || null;

module.exports = { excludeReason, relHash, RULES, isAlias, aliasesOf };
