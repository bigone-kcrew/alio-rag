'use strict';
// 사용자 등급 인증(10-19 사용자 결정): master(마스터 — 원문 확인) · internal(서버 내부 호출) · external(발급 키).
//  - internal: ① 내부 전용 포트(INTERNAL_PORT, 게이트웨이·프록시에 노출 금지)로 들어온 요청 ② 서비스 키(RAG_API_KEY, 기존 연동 호환)
//  - external: 발급 키(sha256 해시만 파일에 보관, 만료·폐기). 키 없음·불명확·파일 손상 → 거부(fail-closed). RAG_OPEN=1 이면 익명 external.
//  - master: RAG_MASTER_KEY. 개인정보 원문은 적재 시점에 마스킹되어 DB·임베딩에 없고, 원문은 md 파일에만 있다.
const fs = require('fs'), crypto = require('crypto');
const sha = x => crypto.createHash('sha256').update(String(x)).digest('hex');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// RT-15(10-19): 내부 포트는 «포트 번호» 만으로 internal 로 보지 않는다 — 요청 원본 주소(소켓 remote)가 허용 CIDR 일 때만. 기본 허용 = 루프백(127.0.0.0/8·::1).
//   같은 docker 네트워크의 다른 컨테이너가 키 없이 internal 이 되던 문제 방지. 허용 대역은 INTERNAL_ALLOW_CIDR(쉼표 구분)로 명시.
const ip4 = s => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s); return m ? (((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4]) >>> 0 : null; };
const ip6 = s => { s = String(s).split('%')[0]; if (!/^[0-9a-f:]+$/i.test(s) || !s.includes(':')) return null; const parts = s.split('::'); if (parts.length > 2) return null;
  const h = x => (x ? x.split(':') : []); const a = h(parts[0]), b = parts.length === 2 ? h(parts[1]) : []; const miss = 8 - a.length - b.length;
  if ((parts.length === 1 && a.length !== 8) || miss < 0 || (parts.length === 2 && miss < 1)) return null; const all = [...a, ...Array(parts.length === 2 ? miss : 0).fill('0'), ...b];
  if (all.length !== 8 || all.some(x => !/^[0-9a-f]{1,4}$/i.test(x))) return null; return all.reduce((v, x) => (v << 16n) | BigInt(parseInt(x, 16)), 0n); };
// RT2-12: 허용 목록에 «잘못된 항목»(비트 수 >32/>128·숫자 아님·주소 파싱 실패)이 하나라도 있으면 목록 전체를 무효로 보고 모두 거부한다(fail-closed) — 오타가 조용히 «다른 대역 허용» 이나 «무시» 가 되지 않게.
function cidrAllows(list, addr) {
  addr = String(addr || '').replace(/^::ffff:/i, '');
  const items = String(list).split(',').map(x => x.trim()).filter(Boolean); let hit = false;
  for (const c of items) {
    const [net, bits] = c.split('/');
    const v6 = net.includes(':');
    const maxb = v6 ? 128 : 32;
    if (bits !== undefined && (!/^\d{1,3}$/.test(bits) || +bits > maxb)) return false;
    const nb = bits === undefined ? maxb : +bits;
    if (v6) { const n = ip6(net); if (n === null) return false; const a = ip6(addr); if (a === null) continue;
      const mask = nb === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - nb)) - 1n); if ((a & mask) === (n & mask)) hit = true; continue; }
    const n = ip4(net); if (n === null) return false; const a = ip4(addr); if (a === null) continue;
    const mask = nb === 0 ? 0 : (~0 << (32 - nb)) >>> 0; if (((a & mask) >>> 0) === ((n & mask) >>> 0)) hit = true;
  }
  return hit;
}
// 2026-10-26(셀프 서비스 키): 키 항목의 선택 필드 — limits(키별 한도)·expires_at(expires 와 같은 뜻의 별칭, 둘 다 있으면 둘 다 통과해야 함)·scope(같은 값을 넘긴 makeAuth 에서만 유효).
//   세 필드가 모두 없는 기존 키는 반환 객체·동작이 종전과 같다. 필드가 있는데 형식이 틀리면 키를 거부한다(fail-closed — 오타가 «한도 없음» 이 되지 않게).
const LIMIT_KEYS = ['minute', 'sem_minute', 'day', 'sem_day', 'batch'];
function normLimits(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
  if (Object.keys(l).some(x => !LIMIT_KEYS.includes(x))) return null;
  const o = {};
  for (const x of LIMIT_KEYS) { const v = l[x]; if (v === undefined || v === null) { o[x] = null; continue; } if (!Number.isInteger(v) || v < 1 || v > 1e6) return null; o[x] = v; }
  return o;
}
// 키 scope 판정(2026-11-10): 없음=어디서나 유효(종전) · 'mcp'/'rest'=그 접속구에서만 · 'both'=MCP·REST 모두 · 배열이면 그 안에 있을 때. makeAuth({scope}) 를 안 주면 ''(종전과 같게 scope 가 있는 키는 거부).
function scopeOk(ks, want) {
  if (ks === undefined) return true;
  if (ks === want) return true;
  if (ks === 'both') return want === 'mcp' || want === 'rest';
  return Array.isArray(ks) && ks.includes(want);
}
function makeAuth({ internalPort = 0, internalCidrs = '127.0.0.0/8,::1', serviceKey = '', masterKey = '', externalKeysFile = '', open = false, scope = '' } = {}) {
  let ext = new Map(), mtime = 0;
  const reload = () => {
    if (!externalKeysFile) return;
    try {
      const st = fs.statSync(externalKeysFile); if (st.mtimeMs === mtime) return; mtime = st.mtimeMs;
      ext = new Map(JSON.parse(fs.readFileSync(externalKeysFile, 'utf8')).filter(k => k && k.sha256).map(k => [k.sha256, k]));
    } catch { ext = new Map(); mtime = 0; }   // 파일 없음·손상 → 외부 키 없음(거부)
  };
  function authTier(req, key) {
    if (internalPort && req && req.socket && req.socket.localPort === internalPort && cidrAllows(internalCidrs, req.socket.remoteAddress)) return { tier: 'internal', id: 'internal-port', label: 'internal-probe' };   // 10-22: label = 질의 로그용 별칭(키 값 아님)
    key = String(key || '');
    if (key) {
      if (masterKey && eq(key, masterKey)) return { tier: 'master', id: 'master', label: 'master' };
      if (serviceKey && eq(key, serviceKey)) return { tier: 'internal', id: 'service-key', label: 'service-key' };
      reload(); const k = ext.get(sha(key));
      if (k && !k.revoked && (!k.expires || Date.parse(k.expires) > Date.now()) && (k.expires_at === undefined || Date.parse(k.expires_at) > Date.now()) && scopeOk(k.scope, scope) && (k.limits === undefined || normLimits(k.limits))) {
        const w = { tier: k.tier === 'internal' ? 'internal' : 'external', id: k.id || sha(key).slice(0, 8), owner: k.owner || null, label: typeof k.label === 'string' && k.label ? k.label : 'unlabeled-' + (k.tier === 'internal' ? 'internal' : 'external') };
        if (k.limits !== undefined) w.limits = normLimits(k.limits);   // 한도 필드가 있는 키만 limits 속성이 생긴다(없으면 객체 모양도 종전과 같음)
        return w;
      }   // 10-21: 서버 멤버 키는 tier:'internal'(그 값만 인정)
    }
    return open ? { tier: 'external', id: 'anonymous', label: 'anon' } : null;
  }
  return { authTier };
}
module.exports = { scopeOk, makeAuth, sha, cidrAllows };
