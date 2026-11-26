// 기관 약칭 → 정식명(inst_alias.json). 기관 필터(inst)가 정식명 부분일치라 약칭("창진원")은 결과 0건이 되는 것을 막는다.
// 정식명은 그대로 두고(약칭이 정식명 일부인 경우 보호), 입력 전체가 약칭과 정확히 같을 때만 바꾼다. 데이터는 이 JSON 한 곳에서만 고친다.
const fs = require('fs'), path = require('path');
const FILE = process.env.ALIO_INST_ALIAS_PATH || path.join(__dirname, 'inst_alias.json');
let MAP = {}, mtime = -1, checked = 0;
// 파일이 바뀌면(마운트한 JSON 교체) 30초 안에 다시 읽는다 — 약칭 추가에 재빌드·재시작이 필요 없다. 읽기·파싱에 실패하면 이전 표를 그대로 쓴다.
function getMap() {
  const now = Date.now(); if (now - checked < (+process.env.ALIO_INST_ALIAS_CHECK_MS || 30000) && mtime !== -1) return MAP; checked = now;
  try { const m = fs.statSync(FILE).mtimeMs; if (m !== mtime) { MAP = JSON.parse(fs.readFileSync(FILE, 'utf8')); mtime = m; } } catch { if (mtime === -1) mtime = 0; }
  return MAP;
}
const norm = s => String(s).replace(/\s+/g, '');
const resolveInst = s => (s && getMap()[norm(s)]) || s;

// 연구회 소관 출연연 23곳(ops/institutions_extra.json, documents.meta.scope='extra'). ALIO 공시대상 355곳과 별개라 검색 기본값에서 빠지고,
// 기관을 지정하면(정식명·그 일부 4자 이상) 자동 포함한다 — «연구원» 같은 짧은 일반어는 포함 판정에 쓰지 않는다. 목록은 이 파일 한 곳.
const EXTRA_INSTS = ['한국생산기술연구원', '한국전자통신연구원', '대구경북과학기술원', '한국철도기술연구원', '한국과학기술연구원', '한국기초과학지원연구원', '한국생명공학연구원',
  '한국과학기술정보연구원', '한국한의학연구원', '한국건설기술연구원', '한국표준과학연구원', '한국식품연구원', '한국지질자원연구원', '한국기계연구원', '한국에너지기술연구원',
  '한국전기연구원', '한국화학연구원', '한국원자력연구원', '한국재료연구원', '한국핵융합에너지연구원', '한국항공우주연구원', '한국천문연구원', '세계김치연구소'];
const isExtraInst = s => { const t = norm(s || ''); return t.length >= 4 && EXTRA_INSTS.some(n => n === t || n.includes(t) || t.includes(n)); };
// 검색 인자 scope 결정: 명시('extra' 만·'all' 둘 다)가 우선, 없으면 기관이 출연연이면 'all', 아니면 undefined(= 기본: 출연연 제외).
const scopeFor = (scope, inst) => scope === 'extra' ? 'extra' : scope === 'all' ? 'all' : isExtraInst(inst) ? 'all' : undefined;
const SCOPE_NOTE = '국가과학기술연구회 소관 정부출연연구기관(공공기관 지정 해제, 23곳)의 내규를 포함한 결과입니다. ALIO 공시대상 355곳과는 별개이며 이 기관들의 경영공시·통계는 없습니다.';
module.exports = { resolveInst, EXTRA_INSTS, isExtraInst, scopeFor, SCOPE_NOTE, get MAP() { return getMap(); } };
