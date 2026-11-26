#!/usr/bin/env node
/**
 * 질의 이해(가제티어) — 자연어 검색어에서 구조화 필터를 결정론적으로 추출
 *
 * "근로복지공단 2023년 감사 지적사항" → { inst:'근로복지공단', year:'2023', residual:'감사 지적사항' }
 * 사전(기관 355·소관부처)은 _ops/institutions.json, 활용처 키워드는 classify_usecase.js 재사용.
 * LLM 아님 — 같은 질의는 항상 같은 결과. 사전에 없는 표현은 잔여 검색어로 남아 기존과 동일하게 동작.
 *
 * 의도(intent) 분류: article(제N조) | compare(비교형) | aggregate(집계형) | case(사례형) | search(기본)
 *  — 현재는 라벨만 제공(소비처: 프론트 힌트·향후 비교/집계 엔진 라우팅). 오분류해도 검색 자체는 불변.
 *
 * 사용: const { understand } = require('./_query_understand.js');
 * 자가 테스트: node rag/_query_understand.js --test
 */
'use strict';

const fs = require('fs');
const { resolveInst } = require('./inst_alias');
const path = require('path');

// 기관 사전 위치. 배포 형태마다 다르므로 «후보를 훑고» env 로 덮어쓸 수 있게 한다.
//   본 저장소   <repo>/ops(=_ops)/institutions.json
//   MCP 단독판  <repo>/data/institutions.json
// 없으면 loadDict 가 빈 사전으로 떨어진다(질의 이해만 약해지고 검색은 된다).
const INST_PATH = process.env.ALIO_INSTITUTIONS_PATH
  || [path.join(__dirname, '..', 'ops', 'institutions.json'),
      path.join(__dirname, '..', '_ops', 'institutions.json'),
      path.join(__dirname, '..', 'data', 'institutions.json')]
       .find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } })
  || path.join(__dirname, '..', 'ops', 'institutions.json');

let _dict = null;
function loadDict() {
  if (_dict) return _dict;
  let insts = [];
  try {
    const raw = JSON.parse(fs.readFileSync(INST_PATH, 'utf8'));
    insts = Array.isArray(raw) ? raw : (raw.institutions || Object.values(raw));
  } catch { insts = []; }
  const instNorm = [];
  const ministries = new Set();
  for (const it of insts) {
    if (it && it.name) instNorm.push(String(it.name).replace(/\s+/g, ''));
    if (it && it.ministry) ministries.add(String(it.ministry).replace(/\s+/g, ''));
  }
  _dict = { instNorm, ministryNorm: [...ministries] };
  return _dict;
}

const JOSA_RE = /(에서의|으로|에서|에게|부터|까지|이라|이란|은|는|이|가|을|를|와|과|의|에|도|만|랑|이나)$/;
const YEAR_RE = /^(19|20)\d{2}(년도?)?$/;
const ART_RE = /제\s*\d+\s*조/;
// 기관명 부분표기 허용 접미(오탐 방지 — 접미 없으면 사전 완전일치만 인정)
const ORG_SUFFIX_RE = /(공단|공사|공제회|진흥원|연구원|연구소|재단|병원|대학교|정보원|평가원|관리원|개발원|위원회|사업단|협회|은행|박물관|미술관|도서관|공제조합)$/;

const INTENT_RES = [
  ['compare', /(차이|비교|맞비교|\bvs\b|대비표|어디가 더|누가 더)/],
  ['aggregate', /(몇\s*(개|곳|군데|명|건)|평균|가장\s*(많|적|높|낮)|최다|최소|상위\s*\d+|순위|랭킹)/],
  ['case', /(사례|판례|선례)/],
];

function stripJosa(w) {
  const s = w.replace(JOSA_RE, '');
  return s.length >= 2 ? s : w;
}

/**
 * @param {string} query 자연어 검색어
 * @returns {{inst: string|null, insts: string[], ministry: string|null, year: string|null,
 *            usecases: string[], intent: string, residual: string}}
 *  - inst/ministry/year: 자동 적용해도 안전한 필터(사용자가 명시한 고유명사·연도)
 *  - usecases: 제안만(자동 적용 금지 — 태그 없는 문서가 걸러지는 부작용 방지)
 *  - residual: 필터 소거 후 남은 검색어(전부 소진되면 원문 유지)
 */
