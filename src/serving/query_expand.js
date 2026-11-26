'use strict';
// MCPdeep: 질의 확장(동의어·약어)·소관부처 구명칭 사전. 사전은 ops 데이터 파일(data/synonyms.json, ALIO_SYNONYMS_PATH)로 분리 — 30초마다 mtime 확인해 핫리로드(실패하면 이전 표 유지).
const fs = require('fs'), path = require('path');
// 사전 위치: ALIO_SYNONYMS_PATH > 마운트 데이터 폴더의 data/synonyms.json(운영이 교체하는 ops 파일; /app/data 는 운영 마운트) > 이미지에 든 기본본 synonyms.default.json
const fileNow = () => { if (process.env.ALIO_SYNONYMS_PATH) return process.env.ALIO_SYNONYMS_PATH; const o = path.join(__dirname, 'data', 'synonyms.json'); return fs.existsSync(o) ? o : path.join(__dirname, 'synonyms.default.json'); };
let D = { groups: [], ministry_old_names: {}, ministry_notes: {} }, mtime = -1, checked = 0;   // mtime: «파일경로+mtime» 문자열(파일이 바뀌거나 경로가 바뀌어도 다시 읽음)
function dict() {
  const now = Date.now(); if (mtime !== -1 && now - checked < (+process.env.ALIO_INST_ALIAS_CHECK_MS || 30000)) return D; checked = now;
  try { const f = fileNow(), m = fs.statSync(f).mtimeMs; if (f + m !== mtime) { D = { groups: [], ministry_old_names: {}, ministry_notes: {}, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; mtime = f + m; } } catch { if (mtime === -1) mtime = 0; }
  return D;
}
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[\s·ㆍ\-_]/g, '');
const MAX_VARIANTS = 6;
/** 한 표현(키워드·검색어) → 변형 목록. 사전 표현이 «통째로 같을 때(공백·대소문자 무시)» 그 묶음의 다른 표현, 부분 포함이면 그 부분만 치환한 문장. 원문은 포함하지 않는다. */
function variantsOf(text, max = MAX_VARIANTS) {
  const t = String(text || '').trim(), lt = t.toLowerCase(), nt = norm(t), out = [];
  if (!nt) return out;
  for (const g of dict().groups) {
    const ts = (g.terms || []).map(String);
    if (ts.some(x => norm(x) === nt)) { for (const o of ts) if (norm(o) !== nt) out.push(o); continue; }
    for (const x of ts) {
      const lx = x.toLowerCase(); if (lx.length < 3 || !lt.includes(lx)) continue;
      const asciiShort = /^[a-z0-9 ]+$/.test(lx) && lx.length <= 4; if (asciiShort) continue;   // 문장 속 짧은 영문 약어는 치환 확장하지 않는다(오탐)
      for (const o of ts) if (norm(o) !== norm(x)) out.push(lt.split(lx).join(o));
      break;
    }
  }
  return [...new Set(out.filter(v => norm(v) !== nt))].slice(0, max);
}
/** terms(배열) → {terms: 원문+변형(중복 제거), expanded: [{from, added[]}]} */
function expandTerms(terms, max = 24) {
  const all = [], expanded = [], seen = new Set();
  const add = v => { const k = norm(v); if (k && !seen.has(k)) { seen.add(k); all.push(v); return true; } return false; };
  for (const t of terms) add(t);
  for (const t of terms) { const added = variantsOf(t, 12).filter(add); if (added.length) expanded.push({ from: t, added }); }
  return { terms: all.slice(0, max), expanded };
}
/** 소관부처 구명칭 → {value, from?, note?}. 입력 전체(공백 제외)가 구명칭과 같을 때만 바꾼다. */
function resolveMinistry(m) {
  if (m == null || m === '') return { value: m == null || m === '' ? null : m };
  const k = String(m).replace(/\s+/g, ''), to = dict().ministry_old_names[k];
  if (!to) return { value: m };
  const note = dict().ministry_notes[k];
  return { value: to, from: String(m), ...(note ? { note } : {}) };
}
module.exports = { variantsOf, expandTerms, resolveMinistry, norm, dict };
