'use strict';
// 질의 속 기관명 → inst 필터 값(결정론, LLM 없음). PREREG §2 규칙 그대로. 모호(후보 2곳 이상)·복수 기관·일반어 단독이면 null.
// extract(q) → { inst: 정식명|null, code, via: 'full'|'alias'|'variant'|null, span, skip: 'ambiguous'|'multi'|'generic'|null, keywordStripped }
const fs = require('fs'), path = require('path');
const LIST = JSON.parse(fs.readFileSync(process.env.IF_INST_LIST || path.join(__dirname, 'inst_list.json'), 'utf8'));
const ALIAS = JSON.parse(fs.readFileSync(process.env.ALIO_INST_ALIAS_PATH || path.join(__dirname, 'inst_alias.json'), 'utf8'));
const sp = s => String(s).replace(/\s+/g, '');
const nz = s => sp(String(s).replace(/\([^)]*\)/g, '').replace(/[·ㆍ]/g, ''));   // 괄호((주)·(재))·가운뎃점 제거 정규화 — 이름·질의 양쪽에 동일 적용
const JOSA = /(에서의|으로|에서|에게|부터|까지|이라|이란|은|는|이|가|을|를|와|과|의|에|도|만|랑|이나|께서|보다)$/;
const GENERIC = new Set(['공단', '공사', '재단', '연구원', '연구소', '진흥원', '협회', '병원', '대학교', '위원회', '한국', '공제회', '센터', '학교', '법인', '재단법인', '한국공단', '한국공사']);
const LEAD = /^(한국|대한|국립|서울|\(재\)|\(주\)|\(사\)|\(재\)|\(제\)|재단법인|학교법인|사단법인)/;
const strip = n => n.replace(/\([^)]*\)/g, '');                     // 괄호 표기 제거
const byFull = new Map(), byVar = new Map();                         // 이름(공백제거) → code, 변형 → Set(code)
for (const it of LIST) {
  const full = nz(it.name); byFull.set(full, it);
  const base = nz(it.name), v = new Set([base.replace(/주식회사$/, '')]); v.add(base.replace(LEAD, '').replace(/주식회사$/, ''));
  const parts = strip(it.name).trim().split(/\s+/); if (parts.length > 1) v.add(nz(parts[parts.length - 1]));   // «국민건강보험공단 일산병원» → 일산병원
  for (const x of v) if (x.length >= 3 && x !== full && !GENERIC.has(x)) { if (!byVar.has(x)) byVar.set(x, new Set()); byVar.get(x).add(it.code); }
}
const byCode = new Map(LIST.map(i => [i.code, i]));
const aliasN = new Map(Object.entries(ALIAS).map(([k, v]) => [nz(k), nz(v)]));
const stripJosa = w => { const s = w.replace(JOSA, ''); return s.length >= 2 ? s : w; };
const clean = w => nz(w).replace(/[,.()?!"'‘’“”]/g, '');
function lookup(c) {            // 한 span → {codes:Set, via} | null
  const forms = [...new Set([c, stripJosa(c)])];
  for (const f of forms) { if (GENERIC.has(f)) return { generic: true }; }
  for (const f of forms) if (byFull.has(f)) return { codes: new Set([byFull.get(f).code]), via: 'full' };   // 정식명 정확 일치가 최우선(자식 기관 포함 접두 충돌 방지)
  for (const f of forms) if (aliasN.has(f) && byFull.has(aliasN.get(f))) return { codes: new Set([byFull.get(aliasN.get(f)).code]), via: 'alias' };
  for (const f of forms) if (byVar.has(f)) return { codes: byVar.get(f), via: 'variant' };
  return null;
}
function extract(q) {
  q = String(q || '').trim(); let tokens = q.split(/\s+/);
  // 나열(A·B·C, A,B)은 통째로 못 찾을 때만 쪼갠다(이름 속 가운뎃점 «영유아보육·교육진흥원» 보호). 쪼갠 토큰은 keywordStripped 에 쓰지 않는다.
  tokens = tokens.flatMap(t => /[·ㆍ,/]/.test(t) && !lookup(clean(t)) && !lookup(clean(stripJosa(t))) ? t.split(/[·ㆍ,/]+/).filter(Boolean) : [t]);
  const used = new Array(tokens.length).fill(false), hits = [];
  let sawGeneric = false, sawAmb = false;
  for (let n = Math.min(4, tokens.length); n >= 1; n--) for (let i = 0; i + n <= tokens.length; i++) {
    if (used.slice(i, i + n).some(Boolean)) continue;
    const c = clean(tokens.slice(i, i + n).join('')); if (c.length < 2) continue;
    const r = lookup(c); if (!r) continue;
    if (r.generic) { if (n === 1) sawGeneric = true; continue; }
    if (r.codes.size > 1) { sawAmb = true; continue; }
    hits.push({ code: [...r.codes][0], via: r.via, span: [i, i + n] }); for (let k = i; k < i + n; k++) used[k] = true;
  }
  const codes = [...new Set(hits.map(h => h.code))];
  if (codes.length === 1) {
    const h = hits[0], it = byCode.get(h.code);
    const kw = tokens.filter((_, i) => !hits.some(x => i >= x.span[0] && i < x.span[1])).join(' ').trim();
    return { inst: it.name, code: h.code, via: h.via, skip: null, keywordStripped: kw || q };
  }
  return { inst: null, code: null, via: null, skip: codes.length > 1 ? 'multi' : sawAmb ? 'ambiguous' : sawGeneric ? 'generic' : null, keywordStripped: q };
}
module.exports = { extract, byCode, LIST };
if (require.main === module) {
  const assert = require('assert');
  assert.strictEqual(extract('한국환경공단 노사화합 및 부당노동행위 금지').code, 'C0400');           // 정식명
  assert.strictEqual(extract('일산병원 단체협약 제118조에서 노조가 참여').code, 'C0459');             // 접미 구간 변형
  assert.strictEqual(extract('국민건강보험공단 육아휴직').code, byFull.get('국민건강보험공단').code);     // 자식 기관 있어도 정식명 정확 일치
  assert.strictEqual(extract('건보공단 육아휴직').inst, '국민건강보험공단');                           // 약칭
  assert.strictEqual(extract('공단 이사장 보수 규정').inst, null); assert.strictEqual(extract('공단 이사장 보수 규정').skip, 'generic');
  assert.strictEqual(extract('한국 공사 채용 규정').inst, null);
  assert.strictEqual(extract('근로복지공단과 한국환경공단 육아휴직 비교').skip, 'multi');
  assert.strictEqual(extract('임금피크제 적용 대상').inst, null);
  console.log('OK inst_extract 자가 테스트');
}
