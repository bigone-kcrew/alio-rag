#!/usr/bin/env node
// HNSW 인덱스 DROP — 대량 임베딩 적재 전. 적재 중 그래프 증분 갱신비(128건당 ~18~32초)를
// 없애 API 한계 속도로 적재. 적재 완료 후 _create_hnsw.js로 재생성.
// ⚠️ DROP 동안 의미검색은 순차 스캔(느림). 키워드(pg_trgm)는 정상. 데이터 손실 없음(인덱스만).
'use strict';
const fs = require('fs'), path = require('path');
const { Client } = require(path.join(__dirname, '..', 'node_modules', 'pg'));
const ROOT = path.join(__dirname, '..');
const env = {};
for (const f of ['.env.api', '.env.aiapi']) { try { for (const l of fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) env[m[1]] = m[2].trim(); } } catch (e) {} }
(async () => {
  const c = new Client({ host: process.env.ALIO_PGHOST || env.PGHOST || 'postgres', port: +(env.PGPORT || 5432), user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: process.env.PGDATABASE || 'alio_rag' });
  await c.connect();
  const before = (await c.query("SELECT indexname FROM pg_indexes WHERE tablename='article_embeddings' AND schemaname=current_schema()")).rows.map(r => r.indexname);
  console.log('DROP 전 인덱스:', before.join(', ') || '(없음)');
  const t = Date.now();
  await c.query('DROP INDEX IF EXISTS idx_emb_hnsw');
  const after = (await c.query("SELECT indexname FROM pg_indexes WHERE tablename='article_embeddings' AND schemaname=current_schema()")).rows.map(r => r.indexname);
  console.log(`DROP 완료 (${((Date.now() - t) / 1000).toFixed(1)}s). 남은 인덱스: ${after.join(', ') || '(pkey만)'}`);
  console.log('→ 돌고 있는 임베딩 프로세스가 즉시 빨라진다(재기동 불필요). 완료 후 _create_hnsw.js 실행.');
  await c.end();
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
