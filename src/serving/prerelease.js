'use strict';
/**
 * 공개 전(pre_release) 공시 표기 — 서빙 쪽. PRERELEASE_MARK=off(기본)|on.
 *   off  이 모듈은 아무 것도 하지 않는다(응답 바이트가 종전과 같다).
 *   on   prerelease_state.json(점검 결과에서 build_prerelease_state.js 가 만든 «읽기 전용 상태 파일»)을 읽어
 *        결과 행마다 (inst_code, 항목 루트 4자리, 공시번호) 가 `pre_release` 로 «확인»된 경우에만 `pre_release: true` 를 붙인다.
 *        판정이 unknown·파일에 없음·파일 없음/깨짐/오래됨 → 표기 없음(현행과 같다). DB 는 건드리지 않는다.
 * 상태 파일 경로 PRERELEASE_STATE(기본 /ops/prerelease_state.json — 서빙 컨테이너가 /ops:ro 로 마운트하는 ops/ 아래). mtime 이 바뀌면 다시 읽는다.
 * 최대 나이 PRERELEASE_MAX_AGE_H(기본 168시간): 상태 파일 generated_at 이 이보다 오래되면 표기하지 않는다(공개가 된 뒤에도 «공개 전» 이라 말하는 것 방지).
 */
const fs = require('fs');

const on = () => process.env.PRERELEASE_MARK === 'on';
const file = () => process.env.PRERELEASE_STATE || '/ops/prerelease_state.json';
const maxAgeMs = () => (parseFloat(process.env.PRERELEASE_MAX_AGE_H || '168') || 168) * 3600e3;

let cache = { path: null, mtimeMs: -1, marks: new Map(), quarter: null, generated: 0, ok: false, warned: false };
function state() {
  const p = file();
  let st; try { st = fs.statSync(p); } catch { cache = { ...cache, path: p, mtimeMs: -1, marks: new Map(), ok: false }; return cache; }
  if (cache.path === p && cache.mtimeMs === st.mtimeMs) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const marks = new Map(); for (const [k, v] of Object.entries(j.marks || {})) if (v === 'pre_release') marks.set(k, true);
    cache = { path: p, mtimeMs: st.mtimeMs, marks, quarter: /^\d{4}Q[1-4]$/.test(j.public_quarter || '') ? j.public_quarter : null, generated: Date.parse(j.generated_at) || 0, ok: true, warned: false };
  } catch (e) {
    if (!cache.warned) console.error('[prerelease] 상태 파일을 읽지 못함 — 표기 없이 동작:', e.message);
    cache = { path: p, mtimeMs: st.mtimeMs, marks: new Map(), quarter: null, generated: 0, ok: false, warned: true };
  }
  return cache;
}

const dnoOf = r => { const m = /^disclosure:[^:]+:(\d{16}):/.exec(String(r.real_doc_id || r.doc_id || '')); return m ? m[1] : null; };
const rootOf = r => { const m = /^(\d{4})\d_/.exec(String(r.category || '')); return m ? m[1] : null; };   // 21021_노동조합 → 2102

/** rows 의 공시 행에 pre_release:true 를 직접 붙인다(on 일 때만). 붙인 개수 반환(off 면 0). real_doc_id 가 있는 단계에서 불러야 한다. */
function markRows(rows) {
  if (!on() || !rows || !rows.length) return 0;
  const s = state();
  if (!s.ok || !s.marks.size || Date.now() - s.generated > maxAgeMs()) return 0;
  let n = 0;
  for (const r of rows) {
    if (!r || r.corpus !== 'disclosure') continue;
    const dno = dnoOf(r), root = rootOf(r), inst = r.series_inst || r.inst_code;
    if (dno && root && inst && s.marks.has(inst + '|' + root + '|' + dno)) { r.pre_release = true; n++; }
  }
  return n;
}

/** 응답 최상위 부가 필드. count>0 이고 period 를 명시하지 않았을 때만(period=latest 는 명시가 아님). off·0건이면 {}. */
function topFields(count, periodExplicit) {
  if (!on() || !count || periodExplicit) return {};
  const q = state().quarter || '<공개 분기>';
  return { pre_release_count: count, pre_release_notice: `이 결과에는 ALIO 웹에 아직 공개되지 않은 최신 공시가 포함되어 있습니다. 공식 공개본 기준이 필요하면 period=${q} 를 지정하세요.` };
}

module.exports = { on, markRows, topFields, dnoOf, rootOf, _state: state };
