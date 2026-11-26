'use strict';
// REST 용 키별 한도 판정(2026-11-09). mcp_http.js 의 keyLimited 와 같은 규칙: limits{minute,sem_minute,day,sem_day} 가 있는 키는 IP 가 아니라 «키 id» 기준.
// 항목이 null 이면 «무제한» 이 아니라 전역 기본값(rlMax·semMax)으로 대체된다(MCP 와 동일). 사실상 무제한은 큰 값(상한 1e6)을 명시한다.
// 카운터는 이 프로세스(REST) 안에서만 센다 — MCP 와는 별개(경로별 한도). KST 자정에 일일 카운터 초기화, 파일에 원자적으로 주기 저장.
const fs = require('fs');
const kstDay = t => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const toKstMidnightSec = t => Math.max(1, Math.ceil((86400e3 - ((t + 9 * 3600e3) % 86400e3)) / 1000));
function makeKeyLimiter({ file = '', rlMax = 40, semMax = 10, now: nowFn = Date.now } = {}) {
  const dayCnt = new Map(), winHit = new Map(), winSem = new Map(); let dirty = false;
  const winOf = (m, id, now) => { const a = (m.get(id) || []).filter(t => now - t < 60000); m.set(id, a); return a; };
  const dayOf = (id, now) => { let v = dayCnt.get(id); if (!v || v.d !== kstDay(now)) { v = { d: kstDay(now), n: 0, s: 0 }; dayCnt.set(id, v); } return v; };
  if (file) { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')), today = kstDay(nowFn()); for (const [id, v] of Object.entries(j.c || {})) if (v && v.d === today && Number.isInteger(v.n) && Number.isInteger(v.s) && v.n >= 0 && v.s >= 0) dayCnt.set(id, v); } catch (e) { if (e.code !== 'ENOENT') console.error('[key-limits] 카운터 읽기 실패 — 0 에서 시작:', e.message); dirty = true; } }
  function flush() {
    if (!file || !dirty) return; dirty = false;
    try { const today = kstDay(nowFn()), c = {}; for (const [id, v] of dayCnt) if (v.d === today) c[id] = v; const tmp = file + '.tmp.' + process.pid; fs.writeFileSync(tmp, JSON.stringify({ v: 1, c }), { mode: 0o640 }); fs.renameSync(tmp, file); }
    catch (e) { dirty = true; console.error('[key-limits] 카운터 저장 실패(메모리로 계속):', e.message); }
  }
  if (file) setInterval(flush, 5000).unref();
  // who: {id, limits}. sem: 이 호출이 의미검색인가. 한도 초과면 {which,max,retry,text}, 아니면 null(통과하면 사용량 기록).
  function limited(who, sem, now = nowFn()) {
    const L = who && who.limits; if (!L) return null;
    const e = dayOf(who.id, now), wm = winOf(winHit, who.id, now), ws = winOf(winSem, who.id, now), mMax = L.minute || rlMax, sMax = L.sem_minute || semMax;
    const hit = (which, max, text, retry) => ({ which, max, retry, text });
    if (L.day && e.n + 1 > L.day) return hit('day', L.day, `일일 호출 한도(${L.day}회)를 넘었습니다. 한국시간 자정에 초기화됩니다.`, toKstMidnightSec(now));
    if (sem && L.sem_day && e.s + 1 > L.sem_day) return hit('sem_day', L.sem_day, `일일 의미검색 한도(${L.sem_day}회)를 넘었습니다. 한국시간 자정에 초기화됩니다.`, toKstMidnightSec(now));
    if (wm.length + 1 > mMax) return hit('minute', mMax, `분당 호출 한도(${mMax}회)를 넘었습니다. 잠시 후 다시 시도하세요.`, Math.max(1, Math.ceil((wm[0] + 60000 - now) / 1000)));
    if (sem && ws.length + 1 > sMax) return hit('sem_minute', sMax, `분당 의미검색 한도(${sMax}회)를 넘었습니다. 잠시 후 다시 시도하세요.`, Math.max(1, Math.ceil((ws[0] + 60000 - now) / 1000)));
    wm.push(now); if (sem) ws.push(now); e.n++; if (sem) e.s++; dirty = true; return null;
  }
  return { limited, flush, _dayCnt: dayCnt };
}
module.exports = { makeKeyLimiter, kstDay };
