#!/usr/bin/env node
/**
 * documents.usecases(text[]) 활용처 태그 백필 — RAG에서 활용처 필터 지원.
 * 매핑은 collection/classify_usecase.js(단일 출처)의 CODE_MAP/KEYWORD_MAP 재사용.
 *  - disclosure: category(예: 31301_재무성과, B1210_국회지적사항)의 코드 → alioUsecases
 *  - bylaws/legal: doc_title 키워드 → keywordUsecases (legal 미매칭은 _shared)
 *  - ca: 단체협약 → ['labor'] 고정
 * 재실행 안전: 컬럼 없으면 생성, 전체 재계산 upsert.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { alioUsecases, keywordUsecases } = require('../collection/classify_usecase.js');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const env = {};
  for (const l of fs.readFileSync(path.join(ROOT, '.env.api'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

// 진행 로그 — 이 스크립트는 disclosure 단계가 끝나야 첫 출력이 나던 탓에 "멈춘 줄 알고" 두 번 실행 →
// 같은 테이블 락 경합으로 둘 다 대기하는 사고가 있었다(2026-07-25). 그래서 아래 3가지를 넣는다.
const t0 = Date.now();
const log = (...a) => console.log('[' + String(Math.round((Date.now() - t0) / 1000)).padStart(4) + 's]', ...a);

async function main() {
  const env = loadEnv();
  const host = env.PGHOST || 'postgres', port = +(env.PGPORT || 5432);
  log('접속 시도 ' + host + ':' + port + ' / alio_rag');
  const c = new Client({
    host, port, user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: 'alio_rag',
    connectionTimeoutMillis: 10000,       // 무한 대기 금지 — 네트워크 문제를 10초에 드러낸다
    statement_timeout: 0,
  });
  await c.connect();
  const n0 = await c.query(`SELECT count(*)::int n FROM documents`);
  log('접속 OK · documents ' + n0.rows[0].n.toLocaleString());

  // ── 중복 실행 가드 ──────────────────────────────────────────────────────
  // 이미 도는 백필이 있으면 **즉시 종료**한다. 락을 기다리며 조용히 멈추는 것보다 낫다.
  const busy = await c.query(
    `SELECT pid, state, now()-query_start AS dur FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND state = 'active' AND query ILIKE '%UPDATE documents%'`);   // 조회 쿼리 오탐 방지
  if (busy.rowCount) {
    console.error('❌ 이미 실행 중인 백필이 있다 — 중복 실행을 막는다. 아래 세션이 끝나거나 취소된 뒤 다시 실행하라.');
    for (const r of busy.rows) console.error(`   pid ${r.pid} · ${r.state} · ${r.dur}`);
    console.error('   취소: SELECT pg_cancel_backend(<pid>);');
    console.error('   ※ node를 kill해도 서버 쪽 UPDATE는 계속 돈다(락이 남는다).');
    await c.end(); process.exit(2);
  }

  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS usecases text[]`);
  log('usecases 컬럼 확인');

  // ① disclosure: distinct category 단위(수백 종)로 일괄 UPDATE
  const cats = await c.query(
    `SELECT DISTINCT category FROM documents WHERE corpus='disclosure' AND category IS NOT NULL`);
  let discRows = 0, discCats = 0;
  log('disclosure 카테고리 ' + cats.rows.length + '종 처리 시작');
  let ci = 0;
  for (const { category } of cats.rows) {
    ci++;
    const code = category.split('_')[0];
    const ucs = alioUsecases(code);
    if (!ucs.length) continue;
    const r = await c.query(
      `UPDATE documents SET usecases=$1, updated_by='backfill_usecase' WHERE corpus='disclosure' AND category=$2`,
      [ucs, category]);
    discRows += r.rowCount; discCats++;
    log(`  [${ci}/${cats.rows.length}] ${category} → ${ucs.join(',')} (${r.rowCount.toLocaleString()}행)`);
  }
  log(`disclosure 완료: ${discCats}/${cats.rows.length} 카테고리 매핑, ${discRows.toLocaleString()}행`);

  // ② ca: 단체협약 전체 → labor
  const ca = await c.query(`UPDATE documents SET usecases=ARRAY['labor'], updated_by='backfill_usecase' WHERE corpus='ca'`);
  log(`ca 완료: ${ca.rowCount.toLocaleString()}행 → ['labor']`);

  // ③ bylaws/legal: doc_title 키워드 매칭 (JS 계산 → unnest 일괄 UPDATE)
  for (const corpus of ['bylaws', 'legal']) {
    const docs = await c.query(`SELECT doc_id, doc_title FROM documents WHERE corpus=$1`, [corpus]);
    const ids = [], arrs = [];
    for (const d of docs.rows) {
      let ucs = keywordUsecases(d.doc_title || '');
      if (!ucs.length) {
        if (corpus === 'legal') ucs = ['_shared'];  // classify_usecase와 동일: 미매칭 법령은 공유참조
        else continue;                              // 내규 미매칭은 태그 없음(NULL)
      }
      ids.push(d.doc_id); arrs.push('{' + ucs.join(',') + '}');
    }
    let updated = 0;
    const BATCH = 5000;
    log(`${corpus}: 대상 ${docs.rows.length.toLocaleString()}행 중 태그 ${ids.length.toLocaleString()}행 · ${Math.ceil(ids.length / BATCH)}배치`);
    for (let i = 0; i < ids.length; i += BATCH) {
      const r = await c.query(
        `UPDATE documents d SET usecases=u.ucs::text[], updated_by='backfill_usecase'
           FROM unnest($1::text[], $2::text[]) AS u(doc_id, ucs)
          WHERE d.doc_id=u.doc_id`,
        [ids.slice(i, i + BATCH), arrs.slice(i, i + BATCH)]);
      updated += r.rowCount;
      log(`  ${corpus} 배치 ${Math.floor(i / BATCH) + 1}/${Math.ceil(ids.length / BATCH)} · 누적 ${updated.toLocaleString()}행`);
    }
    log(`${corpus} 완료: ${updated.toLocaleString()}/${docs.rows.length.toLocaleString()}행 태그`);
  }

  await c.query(`CREATE INDEX IF NOT EXISTS idx_docs_usecases ON documents USING gin (usecases)`);
  await c.query('ANALYZE documents');

  const stat = await c.query(
    `SELECT corpus, unnest(usecases) AS uc, count(*) FROM documents GROUP BY 1,2 ORDER BY 1,2`);
  log('활용처별 문서 수:');
  for (const r of stat.rows) console.log(`  ${r.corpus}/${r.uc}: ${r.count}`);

  await c.end();
}

main().catch(e => {
  console.error('실패:', e.message);
  if (/timeout|ECONNREFUSED|ENOTFOUND/i.test(e.message))
    console.error('  → PGHOST 도달 실패. 컨테이너 네트워크 확인: docker inspect -f "{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}" alio-pipeline postgres');
  process.exit(1);
});
