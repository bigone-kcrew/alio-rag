'use strict';
// QueryStudy 권고(2026-11-24) 구현: ①기본 모드 자동 승격 ②0건 자동 hybrid 조건 확대 ③0건 사유 코드·기관별 보유 현황. 전부 SEARCH_AUTO_MODE=on 일 때만(꺼져 있으면 호출부가 아무것도 안 한다).
const on = () => process.env.SEARCH_AUTO_MODE === 'on';
const ART = /제\s*\d+\s*조/;
let understand = null; try { ({ understand } = require('./_query_understand.js')); } catch { /* 기관 감지 없이 동작 */ }
const ENDING = /(나요|인가요|인가|할까요?|어떻게|어떤가|있나|\?|？)\s*$/;
const LAWNAME = /^[가-힣·ㆍ\s]{2,30}(법|령|규칙|규정|지침|시행령|시행규칙)$/;   // 법령·규정명 단독(2어 이하) — 키워드(제목) 검색이 정답 경로
// c5: 긴 법령 제목(…에 관한 법률·…법 시행령·…에 관한 특별법 시행규칙 등) 정확 제목 질의도 키워드 유지(어절 8개 이하, 의문 어미 없음)
const LAWTITLE = /^[가-힣·ㆍA-Za-z0-9()\s]{2,70}(에\s*관한\s*(특별\s*)?(법률|법|규정|규칙|령)|법률|법|령|규칙|규정|지침|조례)(\s*(시행령|시행규칙))?$/;
const words = s => String(s).trim().split(/\s+/).filter(Boolean);
/** 모드 미지정(hybrid·semantic 인자 둘 다 없음) + 단일 코퍼스 + 문장형(공백 2개 이상)/의문 어미 → hybrid. 아니면 null. */
function decide({ keyword, corpus, hybrid, semantic, body }) {
  if (!on()) return null;
  if (hybrid != null || semantic != null) return null;                     // 명시 모드는 존중(false 포함)
  if (body === true || body === '1' || body === 'true') return null;       // c5: body:true 명시 키워드 질의 = 본문 문구 검색 의도
  const kw = String(keyword || '').trim();
  if (!kw || ART.test(kw)) return null;
  if (!corpus || corpus === 'all') return null;                            // corpus=all+hybrid 는 지연 큼(13건 중 9건 3초 초과) — 코퍼스별 키워드 우선
  const w = words(kw), sentence = w.length >= 3, ending = ENDING.test(kw);
  if (!sentence && !ending) return null;                                   // 1~2어
  if (w.length <= 2 && LAWNAME.test(kw)) return null;                      // 법령명 패턴
  if (!ending && w.length <= 8 && LAWTITLE.test(kw)) return null;         // c5: 긴 법령 제목 정확 질의
  return { mode: 'hybrid', reason: sentence ? '공백 2개 이상(문장형 질의)' : '의문 어미 질의' };
}
// c5: 0건 재시도 확대는 SEARCH_AUTO_MODE 와 분리한 별도 플래그 SEARCH_ZERO_RETRY(기본 off). 켜면 AUTO_HYBRID_ON_ZERO 없이도 «키워드 0건» 재시도(축소 조건 적용).
const zeroAny = () => process.env.SEARCH_ZERO_RETRY === 'on';
const MIN_SCORE = +process.env.SEARCH_ZERO_RETRY_MIN || 0.55;   // 재시도 결과 상위 점수(의미 유사도)가 이 값 미만이면 버린다 — 표본에서 오인 «검증인»(0.51) 구분, 0.57 이상은 대체로 적합
/** 재시도 발동 조건 축소: 1어 이하 제외, 기관 필터+body 조합 제외. */
const zeroRetryOk = ({ keyword, inst, body }) => words(keyword).length >= 2 && !(inst && (body === true || body === '1' || body === 'true'));
const zeroCut = rows => !rows || !rows.length || Math.max(...rows.map(r => parseFloat(r.score) || 0)) < MIN_SCORE;
/** 질의 속 기관명(사전 감지, 정확히 1곳)을 inst 필터로 올릴 값. 감지 없음·여러 곳이면 null. */
function liftInst(keyword) { if (!understand) return null; try { const u = understand(String(keyword || '')); return u && u.insts && u.insts.length === 1 ? u.insts[0] : null; } catch { return null; } }
/** 법령 질의의 날짜·판본 문구 → as_of. «2026년 12월 8일 시행 예정인 ○○법» → {asOf:'2026-12-08', keyword:'○○법'}. 월만 있으면 15일. legal 만(호출부), 날짜가 없으면 null. */
function dateToAsOf(keyword) {
  if (!on()) return null;
  const k = String(keyword || ''), re = /((?:19|20)\d{2})\s*(?:년|[.\-/])\s*(\d{1,2})\s*(?:월|[.\-/])?\s*(?:(\d{1,2})\s*일?)?\s*(?:부터\s*)?(?:시행\s*예정(?:인|된)?|시행(?:되는|하는|된)?|기준|시점|당시|현재)?\s*/;
  const m = re.exec(k); if (!m) return null;
  const y = +m[1], mo = +m[2], d = m[3] ? +m[3] : 15; if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (!/(시행|기준|시점|당시|현재|개정\s*전)/.test(m[0]) && !m[3]) return null;   // «2019년 휴직» 같은 단순 연도·월 언급은 제외
  const rest = (k.slice(0, m.index) + ' ' + k.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  return { asOf: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, keyword: rest || k, phrase: m[0].trim() };
}

const CORPUS_KO = { bylaws: '내규', ca: '단협', disclosure: '공시', legal: '법령' };
const DATE_PHRASE = /(19|20)\d{2}\s*(년|[.\-/]\s*\d{1,2})|\d{1,2}\s*월\s*(기준|시점)|시점|당시|개정\s*전/;
/** 0건 응답 사유: zero_reason[{code,text}] + inst_holdings. run(sql, params) → rows. args 는 search 내부 인자(inst·period…), a 는 원 인자. */
async function zeroInfo(run, args, a, out) {
  const rs = [], kw = String(a.keyword || '');
  if (!a.body && !a.semantic && !a.hybrid && !out.auto_hybrid && kw && args.corpus !== 'legal') rs.push({ code: 'title_only_search', text: '키워드 모드는 제목(조제목)만 찾았습니다 — body=true 로 본문을 찾거나 hybrid:true 로 의미검색하세요.' });
  let holdings = null;
  if (args.inst) {
    try {
      const rows = await run(`SELECT d.corpus, count(*)::int AS n FROM documents d JOIN institutions i USING (inst_code) WHERE i.inst_name ILIKE '%'||$1||'%' GROUP BY 1`, [String(args.inst).replace(/[\\%_]/g, '\\$&')]);
      holdings = {}; for (const r of rows) holdings[r.corpus] = r.n;
    } catch { /* 보유 현황 없이 계속 */ }
    if (holdings) {
      const total = Object.values(holdings).reduce((s, x) => s + x, 0), txt = Object.entries(holdings).map(([k, v]) => (CORPUS_KO[k] || k) + ' ' + v + '건').join('·');
      if (!total) rs.push({ code: 'inst_no_docs', text: '이 기관명으로 문서가 없습니다 — 기관명(정식명·약칭)을 확인하세요(list_catalog).' });
      else if (args.corpus && args.corpus !== 'all' && !holdings[args.corpus]) rs.push({ code: 'corpus_mismatch', text: `이 기관은 ${CORPUS_KO[args.corpus] || args.corpus} 문서가 없습니다(보유: ${txt}) — corpus 를 바꿔 보세요(기관 내규는 legal 이 아니라 bylaws·ca).` });
      else rs.push({ code: 'inst_holdings', text: `이 기관 보유 문서: ${txt}.` });
    }
  }
  if (DATE_PHRASE.test(kw) && !a.as_of && !a.all_versions) rs.push({ code: 'no_version_filter', text: '질의에 날짜·시점 표현이 있지만 판본 필터가 없어 «현행판» 만 찾았습니다 — 그 시점 규정이면 as_of="YYYY-MM-DD", 과거 판 포함이면 all_versions=true.' });
  if (args.period || args.reportPeriod || args.targetYear) rs.push({ code: 'period_filter', text: 'period·report_period·target_year 는 제출 회차·제목 연도 기준이라 대상 문서를 놓칠 수 있습니다 — 필터를 빼고 다시 확인하세요.' });
  return { ...(rs.length ? { zero_reason: rs } : {}), ...(holdings ? { inst_holdings: holdings } : {}) };
}
module.exports = { on, decide, zeroAny, zeroRetryOk, zeroCut, liftInst, dateToAsOf, MIN_SCORE, zeroInfo, ROUTING: ' 라우팅: 제N조·법령명→get_article 또는 corpus=legal. 몇 건·평균·합계·징계·임원 등 수치→structured_query. 다기관 종합→distinct_inst+기간+item+hybrid. 기관 내규는 legal 이 아니라 bylaws·ca. 신규채용 통계 20401≠채용공고 B1020. 모드를 안 주면 문장형 질의는 서버가 hybrid 로 올리고(auto_mode) 키워드 0건이면 자동 hybrid(auto_hybrid)를 시도하며, 0건 응답의 zero_reason·inst_holdings 로 원인을 확인할 것.' };
