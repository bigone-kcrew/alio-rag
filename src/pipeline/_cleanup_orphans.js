#!/usr/bin/env node
// 고아 벡터 정리 — 현재 article_hash와 조인 안 되는 stale 벡터(과거 콘텐츠) 삭제.
// HNSW 재생성 전에 실행해야 유효분(~1.95M)만 인덱싱된다. HNSW DROP 상태라 DELETE도 빠름.
'use strict';
const fs = require('fs'), path = require('path');
const { Client } = require(path.join(__dirname, '..', 'node_modules', 'pg'));
const ROOT = path.join(__dirname, '..');
const env = {};
for (const f of ['.env.api', '.env.aiapi']) { try { for (const l of fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) env[m[1]] = m[2].trim(); } } catch (e) {} }
(async () => {
  const c = new Client({ host: process.env.ALIO_PGHOST || env.PGHOST || 'postgres', port: +(env.PGPORT || 5432), user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: process.env.PGDATABASE || 'alio_rag' });
  await c.connect();
  const before = (await c.query('SELECT count(*) n FROM article_embeddings')).rows[0].n;
  const orphan = (await c.query('SELECT count(*) n FROM article_embeddings e WHERE NOT EXISTS(SELECT 1 FROM article_hash h WHERE h.text_hash=e.text_hash)')).rows[0].n;
  console.log(`삭제 전 총 ${Number(before).toLocaleString()} · 고아 ${Number(orphan).toLocaleString()}`);
  const t = Date.now();
  const r = await c.query('DELETE FROM article_embeddings e WHERE NOT EXISTS(SELECT 1 FROM article_hash h WHERE h.text_hash=e.text_hash)');
  const after = (await c.query('SELECT count(*) n FROM article_embeddings')).rows[0].n;
  console.log(`삭제 ${r.rowCount} (${((Date.now() - t) / 1000).toFixed(1)}s) → 남은 벡터 ${Number(after).toLocaleString()} (유효분만)`);
  console.log('다음: ! node rag/_create_hnsw.js (HNSW 벌크 재생성)');
  await c.end();
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
