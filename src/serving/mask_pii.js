'use strict';
// 반환 시점 개인정보 마스킹 (원문은 보존, 검색·질의응답 응답을 내보낼 때만 가린다) — 2026-10-06 사용자 결정.
// 근거: docs/reports/2026-10-06_pii_audit_assessment.md §6~7. 의존성 없음, 서버·DB 접근 없음.
//
// 규칙
//  - 주민번호형: 생년월일 유효 + 검증숫자(mod 11) 일치일 때 뒤 6자리를 ●. 직전 40자에 «법인등록번호» 라벨이면 제외.
//    검증숫자가 틀려도 직전 40자에 «주민(등록)번호·외국인등록번호» 라벨이 있으면 보수적으로 마스킹.
//  - 휴대폰 01[016789]: 가운데 자리를 ●(구분자 유지). 앞뒤가 숫자·하이픈이면 제외.
//  - 이메일: 개인 포털 도메인만 로컬파트를 첫 글자+●●● 로(opts.maskAllEmails 면 전부).
//  - 일반전화는 마스킹하지 않는다: 스캔용 정규식이 긴 숫자열·품목코드에 과다 적중(33만 건, 신뢰 불가)해서
//    가리면 정상 숫자(금액·코드)를 대량 훼손한다. 필요하면 정규식을 재설계한 뒤 추가할 것.
//  - 한계: 이름·주소·계좌번호는 탐지하지 못한다.
// 멱등: 마스킹 결과의 ● 는 숫자·이메일 로컬 문자류가 아니라서 다시 적용해도 매치되지 않는다.
// 역추적: 모든 정규식이 선형(숫자는 고정 길이, 이메일은 토큰 시작에만 lookbehind 로 앵커).

const DOT = '●';
// RT-08 단일 정의: 개인 메일 도메인 — 마스킹(maskText)·게이트(G5-3 PERS 정규식)·시험이 같은 목록을 쓴다. 하위도메인(mail.naver.com)도 개인 메일로 본다.
const PERSONAL_DOMAINS = ['gmail.com', 'naver.com', 'daum.net', 'hanmail.net', 'nate.com', 'kakao.com', 'hotmail.com', 'yahoo.com', 'yahoo.co.kr', 'yahoo.com.hk', 'yahoo.com.tw', 'outlook.com',
  'korea.com', 'empas.com', 'icloud.com', 'paran.com', 'dreamwiz.com', 'kornet.net', 'hanmir.com', 'freechal.com', 'netian.com', 'chollian.net', 'lycos.co.kr', 'msn.com', 'live.com', 'protonmail.com', 'proton.me',
  'nate.co.kr', 'naver.co.kr', 'daum.com', 'kakao.co.kr', 'hotmail.co.kr', 'outlook.co.kr', 'live.co.kr'];   // RT2-05: 누락 도메인 보강
