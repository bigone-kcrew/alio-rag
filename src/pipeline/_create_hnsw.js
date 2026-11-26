#!/usr/bin/env node
// HNSW 인덱스 재생성 — 대량 임베딩 적재 완료 후 한 번에 벌크 빌드.
// 🔴 2026-10-06 결정: 저장은 vector(1024) 전정밀도, 인덱스는 halfvec «표현식» 인덱스
//    hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) — 크기 ≈ 절반. 질의는 search.js(SEM_INDEX=halfvec)가
//    «인덱스로 후보 N → 원본 vector 정확 재순위» 로 쓴다. 정의는 embed_spec.js(hnswCreateSql) 한 곳.
//    HNSW_INDEX_TYPE=vector 로 레거시(vector_cosine_ops) 빌드도 가능(이때 질의는 SEM_INDEX=vector).
// 벌크 빌드는 증분 삽입보다 빠르고 그래프 품질(연결성)도 같거나 낫다.
// 실행 전 권장: 고아 벡터 정리(DELETE ... NOT IN article_hash) 먼저 → 유효분만 인덱싱.
'use strict';
const fs = require('fs'), path = require('path');
const { Client } = require(path.join(__dirname, '..', 'node_modules', 'pg'));
const ROOT = path.join(__dirname, '..');
const { hnswCreateSql } = require('./embed_spec');
const env = {};
for (const f of ['.env.api', '.env.aiapi']) { try { for (const l of fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) env[m[1]] = m[2].trim(); } } catch (e) {} }
(async () => {
  const c = new Client({ host: process.env.ALIO_PGHOST || env.PGHOST || 'postgres', port: +(env.PGPORT || 5432), user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: process.env.PGDATABASE || 'alio_rag' });
  await c.connect();
  const TYPE = process.env.HNSW_INDEX_TYPE || 'halfvec';
  if (!['halfvec', 'vector'].includes(TYPE)) { console.error('HNSW_INDEX_TYPE 는 halfvec | vector'); process.exit(2); }
  const ex = await c.query("SELECT indexdef FROM pg_indexes WHERE indexname='idx_emb_hnsw' AND schemaname=current_schema()");
  if (ex.rowCount) {
    const half = /halfvec/i.test(ex.rows[0].indexdef);
    // 형태가 다른 인덱스가 «이미 있다»며 조용히 넘어가면 질의(SEM_INDEX)와 어긋나 전수 스캔이 된다 — 알리고 실패시킨다.
    if (half !== (TYPE === 'halfvec')) { console.error(`idx_emb_hnsw 가 이미 있으나 형태가 다름(${ex.rows[0].indexdef}) — 의도한 형태(${TYPE})로 바꾸려면 _drop_hnsw.js 먼저`); process.exit(3); }
    console.log('idx_emb_hnsw 이미 존재 — 스킵'); await c.end(); return;
  }
  const n = (await c.query('SELECT count(*) n FROM article_embeddings')).rows[0].n;
  console.log(`인덱싱 대상 벡터: ${Number(n).toLocaleString()} — HNSW 벌크 빌드 시작(형태=${process.env.HNSW_INDEX_TYPE || 'halfvec'} — 시간은 maintenance_work_mem 대 그래프 크기가 좌우, 실측 전엔 수 시간~이틀)`);
  // ⚠️ 병렬 빌드는 /dev/shm(공유메모리) 세그먼트를 쓰는데 이 컨테이너는 /dev/shm이 작아
  //   "could not resize shared memory segment ... No space left on device"로 실패한다(2026-07-19 실측).
  //   → 병렬 0(직렬 빌드)로 강제. 직렬은 /dev/shm 미사용이라 안전. 대신 느림.
  // 병렬 빌드는 /dev/shm 필요(기본 64MB로는 실패) — postgres 컨테이너 shm_size:2gb 로 키우면
  // max_parallel_maintenance_workers>0 로 멀티코어 빌드 가능(3분기 #20). 현재는 64MB라 직렬 강제.
  // (구 주석) 종전 기본값은 직렬 0 이었다 — 아래 2026-09-19 항목이 그 이유와 해소를 설명한다.
  // 🔴 2026-09-19: 기본값을 직렬(0)→병렬(4), 512MB→2GB 로 올린다.
  //    막고 있던 원인은 postgres 컨테이너의 `/dev/shm` 이 도커 기본 **64MB** 였던 것.
  //    신 서버에서 `shm_size: 2gb` 로 올려 해소했다(실측 `df -h /dev/shm` = 2.0G).
  //    안 올리면 구 서버 실측 **48.9시간** 직렬 빌드를 그대로 반복한다.
  //    ⚠️ shm 이 작은 환경으로 되돌아가면 아래 폴백이 직렬로 자동 강등한다.
  const PAR = parseInt(process.env.HNSW_PARALLEL_WORKERS || '4', 10);
  const MWM = process.env.HNSW_MAINT_WORK_MEM || '2GB';
  await c.query('SET max_parallel_maintenance_workers = ' + PAR);
  await c.query("SET maintenance_work_mem = '" + MWM + "'");     // 8GB 박스, postgres와 공유 — 보수적
  console.log(`  빌드 파라미터: parallel_workers=${PAR}${PAR ? ' (shm 상향 전제)' : ' (직렬·shm 불필요)'}, maintenance_work_mem=${MWM}`);
  await c.query("SET statement_timeout = 0"); // 빌드는 오래 걸리므로 무제한
  const t = Date.now();
  // ── 인덱스 파라미터 (2026-09-19 노출) ───────────────────────────────────────
  // 종전엔 WITH 절이 없어 pgvector 기본값(m=16, ef_construction=64)으로만 만들어졌다.
  // 벡터 358만 규모에서 기본값은 recall 이 아쉬운 쪽이다. m·ef_construction 을 올리면
  // recall 이 오르고 빌드 시간·인덱스 크기가 는다. **전량 재구축하는 지금이 고를 유일한 시점**이다
  // (나중에 바꾸려면 재생성 = 구 서버 기준 48.9h 짜리 작업이다).
  // 🔴 추측으로 올리지 말 것 — 올린 뒤 `eval_search.js --mode semantic` 으로 전후를 대조한다.
  // 🔴 2026-09-24 사용자 확정: ef_construction **64 → 128**.
  //   · 현재 DB 인덱스는 `WITH` 절 없이 만들어져 pgvector 기본(m=16, ef_construction=64)이다.
  //   · 128 은 AWS 의 한국어 하이브리드 검색 가이드 권고값이고, pgvector 문서도 64 를 낮은 축으로 본다.
  //   · m=16 은 그대로(권고와 동일). 인덱스 «크기» 는 m 이 정하므로 128 로 올려도 크기는 거의 같고,
  //     느는 것은 **빌드 시간**(대략 1.5~2배)뿐이다.
  //   🔴 기본값을 바꾼 이유: 「명시 안 하면 64」 로 두면 재적재 때 아무도 안 주고 지나간다.
  //     그리고 이 값은 **나중에 바꾸려면 인덱스 재생성 = 구 서버 기준 48.9h** 라 되돌리기가 비대칭이다.
  //   ⚠️ 우리 데이터로 recall 을 측정한 적은 없다 — 근거는 권고값과 되돌림 비용의 비대칭이다.
  //     검색 시 탐색 폭(`hnsw.ef_search`)은 **런타임**이라 언제든 조절 가능하니 그쪽을 먼저 쓸 것.
  const M   = parseInt(process.env.HNSW_M || '16', 10);
  // 🔴 2026-10-06 사용자 확정: 이번 빌드의 기본값은 m=16 · ef_construction=64(09-24 의 128 대신). 시험 중이라 둘 다 환경변수로 연다.
  const EFC = parseInt(process.env.HNSW_EF_CONSTRUCTION || '64', 10);
  console.log(`  인덱스 파라미터: m=${M}, ef_construction=${EFC}`);
  const CREATE_SQL = hnswCreateSql({ m: M, efc: EFC, type: TYPE });
  console.log('  ' + CREATE_SQL);
  try {
    await c.query(CREATE_SQL);
  } catch (e) {
    // 🔴 병렬 빌드는 /dev/shm 공유메모리 세그먼트를 쓴다. 작으면 여기서 죽는다.
    //    죽은 채로 두지 말고 «직렬로 강등해 완주»시킨다 — 느려도 끝나는 쪽이 낫다.
    //    그리고 그 사실을 로그에 크게 남긴다(조용히 느려지면 원인을 못 찾는다).
    if (!/shared memory segment|No space left on device/i.test(e.message)) throw e;
    console.error(`🔴 병렬 빌드 실패(/dev/shm 부족): ${e.message}`);
    console.error('   → 직렬로 강등해 계속한다. postgres 컨테이너에 shm_size: 2gb 를 주면 병렬이 가능하다.');
    await c.query('SET max_parallel_maintenance_workers = 0');
    await c.query(CREATE_SQL);
  }
  console.log(`CREATE 완료 (${((Date.now() - t) / 60000).toFixed(1)}분)`);
  await c.query('ANALYZE article_embeddings');
  console.log('ANALYZE 완료. 의미검색 인덱스 복구됨.');
  await c.end();
  // 세션 독립 완료 마커 — 장시간 작업은 세션 종속 Monitor가 세션 재시작 시 뻗으므로,
  // 파일 마커로 확인(재시작돼도 `test -f` 로 완료 판정). 실패 시엔 안 남음.
  try { fs.writeFileSync(path.join(ROOT, 'ops/logs/hnsw_build.done'),
    new Date().toISOString() + '\n', 'utf8'); } catch (e) {}
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
