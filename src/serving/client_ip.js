'use strict';
// 접속자 IP 판정(2026-11-09, 6단계). X-Forwarded-For 를 «믿을 수 있는 중계»가 보냈을 때만 쓴다.
//   XFF_TRUST=legacy(기본, 종전 동작 = 첫 항목을 무조건 신뢰) | strict(아래 조건일 때만 신뢰, 그 외는 실제 접속 주소)
//   신뢰 조건: ① 접속 상대(peer)가 TRUSTED_XFF_PEERS(CIDR 쉼표 목록)에 있음  또는  ② 헤더 X-Proxy-Auth 가 PROXY_XFF_KEY 와 같음(상수시간 비교)
//   신뢰할 때는 XFF 의 «마지막» 항목을 쓴다(프록시가 덧붙인 값 — 클라이언트가 앞에 붙인 위조값을 무시).
//   XFF_PEER_LOG=1 이면 사설·루프백 peer 와 XFF 유무만 5분에 한 번 로그(공인 IP 는 «public» 으로만 표기) — Caddy 가 어떤 peer 로 보이는지 측정용.
const crypto = require('crypto');
const { cidrAllows } = require('./auth_tier');
const E = process.env;
const peerOf = req => String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
const isPriv = ip => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fe80:|fd)/i.test(ip);
const eqSecret = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const seen = new Map(); let lastLog = 0;
function peerLog(peer, hasXff, hasKey) {
  if (E.XFF_PEER_LOG !== '1') return;
  const k = (isPriv(peer) ? peer : 'public') + '|xff=' + hasXff + '|key=' + hasKey; seen.set(k, (seen.get(k) || 0) + 1);
  const now = Date.now(); if (now - lastLog < 300000) return; lastLog = now;
  console.error('[client-ip] peers(5분):', JSON.stringify(Object.fromEntries(seen))); seen.clear();
}
function clientIp(req) {
  const peer = peerOf(req), xffRaw = req.headers['x-forwarded-for'], list = String(xffRaw || '').split(',').map(s => s.trim()).filter(Boolean);
  const keyOk = !!E.PROXY_XFF_KEY && eqSecret(req.headers['x-proxy-auth'], E.PROXY_XFF_KEY);
  peerLog(peer, !!list.length, keyOk);
  if (!list.length) return peer || 'unknown';
  if ((E.XFF_TRUST || 'legacy') !== 'strict') return list[0] || peer || 'unknown';          // 종전 동작(첫 항목)
  const peersOk = !!E.TRUSTED_XFF_PEERS && peer && cidrAllows(E.TRUSTED_XFF_PEERS, peer);
  return (peersOk || keyOk) ? list[list.length - 1] : (peer || 'unknown');
}
module.exports = { clientIp, peerOf };