const PERSONAL = new Set(PERSONAL_DOMAINS);
const isPersonal = d => { d = d.toLowerCase(); for (const p of PERSONAL) if (d === p || d.endsWith('.' + p)) return true; return false; };
const esc = x => x.replace(/\./g, '\\.');
// 게이트용(전역·대소문자 무시): 원문 그대로의 이메일 중 개인 도메인(하위도메인 포함)
const PERS_EMAIL_RE = new RegExp('(?<![A-Za-z0-9._%+\\-])[A-Za-z0-9._%+\\-]+@(?:[A-Za-z0-9\\-]+\\.)*(?:' + PERSONAL_DOMAINS.map(esc).join('|') + ')\\b', 'gi');
const W = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
// 구분자: 하이픈·점·공백(앞뒤 공백 허용 «010 - 1234 - 5678»). 숫자 사이 개행·표 셀 경계(|)는 주민번호에만 허용.
const SEP = '([ \\t]*[-.][ \\t]*|[ \\t]*)';
const RRN = /(?<![0-9])(\d{2})(\d{2})(\d{2})(\s*[-|]\s*|\s+|)([1-8])(\d{6})(?![0-9])/g;   // 구분: 하이픈·표 경계·공백·개행·없음(검증숫자 또는 라벨 필수라 과다 적중 낮음)
// 휴대폰 01[016789]: 앞이 숫자·영문자·하이픈이면 제외(코드 A010-1234-5678·2010-… 보존). «(010) 1234-5678» 괄호형 허용, 국제표기(+82·82)는 별도.
const MOB = new RegExp('(?<![0-9A-Za-z-])(\\()?(01[016789])(\\))?' + SEP + '(\\d{3,4})' + SEP + '(\\d{4})(?![0-9-])', 'g');
const MOB82 = new RegExp('(?<![0-9A-Za-z-])(\\(?\\+?82\\)?[ \\t]*[-.]?[ \\t]*(?:\\(0\\))?0?)(1[016789])' + SEP + '(\\d{3,4})' + SEP + '(\\d{4})(?![0-9-])', 'g');   // «+» 없는 82 도(RT2-05)
// RT2-05: 선행 0 이 빠진 «10-9999-0000»(하이픈 구분만) — 앞이 숫자·영문·하이픈이면 제외
const MOB10 = /(?<![0-9A-Za-z-])(1[016789])-(\d{3,4})-(\d{4})(?![0-9-])/g;
const MAIL = /(?<![A-Za-z0-9._%+\-])([A-Za-z0-9._%+\-]+)[ \t]*(?:@|\(at\)|\[at\])[ \t]*([A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,})/gi;
// RT2-05: 글자로 쓴 메일 «hong at naver dot com»·«hong(at)naver(dot)com» — 개인 도메인일 때만 가린다
const MAILTXT = /(?<![A-Za-z0-9._%+\-])([A-Za-z0-9._%+\-]+)[ \t]*(?:\(at\)|\[at\]|[ \t]at[ \t])[ \t]*([A-Za-z0-9\-]+(?:[ \t]*(?:\(dot\)|\[dot\]|[ \t]dot[ \t]|\.)[ \t]*[A-Za-z0-9\-]+)+)/gi;
const LAB_CORP = /법인\s*(?:등록)?\s*번호/;
const LAB_RRN = /(?:주민|외국인)\s*(?:등록)?\s*번호/;
// 정규화가 필요한 문자: 제로폭·소프트하이픈·유니코드 대시·전각 형태·HTML 엔티티 «&#64;»(= @). 이 문자가 «실제로 있을 때만» 정규화 루프를 돈다(대용량 본문 속도, RT2-05).
const SPECIAL = /[­​-‍⁠﻿‐-―−﹘﹣！-～]|&#(?:64|x40);/i;

function chkOk(d) { // d: 13자리 숫자 문자열
  let s = 0;
  for (let i = 0; i < 12; i++) s += +d[i] * W[i];
  return (11 - (s % 11)) % 10 === +d[12];
}

// RT-08: 탐지용 정규화 사본 — 제로폭 제거·전각→ASCII(NFKC)·유니코드 대시→'-'·«&#64;»→'@'. map/end = 사본 글자 → 원문 [시작,끝) 위치(원문 구간 치환용). 특수문자가 없으면 사본=원문(map=null).
function normalize(t) {
  if (!SPECIAL.test(t)) return { n: t, map: null };
  let n = ''; const map = [], end = [];
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (/[­​-‍⁠﻿]/.test(ch)) continue;
    if (ch === '&') { const m = /^&#(?:64|x40);/i.exec(t.slice(i, i + 6)); if (m) { n += '@'; map.push(i); end.push(i + m[0].length); i += m[0].length - 1; continue; } }
    const r = /[‐-―−﹘﹣]/.test(ch) ? '-' : ch.normalize('NFKC');
    for (const c of r) { n += c; map.push(i); end.push(i + 1); }
  }
  return { n, map, end };
}
// 한 번의 탐지·치환: pre 가 사본에 없으면 즉시 반환(대용량 속도). re 로 사본에서 찾고 cb(match, n, off) 가 치환문자열을 주면 «원문 구간» 을 바꾼다(null=유지).
function pass(t, pre, re, cb) {
  const { n, map, end } = normalize(t);
  if (!pre.test(n)) return t;
  const edits = [];
  for (const m of n.matchAll(re)) {
    const rep = cb(m, n, m.index); if (rep == null) continue;
    const a = map ? map[m.index] : m.index, e = map ? end[m.index + m[0].length - 1] : m.index + m[0].length;
    edits.push([a, e, rep]);
  }
  if (!edits.length) return t;
  let out = '', pos = 0; for (const [a, e, rep] of edits) { out += t.slice(pos, a) + rep; pos = e; }
  return out + t.slice(pos);
}


