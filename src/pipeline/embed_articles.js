#!/usr/bin/env node
/**
 * 조문 임베딩 생성 — bge-m3 (OpenRouter `baai/bge-m3` | 로컬 ollama `bge-m3`, 1024차원 네이티브)
 *
 * 사용법:
 *   EMBED_PROVIDER=openrouter node rag/embed_articles.js --pilot     # 파일럿: 인사·복무 관련 1만 건
 *   EMBED_PROVIDER=openrouter node rag/embed_articles.js             # 전량 (미처리분만, 재개 가능)
 *   EMBED_PROVIDER=openrouter node rag/embed_articles.js --limit 50000
 *   node rag/embed_articles.js --dry-run   (EMBED_PROVIDER 필요)   # 대기열·검사만, API 호출 없음
 *
 * 전제: load_pg.js 적재 + article_hash/embed_queue/article_embeddings 테이블 존재
 * 체크포인트: article_embeddings 에 저장된 해시는 자동 건너뜀 (중단 후 재실행 = 재개, 멱등)
 * 키: .env.aiapi 의 `EMBED_KEY_ENV`(기본 OPENROUTER_API_KEY_BGEM3_ALL = 전량용. 시험은 OPENROUTER_API_KEY_BGEM3 지정). 키 값은 출력하지 않는다.
 *
 * 환경변수(전부 선택)
 *   EMBED_BATCH=32            API 1회당 텍스트 수          EMBED_CONCURRENCY=8   동시 요청 수
 *   EMBED_BUDGET_USD=18       비용 가드(openrouter 기본 18, 0=끔) — 응답 usage.cost 누적, 도달 시 새 배치 중단·rc=3·재개 가능
 *   EMBED_STATE_FILE=<경로>   비용 누적 상태(기본 ops/logs/embed_state_<model>.json) — 재개 시 이어서
 *   EMBED_PROVIDER_ONLY=a,b   OpenRouter 요청에 provider:{only:[a,b]} (기본 꺼짐)
 *   EMBED_RETRY_MAX=8         429/5xx/네트워크 오류 지수 백오프 재시도 횟수(2s,4s,8s… 상한 120s, Retry-After 존중)  EMBED_RETRY_BASE_MS=2000 첫 대기
 *   EMBED_PRICE_PER_MTOK      usage.cost 가 없는 공급자용 대체 단가(선택)
 *   EMBED_URL                 openrouter 엔드포인트 재정의(시험용 목 서버)
 *   EMBED_KEY_ENV             키 변수 이름 재정의(기본 OPENROUTER_API_KEY_BGEM3_ALL)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { EMBED_CUT, EMBED_DIM, ALLOWED_MODELS } = require('./embed_spec');
const { createEmbedClient, EmbedError } = require('./embed_client');

const ROOT = path.join(__dirname, '..');
// bge-m3 는 1024 네이티브(dimensions 파라미터 없음 — 주면 400). 컬럼 vector(1024).
// ⚠️ search.js 의 질의 인코더와 **같은 모델 계열(bge-m3)·같은 차원**이어야 한다 — 어긋나면 오류가 아니라 **오답**이 난다.
//    문서=openrouter / 질의=ollama 는 «같은 모델의 다른 서빙»(E3 실측: 같은 문장 코사인 min 0.99923).
const DIM = EMBED_DIM;
const MAX_CHARS = EMBED_CUT;   // alio_embed_text() 의 컷과 «같은 상수» — 시작 시 DB 함수 정의와 대조한다(아래 preflight)

// ── 임베딩 공급자 ────────────────────────────────────────────────────────────
// 기본값을 두지 않는다(명시 필수): 무인 델타가 NVIDIA/bge-m3 를 섞은 전례. 증분 경로(openrouter|ollama)는 미정 — 코드는 env 로 고른다.
const PROVIDERS = {
  openrouter: {
    url: process.env.EMBED_URL || 'https://openrouter.ai/api/v1/embeddings',
    model: 'baai/bge-m3', isolate400: false, keyEnv: process.env.EMBED_KEY_ENV || 'OPENROUTER_API_KEY_BGEM3_ALL', trackCost: true,
    body: (texts, model) => ({ model, input: texts }),
    pick: (j) => (j.data || []).map(x => x.embedding),
  },
  ollama: {
    url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/embed',
    model: process.env.EMBED_MODEL || 'bge-m3', isolate400: true, keyEnv: null, trackCost: false, timeoutMs: 600000,
    // truncate:false — 컨텍스트 초과 입력을 조용히 자르지 않고 400 으로 드러낸다.
    body: (texts, model) => ({ model, input: texts, truncate: false }),
    pick: (j) => j.embeddings,
  },
};
const PROVIDER = process.env.EMBED_PROVIDER;
if (!PROVIDER) { console.error('EMBED_PROVIDER 필수 (openrouter | ollama). 기본값 없음'); process.exit(2); }
const P = PROVIDERS[PROVIDER];
if (!P) { console.error(`알 수 없는 EMBED_PROVIDER=${PROVIDER} (가능: ${Object.keys(PROVIDERS).join(', ')})`); process.exit(2); }
const MODEL = P.model;

const intEnv = (k, d) => { const v = parseInt(process.env[k] || '', 10); return v > 0 ? v : d; };
const BATCH = intEnv('EMBED_BATCH', 32);              // API 1회당 텍스트 수
const CONCURRENCY = intEnv('EMBED_CONCURRENCY', 8);
const FETCH_CHUNK = BATCH * CONCURRENCY * 8;          // DB에서 한 번에 가져올 미처리 건수
const PILOT_RE = '평가|평정|연차|휴가|휴직|임금|보수|징계|복무';
const BUDGET_USD = P.trackCost ? parseFloat(process.env.EMBED_BUDGET_USD || '18') : parseFloat(process.env.EMBED_BUDGET_USD || '0');
const STATE_FILE = process.env.EMBED_STATE_FILE
  || path.join(ROOT, 'ops', 'logs', `embed_state_${MODEL.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
const PROVIDER_ONLY = (process.env.EMBED_PROVIDER_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const DRY = process.argv.includes('--dry-run');
// 컨텍스트 초과 등으로 HTTP 400 을 받는 «나쁜 입력»(ollama 경로): 기본=격리 후 text_hash 와 함께 중단, EMBED_SKIP_BAD=1 이면 기록하고 건너뜀.
const SKIP_BAD = process.env.EMBED_SKIP_BAD === '1';
const FAIL_FILE = process.env.EMBED_FAILURES_FILE || path.join(path.dirname(STATE_FILE), 'embed_failures.tsv');
if (!DRY) fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

function loadEnv() {
  const env = {};
  for (const f of ['.env.api', '.env.aiapi']) {
    try {
      for (const l of fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)) {
        const m = l.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
        if (m) env[m[1]] = m[2].trim();
      }
    } catch (e) {}
  }
  return env;
}

function parseArgs(argv) {
  const a = { pilot: false, limit: 0, dry: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pilot') { a.pilot = true; a.limit = a.limit || 10000; }
    else if (argv[i] === '--limit') a.limit = parseInt(argv[++i]) || 0;
    // --dry-run: 대기열 조회·기동 검사까지만. API 를 부르지 않는다(쿼리가 성립하는지만 본다).
    else if (argv[i] === '--dry-run') a.dry = true;
  }
  return a;
}

// 기동 검사 — 「오류 없이 오답」 3종을 시작 전에 막는다. 실패 시 rc=4.
//  ① 모델 혼재: INSERT 가 ON CONFLICT (text_hash) DO NOTHING 이라 같은 해시에 다른 모델 벡터가 있으면 새 벡터가 조용히 버려진다.
//  ② 컬럼 차원: vector(1024) 가 아니면 중단.
//  ③ 입력 컷: DB 의 alio_embed_text() 가 이 코드의 MAX_CHARS 와 같은 컷을 쓰는지(낡은 함수 정의 방지).
async function preflight(c) {
  const bad = [];
  const models = (await c.query('SELECT DISTINCT model FROM article_embeddings')).rows.map(r => r.model);
  const alien = models.filter(m => !ALLOWED_MODELS.includes(m));
  if (alien.length) bad.push(`모델 혼재: article_embeddings.model 에 허용 밖 값 ${JSON.stringify(alien)} (허용 ${JSON.stringify(ALLOWED_MODELS)})`);
  if (!ALLOWED_MODELS.includes(MODEL)) bad.push(`이 실행의 모델 ${MODEL} 이 허용 집합 밖`);
  const typ = (await c.query(`SELECT format_type(atttypid, atttypmod) t FROM pg_attribute
                              WHERE attrelid = 'article_embeddings'::regclass AND attname = 'embedding'`)).rows[0];
  if (!typ || typ.t !== `vector(${DIM})`) bad.push(`article_embeddings.embedding 타입 ${typ && typ.t} ≠ vector(${DIM})`);
  const fn = (await c.query(`SELECT prosrc FROM pg_proc WHERE proname = 'alio_embed_text'`)).rows[0];
  if (!fn || !new RegExp(`,\\s*${MAX_CHARS}\\s*\\)`).test(fn.prosrc)) bad.push(`alio_embed_text() 의 컷이 ${MAX_CHARS} 가 아님(load_pg.js 를 다시 돌려 함수를 갱신)`);
  if (bad.length) { for (const b of bad) console.error('[preflight] ' + b); process.exit(4); }
  console.log(`[preflight] OK · 기존 모델 ${JSON.stringify(models)} · vector(${DIM}) · cut=${MAX_CHARS}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  // ollama 는 키가 없다(keyEnv=null) — 그 경우 검사를 건너뛴다.
  if (!args.dry && P.keyEnv && !env[P.keyEnv]) { console.error(`${P.keyEnv} 없음 (.env.aiapi) · provider=${PROVIDER}`); process.exit(1); }
  console.log(`[EMBED] provider=${PROVIDER} · model=${MODEL} · dim=${DIM} · cut=${MAX_CHARS} · batch=${BATCH} · conc=${CONCURRENCY}`
    + ` · key=${P.keyEnv || '(없음)'} · budget=${BUDGET_USD ? '$' + BUDGET_USD : '끔'} · providerOnly=${PROVIDER_ONLY.join('+') || '끔'}`);

  const c = new Client({
    host: process.env.ALIO_PGHOST || env.PGHOST || 'postgres', port: +(env.PGPORT || 5432),
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD,
    // 검증용 스크래치 DB를 가리킬 수 있어야 한다(load_pg와 동일 규약).
    database: process.env.PGDATABASE || 'alio_rag',
  });
  await c.connect();
  // 300s→900s (2026-07-18): 벡터 수백만 성장 후 대기열 안티조인이 동시 IO 부하와 겹쳐 중단되는 사고 — 재개 가능하지만 무인 완주를 위해 여유 확보
  await c.query("SET statement_timeout='900s'");
  await preflight(c);

  const client = DRY ? null : createEmbedClient({
    url: P.url, model: MODEL, apiKey: P.keyEnv ? env[P.keyEnv] : null, dim: DIM, timeoutMs: P.timeoutMs,
    body: texts => P.body(texts, MODEL), pick: P.pick, trackCost: P.trackCost,
    providerOnly: PROVIDER === 'openrouter' ? PROVIDER_ONLY : null,
    budgetUsd: BUDGET_USD, priceFallbackPerMTok: parseFloat(process.env.EMBED_PRICE_PER_MTOK || '0'),
    stateFile: BUDGET_USD || P.trackCost ? STATE_FILE : null,
    retry: { max: intEnv('EMBED_RETRY_MAX', 8), baseMs: intEnv('EMBED_RETRY_BASE_MS', 2000) }, log: m => console.log('  ' + m),
  });
  if (client) console.log(`[EMBED] 누적 비용(상태 파일 ${BUDGET_USD ? STATE_FILE : '없음'}): $${client.spentUsd().toFixed(4)} · 호출 ${client.state.calls}`);

  const pilotCond = args.pilot ? `AND a.title ~ '${PILOT_RE}'` : '';
  const t0 = Date.now();
  let done = 0, nBatch = 0;
  const skipped = new Set();   // EMBED_SKIP_BAD 로 건너뛴 text_hash — 이번 실행의 대기열 조회에서 제외(안 그러면 같은 행을 계속 다시 가져온다)

  while (true) {
    if (args.limit && done >= args.limit) break;
    if (client && client.halted()) break;
    const fetchN = args.limit ? Math.min(FETCH_CHUNK, args.limit - done) : FETCH_CHUNK;
    // 임베딩 입력은 **SQL 함수 alio_embed_text가 단일 출처**(2026-08-01) — 여기서 title+body를 다시 조립하지 않는다.
    // 컷(EMBED_CUT=3500)도 함수 안에서 끝난다. article_hash.prefixed = 이 청크가 문맥 접두를 받는지(고유 청크만 true).
    // 🔴 빈 본문 가드: 본문이 공백뿐인 행은 접두·제목만으로 «내용 없는 벡터»가 된다 → 대기열에서 제외(SQL 에서 걸러야
    //    안티조인이 같은 행을 영원히 다시 가져오지 않는다. load_pg 가 이미 적재 단계에서 거르지만 이중 방어).
    const { rows } = await c.query(`
      SELECT q.text_hash,
             alio_embed_text(a.title, a.body, i.inst_name, d.doc_title,
                             a.chapter, a.section, NULL, ah.prefixed) AS embed_text
      FROM embed_queue q
      JOIN articles a ON a.id = q.id
      JOIN article_hash ah ON ah.id = q.id
      JOIN documents d ON d.doc_id = a.doc_id
      LEFT JOIN institutions i ON i.inst_code = d.inst_code
      LEFT JOIN article_embeddings e ON e.text_hash = q.text_hash
      WHERE e.text_hash IS NULL AND btrim(coalesce(a.body, '')) <> '' ${pilotCond}
      AND q.text_hash <> ALL($2::text[])
      LIMIT $1`, [fetchN, [...skipped]]);
    if (!rows.length) break;

    // 컷 단언 — DB 함수가 어긋났다면 여기서 터뜨린다(코드포인트 기준 left()).
    const over = rows.find(r => r.embed_text && Array.from(r.embed_text).length > MAX_CHARS);
    if (over) throw new Error(`embed_text 길이 ${Array.from(over.embed_text).length} > MAX_CHARS ${MAX_CHARS} — DB 함수와 컷 불일치`);

    if (args.dry) {
      const nulls = rows.filter(r => r.embed_text == null).length;
      const lens = rows.map(r => Array.from(r.embed_text || '').length);
      console.log(`[dry-run] 대기열 조회 성립 — ${rows.length}건 · embed_text null ${nulls}건 · 길이 최소 ${Math.min(...lens)} 최대 ${Math.max(...lens)}`);
      if (nulls) { console.error('[dry-run] embed_text가 null인 행이 있다 — 조인이나 함수 인자가 어긋났다'); process.exitCode = 1; }
      break;
    }

    // 배치 슬라이스를 CONCURRENCY개씩 동시 처리 — API 왕복 대기를 병렬화. DB insert 는 단일 Client 라 뮤텍스로 직렬화.
    const slices = [];
    for (let i = 0; i < rows.length; i += BATCH) slices.push(rows.slice(i, i + BATCH));
    let dbLock = Promise.resolve();
    const withDb = async (fn) => {
      const prev = dbLock; let release;
      dbLock = new Promise(r => (release = r));
      await prev.catch(() => {});
      try { return await fn(); } finally { release(); }
    };

    let si = 0;
    const worker = async () => {
      while (si < slices.length) {
        if (client.halted()) return;                 // 비용 가드 — 새 배치 투입 중단(진행 중인 배치는 끝낸다)
        const slice = slices[si++];
        const texts = slice.map(r => r.embed_text || '');
        const { vecs, bad } = P.isolate400 ? await client.embedIsolate(texts) : { vecs: await client.embed(texts), bad: [] };

        const good = slice.map((r, i) => i).filter(i => vecs[i]);
        const hashes = good.map(i => slice[i].text_hash);
        // 전정밀도: toFixed(6) 로 깎지 않는다(pgvector 가 float4 로 파싱). 차원·유한성은 client 가 이미 단언했다.
        const vecStrs = good.map(i => '[' + vecs[i].join(',') + ']');
        if (good.length) await withDb(() => c.query(`
          INSERT INTO article_embeddings (text_hash, embedding, model)
          SELECT h, v::vector(${DIM}), '${MODEL}'
          FROM unnest($1::text[], $2::text[]) AS t(h, v)
          ON CONFLICT (text_hash) DO NOTHING`, [hashes, vecStrs]));

        // 격리된 나쁜 입력 — 정상 입력의 벡터는 위에서 이미 저장했다(재실행해도 같은 배치에서 멈추지 않는다).
        if (bad.length) {
          const desc = bad.map(b => ({ hash: slice[b.index].text_hash, len: Array.from(slice[b.index].embed_text || '').length, why: b.message.replace(/[\t\r\n]+/g, ' ').slice(0, 160) }));
          if (!SKIP_BAD) throw new Error(`임베딩 입력 거부(HTTP 400) ${desc.length}건 격리: `
            + desc.slice(0, 5).map(d => `text_hash=${d.hash} 길이=${d.len} (${d.why})`).join(' | ')
            + ` — 건너뛰려면 EMBED_SKIP_BAD=1 (embed_failures.tsv 에 기록)`);
          if (!fs.existsSync(FAIL_FILE)) fs.writeFileSync(FAIL_FILE, 'text_hash\tlength\treason\n');
          fs.appendFileSync(FAIL_FILE, desc.map(d => `${d.hash}\t${d.len}\t${d.why}\n`).join(''));
          desc.forEach(d => skipped.add(d.hash));
        }

        done += good.length; nBatch++;
        const min = (Date.now() - t0) / 60000;
        console.log(`[batch ${nBatch}] +${good.length} · 누적 ${done}건 · ${(done / min).toFixed(0)}건/분`
          + ` · 비용 $${client.spentUsd().toFixed(4)}${BUDGET_USD ? '/' + BUDGET_USD : ''} · 토큰 ${client.state.tokens}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slices.length) }, worker));
  }

  const s = await c.query('SELECT count(*) n FROM article_embeddings');
  console.log(`종료: 이번 실행 ${done}건, 누적 ${s.rows[0].n}건, ${((Date.now() - t0) / 60000).toFixed(1)}분`
    + (client && client.state.tokens ? ` · 토큰 ${client.state.tokens} · 누적 비용 $${client.spentUsd().toFixed(4)} · 재시도 ${client.state.retries}` : ''));
  await c.end();
  if (skipped.size) console.error(`\n!!! 건너뛴 ${skipped.size}건 (HTTP 400 — 입력 거부) — 목록: ${FAIL_FILE}. 이 해시는 임베딩이 «없다»: 원인(컨텍스트 초과 등)을 고친 뒤 재실행해야 채워진다 !!!\n`);
  if (client && client.halted()) { console.error(`비용 상한 $${BUDGET_USD} 도달 — 정지(재개: 같은 명령 재실행. 상한을 올리려면 EMBED_BUDGET_USD 증액 후 사람이 판단)`); process.exit(3); }
}

main().catch(e => { console.error('실패:', e instanceof EmbedError ? `${e.message} (status ${e.status})` : e.message); process.exit(1); });