function understand(query) {
  const q = String(query || '').trim();
  const out = { inst: null, insts: [], ministry: null, year: null, usecases: [], intent: 'search', residual: q };
  if (!q) return out;

  if (ART_RE.test(q)) out.intent = 'article';
  else for (const [intent, re] of INTENT_RES) if (re.test(q)) { out.intent = intent; break; }

  const dict = loadDict();
  const tokens = q.split(/\s+/);
  const used = new Array(tokens.length).fill(false);

  // 연도 — 단독 토큰만("2023년", "2023"). 조번호·금액과 혼동 없는 형태로 한정.
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i].replace(/[,.()]/g, '');
    if (!used[i] && YEAR_RE.test(w)) { out.year = w.slice(0, 4); used[i] = true; break; }
  }

  // 기관·부처 — 토큰 n그램(긴 것 우선) 공백제거 대조.
  // 기관은 접미 힌트("…공단" 등)가 있으면 부분표기 허용(inst 필터가 서버에서 ILIKE라 span 그대로 전달),
  // 접미 없으면 사전 완전일치만(예: "근로복지"가 기관으로 오인되는 것 방지).
  for (let n = Math.min(4, tokens.length); n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      if (used.slice(i, i + n).some(Boolean)) continue;
      const cand = stripJosa(tokens.slice(i, i + n).join('').replace(/[,.()?!]/g, ''));
      const al = resolveInst(cand);
      if (al !== cand) { out.insts.push(al); if (!out.inst) out.inst = al; for (let k = i; k < i + n; k++) used[k] = true; continue; }   // 약칭 → 정식명
      if (cand.length < 3) continue;
      if (!out.ministry && dict.ministryNorm.includes(cand)) {
        out.ministry = cand;
        for (let k = i; k < i + n; k++) used[k] = true;
        continue;
      }
      const exact = dict.instNorm.includes(cand);
      const partial = cand.length >= 4 && ORG_SUFFIX_RE.test(cand) && dict.instNorm.some(nn => nn.includes(cand));
      if (exact || partial) {
        out.insts.push(cand);
        if (!out.inst) out.inst = cand;
        for (let k = i; k < i + n; k++) used[k] = true;
      }
    }
  }

  // 활용처 제안 — classify_usecase의 키워드 사전 재사용(단일 출처 원칙)
  try {
    const { keywordUsecases } = require('../collection/classify_usecase.js');
    out.usecases = keywordUsecases(q).filter(u => u !== '_shared');
  } catch { /* 사전 모듈 없는 배포 환경(rag-api 이미지 등) — 제안만 생략 */ }

  out.residual = tokens.filter((_, i) => !used[i]).join(' ').trim();
  if (!out.residual) out.residual = q; // 전부 필터로 소진 시 원문 유지(빈 검색어 방지)
  return out;
}

module.exports = { understand };

// ── 자가 테스트 ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const assert = require('assert');
  const t = understand('근로복지공단 2023년 감사 지적사항');
  assert.strictEqual(t.inst, '근로복지공단');
  assert.strictEqual(t.year, '2023');
  assert.strictEqual(t.residual, '감사 지적사항');

  const t2 = understand('한국도로교통공단의 육아휴직');
  assert.strictEqual(t2.inst, '한국도로교통공단');
  assert.strictEqual(t2.residual, '육아휴직');

  const t3 = understand('고용노동부 임금피크제');
  assert.strictEqual(t3.ministry, '고용노동부');
  assert.strictEqual(t3.residual, '임금피크제');

  const t4 = understand('근로복지 정책'); // 접미 없는 부분표기 → 기관 오인 금지
  assert.strictEqual(t4.inst, null);
  assert.strictEqual(t4.residual, '근로복지 정책');

  const t5 = understand('연차휴가'); // 필터 없음 → 원문 그대로
  assert.strictEqual(t5.inst, null);
  assert.strictEqual(t5.residual, '연차휴가');

  const t6 = understand('도로교통공단과 근로복지공단 육아휴직 차이');
  assert.strictEqual(t6.intent, 'compare');
  assert.strictEqual(t6.insts.length, 2);

  const t7 = understand('육아휴직 3년 주는 기관 몇 곳');
  assert.strictEqual(t7.intent, 'aggregate');

  const t8 = understand('근로기준법 제60조');
  assert.strictEqual(t8.intent, 'article');
  assert.ok(t8.residual.includes('제60조')); // 조번호는 잔여 유지(전용 경로가 처리)

  const t9 = understand('근로복지공단'); // 기관명만 → 잔여=원문 폴백(빈 검색어 방지)
  assert.strictEqual(t9.inst, '근로복지공단');
  assert.strictEqual(t9.residual, '근로복지공단');

  console.log('OK — _query_understand 자가 테스트 9건 통과');
}