// ───────── MASK_PII_V2 (2026-11-24 MaskPII): 계좌번호·유선번호/팩스·실명+직함·이름+생년월일. external·등급 미지정 전용(opts.v2). ─────────
// 한계: 이름은 «성씨 사전 + 직함/생년월일 인접» 휴리스틱이라 직함·생년월일이 없는 단독 실명은 못 가린다. 선형 정규식, 멱등(OO·● 는 재매치 안 됨).
const TITLES = ['부이사장', '이사장', '상임감사', '상근감사', '감사', '비상임이사', '상임이사', '상근이사', '이사', '대표이사', '공동대표', '대표', '부사장', '사장', '부회장', '회장', '부원장', '원장', '총장', '학장', '부소장', '소장',
  '본부장', '사무국장', '국장', '실장', '처장', '단장', '센터장', '지사장', '지점장', '팀장', '부장', '차장', '과장', '위원장', '청장', '관장', '책임연구원', '선임연구원', '연구위원', '연구원', '교수', '박사', '사무관', '서기관', '주임', '담당자', '담당관', '이사관'];
const T_RE = TITLES.slice().sort((a, b) => b.length - a.length).join('|');
const SUR1 = '김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민나진지엄채원천방공현함변염여추도소석설마길연왕맹탁봉';
const SUR2 = ['남궁', '황보', '제갈', '사공', '선우', '서문', '독고', '동방'];
const PART = '은는이가을를의도와과께에';
const PART_A = '은는이가을를의';   // «직함 김철수는» 꼬리로 인정하는 조사(도·와·과·에 는 «조치결과»·«정책에» 류 오탐이 커서 제외)
// 이름이 아닌 일반어(성씨 글자로 시작하는 3~4자 단어): 코퍼스 오탐 점검으로 보강
const STOP = new Set(['이사회', '이사진', '선임', '해임', '임명', '임기', '경영진', '전문가', '정책', '정관', '한국', '전체', '성과', '최근', '신규', '안전', '조직', '문서', '방법', '도입', '구성', '원칙', '고객', '장기', '강화', '서비스', '우수', '진행', '지원', '변경', '추진', '연구', '위원회', '금액', '인사', '제도', '국가', '은행', '예산', '경영', '임직원', '정부', '주요', '유관', '민간', '현황', '공개', '고용', '노동', '심의', '남부', '양성', '손실', '송부', '배정', '하도급', '공사', '구매', '조달', '전략', '총괄', '대외', '장기', '전문', '기획', '정보', '정규', '정산', '전환', '주관', '주무', '원장', '조정', '사업', '공공', '성별', '신청', '지급', '조사', '한도', '차량', '채용', '현장', '직무', '직원', '직급', '지침은', '안건은', '구성은', '전문직', '전임제', '이메일', '지정에', '정보를', '이내에', '설립일', '민간이', '지도자', '정기종합', '임원급', '전원이', '행사장', '연수원']);
const BADEND = /[회부처과팀청국실소단안서건등는가를의와과에도로며고면한된인적할]$/;
const surLen = w => (w.length >= 4 && SUR2.includes(w.slice(0, 2))) ? 2 : (SUR1.includes(w[0]) ? 1 : 0);
// w 전체가 «성+이름» 이면 true (3자 = 1자성+2자이름, 4자 = 2자복성+2자이름)
const nameOk = w => { if (STOP.has(w) || TITLES.includes(w) || /원장|위원|이사|사장|회장|감사|대표|연구|교수|박사|제도|결과/.test(w) || BADEND.test(w)) return false; const k = surLen(w); return k === 1 ? w.length === 3 : k === 2 ? w.length === 4 : false; };
const maskName = w => w.slice(0, surLen(w)) + 'O'.repeat(w.length - surLen(w));
const maskDate = d => /^\d{6,8}$/.test(d) ? d.slice(0, d.length - 4) + '●●●●' : d.replace(/^(\d{2,4})(\D*)(\d{1,2})(\D*)(\d{1,2})/, (m, y, a, mo, b, dd) => y + a + '●●' + b + '●●');
const BANKS = '은행|뱅크|농협|신협|새마을금고|수협|우체국';   // 회사명에 흔한 «하나·우리·국민·기업» 등 단독 은행명은 제외(사업자번호 오탐)
const ACC_W = /(계좌|입금|예금주|송금|이체|은행|뱅크|농협|신협|새마을금고|수협|우체국|IBK|KB|NH)/g;
const ACC_NEG = /(사업자|법인|등록번호|문서번호|계약번호|관리번호|승인번호|고유번호|전화|TEL|FAX|팩스|우편|시행|접수|공고|Tel|Fax)/;
const ACC_H = /(?<![0-9A-Za-z-])(\d{2,6})((?:-\d{2,7}){1,4})(?![0-9-])/g;
const ACC_C = /(?<![0-9A-Za-z-])(\d{3})(\d{7,13})(?![0-9-])/g;
const ACC_CTX_C = new RegExp('(?:계좌(?:번호)?|예금주|입금|' + BANKS + ')[^0-9\\n]{0,14}$');
const LAND = /(?<![0-9A-Za-z-])(\(?)(0(?:2|[3-6][1-5]|70))(\)?)([ \t]*[-.)][ \t]*)(\d{3,4})([ \t]*[-.][ \t]*)(\d{4})(?![0-9-])/g;
const LAND_CTX = /(전화|TEL|Tel|tel|FAX|Fax|fax|팩스|연락처|문의|☎|대표번호|Phone|\bT[ \t]*[.:)]|\bF[ \t]*[.:)])/;
const LAND_PERS = new RegExp('(?:담당(?!부서|과|팀|처|실|기관|업무|사항)자?|직통|내선|작성자|감독자|확인자|협조자|직원|성명|문의자|대리|계장|사원|주무관|(?:' + T_RE + ')(?![ \t]*(?:전화|번호)))', 'g');
const LAND_PERS_W = /담당|직통|내선|작성자|감독자|확인자|협조자/;
const LAND_ORG = /(?:대표[ \t]*전화|대표[ \t]*번호|대표(?=[ \t:)]|$)|콜센터|고객센터|민원|본사|상담센터|안내|교환|FAX|Fax|팩스|홈페이지|주소|소재지|우편)/g;
let INST_TEL = new Set(); try { INST_TEL = new Set(JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'inst_tel_whitelist.json'), 'utf8'))); } catch (e) { /* 파일 없으면 마스터 면제 없음 */ }
const LAND_POST = /^[ \t)\]]*[(\[]?[ \t]*(?:FAX|Fax|fax|팩스|전화|TEL|Tel)/;
const RE_A = new RegExp('(' + T_RE + ')([ \\t]+|[ \\t]*[:：][ \\t]*|[ \\t]*[(（][ \\t]*)([가-힣]+)', 'g');
const RE_B = new RegExp('(?<![가-힣])([가-힣]{3,4})(?:([ \\t]+)(' + T_RE + ')|()(과장|차장|대리|교수|박사|팀장|주임|사무관|서기관))(?=[^가-힣]|[' + PART + ']|$)', 'g');   // 공백 없는 «서주현과장» 은 모호하지 않은 직함만(본부장·원장·이사장은 «노조위원장»·«전략본부장» 오탐)
const RE_NB = /(?<![가-힣])([가-힣]{2,4}|[가-힣]{1,2}[O○ㅇ]{1,2})([ \t]*[(\[（]?[ \t]*(?:(?:생년월일|생|출생)[ \t]*[:：]?[ \t]*)?)((?:19[3-9]\d|200[0-4])(?:[ \t]*(?:[.\-/]|년)[ \t]*\d{1,2}[ \t]*(?:[.\-/]|월)[ \t]*\d{1,2}|\d{4}))(?![0-9])/g;
const RE_BL = /((?:생년월일|생일|출생일?|Birth)[ \t]*[:：]?[ \t]*[(\[（]?[ \t]*)((?:19[3-9]\d|20[01]\d)(?:[ \t]*(?:[.\-/]|년)[ \t]*\d{1,2}[ \t]*(?:[.\-/]|월)[ \t]*\d{1,2}|\d{4})|\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?![0-9])/g;

// 예금주가 기관(공단·대학교·병원·기금…)이면 법인 입금계좌(공시에 공개되는 납부처)라 가리지 않는다 — 실측 샘플의 계좌 전부가 이 유형. 예금주가 없거나 사람 이름이면 가린다.
const INST_SUF = /(공단|공사|대학교?|병원|재단|연구원|기금|진흥원|협회|학교|센터|위원회|본부|공제회|조합|은행|㈜|\(주\)|주식회사)/;
function instAcct(n, off, len) {
  const w = n.slice(Math.max(0, off - 60), off + len + 60), m = /예금주(?:명)?[ \t]*[:：]?[ \t]*([가-힣()㈜·A-Za-z ]{2,30})/.exec(w);
  return !!(m && INST_SUF.test(m[1]));
}
function maskV2(t, counts) {
  // 계좌번호 — 하이픈형: 앞 40자에 계좌 맥락어, 그 뒤~번호 사이에 다른 번호 라벨 없음, 자릿수 9~16, 3-2-5(사업자번호 형) 은 «계좌·입금·예금주» 명시 때만
  t = pass(t, /계좌|입금|예금주|송금|이체|은행|뱅크|농협|신협|새마을금고|수협|우체국|IBK|KB|NH/, ACC_H, (m, n, off) => {
    const digits = (m[1] + m[2]).replace(/-/g, '').length; if (digits < 9 || digits > 16) return null;
    const pre = n.slice(Math.max(0, off - 40), off); let last = -1, lw = ''; for (const w of pre.matchAll(ACC_W)) { last = w.index + w[0].length; lw = w[0]; }
    if (last < 0 || ACC_NEG.test(pre.slice(last))) return null;
    const g = (m[1] + m[2]).split('-'); if (g.length === 3 && g[0].length === 3 && g[1].length === 2 && g[2].length === 5 && !/계좌|입금|예금주/.test(pre)) return null;
    if (instAcct(n, off, m[0].length)) return null;
    counts.account++; return g.map((x, i) => i ? DOT.repeat(x.length) : x).join('-');
  });
  // 계좌번호 — 연속 숫자형(10~16자리): 바로 앞 14자 이내에 «계좌/예금주/은행명»
  t = pass(t, /계좌|예금주|입금|은행|뱅크|농협|신협|새마을금고|수협|우체국/, ACC_C, (m, n, off) => {
    if (!ACC_CTX_C.test(n.slice(Math.max(0, off - 20), off))) return null;
    counts.account++; return m[1] + DOT.repeat(m[2].length);
  });
  // 유선번호·팩스 — «개인에 붙은 번호» 만 뒷 4자리 가림. 기관 대표·콜센터·민원·본사·기관 FAX(조직 맥락)와 기관 마스터(ops/institutions.json tel) 번호는 유지.
  t = pass(t, /0(?:2|[3-6][1-5]|70)[ \t]*[-.)]/, LAND, (m, n, off) => {
    if (INST_TEL.has((m[2] + m[5] + m[7]).replace(/\D/g, ''))) return null;
    const pre = n.slice(Math.max(0, off - 40), off);
    if (!LAND_CTX.test(n.slice(Math.max(0, off - 60), off)) && !LAND_POST.test(n.slice(off + m[0].length, off + m[0].length + 12)) && !LAND_PERS_W.test(pre) && pre.search(LAND_PERS) < 0) return null;
    let pi = -1; for (const x of pre.matchAll(LAND_PERS)) pi = Math.max(pi, x.index);
    // ponytail: 성명 토큰만으로 개인 판정하지 않음(원주시·동안구 같은 지명이 성씨+2자로 걸려 기관 주소 전화가 가려짐, 실측)
    let oi = -1; for (const x of pre.matchAll(LAND_ORG)) oi = Math.max(oi, x.index);
    if (pi < 0 || (oi >= 0 && oi > pi)) return null;   // 개인 맥락 없음 또는 기관 맥락이 더 가까움 → 유지
    counts.landline++; return m[1] + m[2] + m[3] + m[4] + m[5] + m[6] + DOT.repeat(4);
  });
  // 이름+생년월일 — 이름(실명 휴리스틱 또는 이미 가린 «김OO»)에 인접한 생년월일: 실명이면 이름도 가림, 날짜는 연도만 남김
  t = pass(t, /19[3-9]\d|20[01]\d/, RE_NB, (m) => {
    const masked = /[O○ㅇ]/.test(m[1]); if (!masked && !nameOk(m[1])) return null;
    counts.birth++; return (masked ? m[1] : maskName(m[1])) + m[2] + maskDate(m[3].replace(/\s+/g, ' ')).replace(/ +/g, ' ');
  });
  t = pass(t, /생년월일|생일|출생|Birth/, RE_BL, (m) => { counts.birth++; return m[1] + maskDate(m[2]); });
  // 실명+직함 — «직함 홍길동(은/는…)» 과 «홍길동 직함»
  t = pass(t, new RegExp(T_RE), RE_A, (m, n, off) => {
    const w = m[3]; let nm = null, tail = '';
    if (nameOk(w)) nm = w; else if (w.length > 3 && PART_A.includes(w[w.length - 1]) && w.length - 1 <= 4 && nameOk(w.slice(0, -1))) { nm = w.slice(0, -1); tail = w.slice(-1); }
    if (!nm || (m[1] === '차장' && off > 0 && n[off - 1] === '주')) return null; counts.name++; return m[1] + m[2] + maskName(nm) + tail;
  });
  t = pass(t, new RegExp(T_RE), RE_B, (m) => { if (!nameOk(m[1])) return null; counts.name++; return maskName(m[1]) + (m[2] || '') + (m[3] || m[5]); });
  // c5(⑥): «채용관리자: 일반직 4급 김수정»·«감독관: 일반직6급 정보예» — 담당 역할 라벨 + (직군·급) + 이름
  t = pass(t, /채용관리자|채용담당|감\s*독\s*관|면접관|심사위원|담당자|작성자|확인자|책임자/, RE_R, (m) => { if (!nameOk(m[3])) return null; counts.name++; return m[1] + m[2] + maskName(m[3]); });
  return maskTableNames(t, counts);
}
const RE_R = /((?:채용관리자|채용담당자|채용담당|감\s*독\s*관|면접관|심사위원|담당자|작성자|확인자|책임자)[ \t]*[:：][ \t]*)((?:[가-힣]{1,4}직)?[ \t]*\d?[ \t]*급?[ \t]*)([가-힣]{3,4})(?![가-힣])/g;
// c5(⑥): 파이프 표에서 머리글 칸이 «성명|이름» 인 열의 값(2~4자 한글, 성씨 사전 일치)을 가린다. 머리글이 같은 텍스트 안에 있을 때만(청크가 갈린 표는 머리글 없이 값만 오므로 한계).
function maskTableNames(t, counts) {
  if (t.indexOf('|') < 0 || !/성\s*명|이\s*름/.test(t)) return t;
  const lines = t.split('\n'); let idx = -1, changed = false;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!/^\s*\|/.test(L)) { idx = -1; continue; }
    const cells = L.split('|');
    if (/^\s*\|[\s:|\-]+\|?\s*$/.test(L)) continue;   // 구분선
    if (idx < 0) { const k = cells.findIndex(c => /^\s*(성\s*명|이\s*름)\s*$/.test(c)); if (k >= 0) idx = k; continue; }
    const w = (cells[idx] || '').trim();
    if (/^[가-힣]{2,4}$/.test(w) && surLen(w) > 0 && !STOP.has(w) && !TITLES.includes(w)) { cells[idx] = cells[idx].replace(w, maskName(w)); lines[i] = cells.join('|'); counts.name++; changed = true; }
  }
  return changed ? lines.join('\n') : t;
}

function maskText(text, opts) {
  const counts = { rrn: 0, mobile: 0, email: 0 };
  if (opts && opts.v2) Object.assign(counts, { account: 0, landline: 0, name: 0, birth: 0 });
  if (typeof text !== 'string' || !text) return { text: text, counts };
  const o = opts || {};
  let t = text;
  t = pass(t, /\d{13}|\d{6}[\s|-]+\d{7}/, RRN, (m, n, off) => {
    const [, y, mo, d, sep, g, tail] = m;
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
    const pre = n.slice(Math.max(0, off - 40), off);
    if (LAB_CORP.test(pre)) return null;
    if (!chkOk(y + mo + d + g + tail) && !LAB_RRN.test(pre)) return null;
    counts.rrn++;
    return y + mo + d + sep + g + DOT.repeat(6);
  });
  t = pass(t, /01[016789]/, MOB, (m) => { counts.mobile++; return (m[1] || '') + m[2] + (m[3] || '') + m[4] + DOT.repeat(m[5].length) + m[6] + m[7]; });
  t = pass(t, /82[ \t.()+-]*(?:\(0\))?0?1[016789]/, MOB82, (m) => { counts.mobile++; return m[1] + m[2] + m[3] + DOT.repeat(m[4].length) + m[5] + m[6]; });
  t = pass(t, /1[016789]-\d{3,4}-\d{4}/, MOB10, (m) => { counts.mobile++; return m[1] + '-' + DOT.repeat(m[2].length) + '-' + m[3]; });
  t = pass(t, /@|\(at\)|\[at\]/i, MAIL, (m) => {
    if (!o.maskAllEmails && !isPersonal(m[2])) return null;
    counts.email++;
    return m[1][0] + DOT.repeat(3) + '@' + m[2];
  });
  t = pass(t, /\(at\)|\[at\]|[ \t]at[ \t]/i, MAILTXT, (m) => {
    const dom = m[2].replace(/[ \t]*(?:\(dot\)|\[dot\]|[ \t]dot[ \t])[ \t]*/gi, '.').replace(/[ \t]+/g, '');
    if (!o.maskAllEmails && !isPersonal(dom)) return null;
    counts.email++;
    return m[1][0] + DOT.repeat(3) + '@' + dom;
  });
  if (o.v2) t = maskV2(t, counts);
  return { text: t, counts };
}

function addCounts(a, b) { for (const k in b) a[k] = (a[k] || 0) + b[k]; return a; }

const FIELDS = ['body', 'excerpt', 'art_title', 'doc_title', 'title', 'table_header'];   // G2-C: table_header 는 1번 청크 본문에서 나온 값이라 같은 마스킹
function maskRow(row, fields, opts) {
  const out = Object.assign({}, row);
  const counts = { rrn: 0, mobile: 0, email: 0 };
  if (!row || typeof row !== 'object') return { row: out, counts };
  for (const f of fields || FIELDS) {
    if (typeof row[f] !== 'string') continue;
    const r = maskText(row[f], opts);
    out[f] = r.text;
    addCounts(counts, r.counts);
  }
  return { row: out, counts };
}

function maskRows(rows, opts) {
  const counts = { rrn: 0, mobile: 0, email: 0 };
  const out = (rows || []).map((r) => { const m = maskRow(r, undefined, opts); addCounts(counts, m.counts); return m.row; });
  return { rows: out, counts };
}

// 질의 로그용. 질의에는 이름·번호가 섞일 수 있어 이메일 전부 + 7자리 이상 연속 숫자열도 가린다.
// 한계: 이름 자체는 가릴 수 없다(예: "홍길동 연봉").
function maskQueryForLog(q) {
  if (typeof q !== 'string') return q;
  return maskText(q, { maskAllEmails: true }).text.replace(/\d{7,}/g, (m) => DOT.repeat(m.length));
}

// RT-07: 적재 시점에 제목·메타 값도 가린다(doc_id·rel_path 는 식별자라 건드리지 않는다). 객체·배열을 재귀로 돌며 문자열만 마스킹, skip 키는 건너뜀.
function maskDeep(v, skip) {
  if (typeof v === 'string') return maskText(v).text;
  if (Array.isArray(v)) return v.map(x => maskDeep(x, skip));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = (skip && skip.includes(k)) ? v[k] : maskDeep(v[k], skip); return o; }
  return v;
}

// RT2-06: 식별·조인 키(경로·판본 그룹·후속 판 경로 등)는 마스킹하지 않는다 — 자유 텍스트 필드만 가린다(조인이 깨지면 판본·별칭 추적이 끊긴다)
const ID_KEYS = ['aliases', 'edition_group', 'superseded_by', 'lineage_successor', 'source_url', 'dup_group', 'body_group'];
// 문서 레코드: doc_title·meta 값 마스킹(rel_path·doc_id 는 식별자라 유지, meta.aliases 는 경로라 유지) — 임베딩 접두(기관/문서명)에도 원문이 들어가지 않게 한다.
function maskDocRecord(o) { const r = { ...o }; if (typeof r.doc_title === 'string') r.doc_title = maskText(r.doc_title).text; if (r.meta) r.meta = maskDeep(r.meta, ID_KEYS); return r; }
const maskStr = v => (typeof v === 'string' ? maskText(v).text : v);

// 등급별 마스킹 정책(2026-10-21 사용자 결정): external(익명·외부 키)·등급 미지정 = 모든 이메일 가림 / internal(서버 멤버)·master = 기본(개인 포털 메일만).
//   «미지정 = 엄격» 이 fail-safe. 환경변수 MASK_ALL_EMAILS_EXTERNAL=0 이면 external 도 기본으로 되돌린다.
// MASK_PII_V2=1 이면 external·미지정 에만 v2 규칙(계좌·유선·실명+직함·이름+생년월일) 추가 — 기본 off, internal·master 는 항상 기존.
const maskOptsForTier = tier => {
  if (tier === 'internal' || tier === 'master') return {};
  const v2 = process.env.MASK_PII_V2 === '1';
  if (process.env.MASK_ALL_EMAILS_EXTERNAL === '0') return v2 ? { v2: true } : {};
  return v2 ? { maskAllEmails: true, v2: true } : { maskAllEmails: true };
};

module.exports = { maskText, maskRow, maskRows, maskOptsForTier, maskQueryForLog, maskDeep, maskDocRecord, maskStr, ID_KEYS, PERSONAL_DOMAINS, PERS_EMAIL_RE };
