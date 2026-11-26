#!/usr/bin/env python3
"""rag_ext 증분 갱신 — 일일 델타 적재 뒤 1회 호출. 변경된 문서만 재추출·교체한다.

  python3 rag_ext_refresh.py [--dry] [--only-code 20201,31301,70301,21211,B1210,B1010] [--inst C0064,C0035]
        [--limit N] [--max-sec 1800] [--sweep] [--schema rag_ext] [--summary out.json] [--state state.json]

그룹: A(페이지 필드 10코드) · D(재무 5코드) · B(70301 계약) · DISC(21211 징계) · FIND(B1210/B1220 지적) · RECR(B1010/B1020 채용)
판정: public.documents(corpus='disclosure') ↔ 파생 테이블의 (body_md5, 추출기 버전). body_md5 가 NULL 인 문서는 «파일 md5(f:…)» 로 비교하고,
      기록에 해시가 없던(스냅샷 적재) 문서는 파일 mtime 이 적재시각보다 늦은 경우만 «변경» 으로 본다(처음 한 번은 해시를 채택 기록).
쓰기: 문서 단위 트랜잭션(DELETE 자식 → DELETE 부모 → INSERT → 현행 재계산). 실패는 비치명 — 그 문서/그룹만 건너뛰고 계속, 요약 JSON 에 건수.
종료코드: 0 정상(문서 실패 포함) · 1 DB 접속 불가 등 치명 · 2 사용법 · 75 다른 실행이 가동 중.
운영 스키마(rag_ext)에 쓰려면 환경변수 RAG_EXT_PROD=1 필요(개발·시험 중 실수 방지). 시험은 --schema rag_ext_test.
"""
import argparse, collections, datetime, fcntl, hashlib, importlib, json, os, re, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
MD_ROOT = os.environ.get('MD_ROOT', './data/md/기관별공시') + '/'
A_CODES = ['10105', '20201', '20305', '20401', '20501', '20601', '21401', '21801', '40211', '70423']
A_CODES += ['20905', '31501', '31601', '32135', '32211', '70312', '70322', '70413', '70451', '80202', '80332', '80402']   # 20261124 DextA: xcodes.CODES 와 같아야 한다
D_CODES = ['31201', '31301', '31401', '31801', '31901']
GROUPS = {'A': A_CODES, 'D': D_CODES, 'B': ['70301'], 'DISC': ['21211'], 'FIND': ['B1210', 'B1220'], 'RECR': ['B1010', 'B1020']}
import b2_refresh   # 20261124: B 유형 확대(20701·21301·43009·21502·32001)
GROUPS['B2'] = b2_refresh.CODES
ORDER = ['A', 'D', 'B', 'DISC', 'FIND', 'RECR', 'B2']
# 운영 적재와 같은 버전 문자열(규칙을 고치면 올려서 전량 재처리된다)
B_VER, REC_VER = 'cp_v3', 'rec_v1'
SUMMARY_FLAGS = {'summary_row', 'total_row', 'aggregated_row', 'joint_dup_row_no'}
# 알림 임계(추정치 — 운영 기준선은 REPORT.md §알림): 신규·변경 0건 연속 일수 / 실패율 / 미분류율(적재 기준선 + 여유)
ZERO_STREAK = {'A': 7, 'D': 120, 'B': 45, 'DISC': 120, 'FIND': 7, 'RECR': 3, 'B2': 45}
FAIL_RATE, FAIL_MIN = 0.02, 3
UNMAPPED_MAX = {'21401': 0.65}; UNMAPPED_DEFAULT = 0.05      # A/D 셀 field_key NULL 비율(21401 은 적재 기준선 51%)
DISC_UNCLASS_MAX = 0.05; FIND_UNCLASS_MAX = {'B1210': 0.70, 'B1220': 0.10}


def log(*a):
    print('[%s]' % time.strftime('%F %T'), *a, flush=True)


def jd(o):  # PG jsonb 는 \u0000 을 거부한다
    return json.dumps(o, ensure_ascii=False).replace('\\u0000', '')


def chunks(L, n):
    for i in range(0, len(L), n):
        yield L[i:i + n]


def iso_ok(s):
    try:
        return bool(s) and datetime.date.fromisoformat(str(s)[:10]) is not None and len(str(s)) >= 10
    except ValueError:
        return False


# ------------------------------------------------------------------ DB (node pgq.js 어댑터)
class DB:
    def __init__(self, schema):
        self.S = schema; self.n = 0
        self.p = subprocess.Popen(['node', os.path.join(HERE, 'pgq.js')], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  text=True, encoding='utf-8', bufsize=1, env=dict(os.environ, ALIO_PGHOST=os.environ.get('ALIO_PGHOST', 'alio-pg')))

    def tx(self, stmts, tx=True):
        self.n += 1
        req = jd({'id': self.n, 'tx': tx, 'stmts': [{'sql': s.replace('{S}', self.S), 'params': p} for s, p in stmts]})
        self.p.stdin.write(req + '\n'); self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise ConnectionError('pgq 종료(접속 실패?)')
        r = json.loads(line)
        if not r['ok']:
            raise RuntimeError(r['error'])
        return r['res']

    def q(self, sql, *params):
        return self.tx([(sql, list(params))], tx=False)[0]['rows']

    def close(self):
        try: self.p.stdin.close(); self.p.wait(10)
        except Exception: self.p.kill()


# ------------------------------------------------------------------ 공통: documents 목록 · 변경 판정
def list_docs(db, regex, inst):
    sql = ("SELECT doc_id, rel_path, inst_code, coalesce(body_md5,'') md5, coalesce(meta->>'period_label','') pl, coalesce(meta->>'submitted_at','') sa, "
           "coalesce(meta->>'disclosure_no','') dno, coalesce(meta->>'dup_group','') dg, coalesce(doc_title,'') title, coalesce(doc_date,'') dd, "
           "coalesce(period_quarter,'') pq, coalesce(category,'') cat FROM public.documents WHERE corpus='disclosure' AND rel_path ~ $1")
    P = [regex]
    if inst:
        sql += ' AND inst_code = ANY($2)'; P.append(inst)
    docs = {}
    for r in db.q(sql + ' ORDER BY doc_id', *P):
        f = MD_ROOT + r['rel_path']
        try: r['fmtime'] = os.stat(f).st_mtime
        except OSError: r['fmtime'] = 0.0
        if not r['md5']:   # body_md5 NULL — 파일 md5 로 대신한다(없으면 'f:nofile')
            try: r['eff'] = 'f:' + hashlib.md5(open(f, 'rb').read()).hexdigest()
            except OSError: r['eff'] = 'f:nofile'
        else:
            r['eff'] = r['md5']
        docs[r['doc_id']] = r
    return docs


def classify(docs, recs, ver):
    """recs: doc_id -> {md5, ver, ts}. 반환 new, changed, adopt(해시 없던 기록에 해시 채택) — 삭제는 DB 대조(orphans)로 따로 구한다."""
    new, chg, adopt = [], [], []
    for i, d in docs.items():
        r = recs.get(i)
        if r is None: new.append(i)
        elif r['ver'] != ver: chg.append(i)
        elif r['md5'] == '':                                  # 스냅샷 적재 때 해시가 없던 문서: 적재 뒤 파일이 바뀌었으면 변경, 아니면 해시만 채택
            (chg if d['fmtime'] > (r['ts'] or 0) else adopt).append(i)
        elif r['md5'] != d['eff']: chg.append(i)
    return new, chg, adopt


def codes_of(g, a):
    """--only-code 에 이 그룹의 코드가 있으면 그것만, 그룹명이거나 다른 그룹 코드뿐이면 그룹 전체."""
    return [c for c in GROUPS[g] if c in a.only_code] or GROUPS[g]


def new_stats(**k):
    return dict(dict(target=0, new=0, changed=0, deleted=0, adopted=0, ok=0, failed=0, deferred=0, rows=0, failed_ids=[], error=None, metric={}), **k)


class Budget:
    def __init__(self, max_sec, limit): self.t0 = time.time(); self.max = max_sec; self.limit = limit
    def over(self): return time.time() - self.t0 > self.max


def pick(new, chg, limit):
    t = new + chg
    return (t[:limit], len(t) - limit) if limit and len(t) > limit else (t, 0)


def run_extractor(script, args, workdir, timeout=1800):
    r = subprocess.run([sys.executable, os.path.join(HERE, script)] + args, cwd=workdir, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError('%s rc=%d %s' % (script, r.returncode, (r.stderr or r.stdout)[-300:]))
    return r.stdout


def jl(path):
    if not os.path.exists(path): return
    with open(path, encoding='utf-8') as f:
        for ln in f:
            if ln.strip(): yield json.loads(ln)


# ------------------------------------------------------------------ A / D : doc_field_runs + doc_fields
RUN_INS = """INSERT INTO {S}.doc_field_runs (doc_id, inst_code, item_code, round_dir, period_label, period_label_adj, report_period, report_period_src, period_kind, group_period, data_year, base_date, submitted_at, disclosure_no, is_correction, orig_submit_date, body_md5, extractor_ver, n_fields, doc_flags, is_current)
SELECT j->>'doc_id', j->>'inst_code', j->>'item_code', j->>'round_dir', j->>'period_label', j->>'period_label_adj', j->>'report_period', j->>'report_period_src', j->>'period_kind',
 COALESCE(NULLIF(j->>'group_period',''), NULLIF(j->>'report_period',''), 'unknown'), NULLIF(j->>'data_year','')::int, rag_ext.safe_date(NULLIF(j->>'base_date','')), rag_ext.safe_date(NULLIF(j->>'submitted_at','')),
 j->>'disclosure_no', COALESCE((j->>'is_correction')::boolean,false), rag_ext.safe_date(NULLIF(j->>'orig_submit_date','')), $2::text, $3::text, COALESCE((j->>'n_fields')::int,0),
 COALESCE(ARRAY(SELECT jsonb_array_elements_text(j->'doc_flags')), '{}'), false
FROM (SELECT $1::jsonb AS j) s"""
FIELD_INS = """INSERT INTO {S}.doc_fields (doc_id, seq, inst_code, item_code, report_period, kind, table_idx, row_idx, col_idx, table_title, section, field_key, field_label, row_labels, col_label, col_key, col_kind, col_year, col_basis, col_quarter, is_last_col, value_raw, value_num, value_std, value_date, unit, unit_std, source_ref, parse_flags, entity_idx)
SELECT s.j->>'doc_id', (s.j->>'seq')::int, s.j->>'inst_code', s.j->>'item_code', r.group_period, COALESCE(s.j->>'kind','cell'), NULLIF(s.j->>'table_idx','')::int, NULLIF(s.j->>'row_idx','')::int, NULLIF(s.j->>'col_idx','')::int,
 s.j->>'table_title', s.j->>'section', s.j->>'field_key', COALESCE(s.j->>'field_label',''), ARRAY(SELECT jsonb_array_elements_text(s.j->'row_labels')), s.j->>'col_label', s.j->>'col_key', s.j->>'col_kind', NULLIF(s.j->>'col_year','')::int, s.j->>'col_basis', NULLIF(s.j->>'col_quarter','')::int,
 NULLIF(s.j->>'is_last_col','')::boolean, s.j->>'value_raw', NULLIF(s.j->>'value_num','')::numeric, NULLIF(s.j->>'value_std','')::numeric, rag_ext.safe_date(NULLIF(s.j->>'value_date','')), s.j->>'unit', s.j->>'unit_std', COALESCE(s.j->>'source_ref',''),
 COALESCE(ARRAY(SELECT jsonb_array_elements_text(s.j->'parse_flags')), '{}'), NULLIF(s.j->>'entity_idx','')::int
FROM jsonb_array_elements($1::jsonb) AS s(j) JOIN {S}.doc_field_runs r ON r.doc_id = s.j->>'doc_id'"""
# 공시번호를 여러 기관이 공유하면 disclosure_no_shared (영향받은 (항목, 공시번호) 쌍만 재판정; 공유가 풀리면 플래그 제거)
SHARED_SQL = """WITH p AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(item_code text, disclosure_no text)),
 sh AS (SELECT r.item_code, r.disclosure_no, count(DISTINCT r.inst_code) > 1 AS s FROM {S}.doc_field_runs r JOIN p USING (item_code, disclosure_no) GROUP BY 1, 2)
UPDATE {S}.doc_field_runs r SET doc_flags = CASE WHEN sh.s THEN array_append(array_remove(r.doc_flags,'disclosure_no_shared'),'disclosure_no_shared') ELSE array_remove(r.doc_flags,'disclosure_no_shared') END
FROM sh WHERE r.item_code = sh.item_code AND r.disclosure_no = sh.disclosure_no AND ('disclosure_no_shared' = ANY(r.doc_flags)) IS DISTINCT FROM sh.s"""
# 현행 재계산 — 영향 그룹만. A: (기관, 항목, group_period)별 값 있는(n_fields>0) 비공유 문서 중 제출일·공시번호 최신 1건
CURRENT_A = """WITH aff AS (
  SELECT DISTINCT inst_code, item_code, group_period FROM {S}.doc_field_runs r
   WHERE (r.item_code, r.disclosure_no) IN (SELECT item_code, disclosure_no FROM jsonb_to_recordset($1::jsonb) AS x(item_code text, disclosure_no text))
  UNION SELECT inst_code, item_code, group_period FROM jsonb_to_recordset($2::jsonb) AS y(inst_code text, item_code text, group_period text)),
 t AS (SELECT a.*, (SELECT x.doc_id FROM {S}.doc_field_runs x WHERE x.inst_code=a.inst_code AND x.item_code=a.item_code AND x.group_period=a.group_period
         AND x.n_fields > 0 AND NOT ('disclosure_no_shared' = ANY(x.doc_flags)) ORDER BY x.submitted_at DESC NULLS LAST, x.disclosure_no DESC NULLS LAST, x.doc_id DESC LIMIT 1) AS top FROM aff a)
UPDATE {S}.doc_field_runs r SET is_current = (r.doc_id IS NOT DISTINCT FROM t.top)
FROM t WHERE r.inst_code=t.inst_code AND r.item_code=t.item_code AND r.group_period=t.group_period AND r.is_current IS DISTINCT FROM (r.doc_id IS NOT DISTINCT FROM t.top)"""
# D: (기관, 코드)별 «값 있는 최신 문서»(d_field_extractor.finalize 와 같은 3단 폴백: 값 있고 비공유 → 값 있음 → 전부)
CURRENT_D = """WITH aff AS (
  SELECT DISTINCT inst_code, item_code FROM {S}.doc_field_runs r
   WHERE (r.item_code, r.disclosure_no) IN (SELECT item_code, disclosure_no FROM jsonb_to_recordset($1::jsonb) AS x(item_code text, disclosure_no text))
  UNION SELECT inst_code, item_code FROM jsonb_to_recordset($2::jsonb) AS y(inst_code text, item_code text)),
 t AS (SELECT a.*, (SELECT x.doc_id FROM {S}.doc_field_runs x WHERE x.inst_code=a.inst_code AND x.item_code=a.item_code
         ORDER BY CASE WHEN x.n_fields>0 AND NOT ('no_data_table'=ANY(x.doc_flags)) AND NOT ('no_values'=ANY(x.doc_flags)) AND NOT ('disclosure_no_shared'=ANY(x.doc_flags)) THEN 0
                       WHEN x.n_fields>0 AND NOT ('no_data_table'=ANY(x.doc_flags)) AND NOT ('no_values'=ANY(x.doc_flags)) THEN 1 ELSE 2 END,
                  x.submitted_at DESC NULLS LAST, x.disclosure_no DESC NULLS LAST, x.round_dir DESC, x.doc_id DESC LIMIT 1) AS top FROM aff a)
UPDATE {S}.doc_field_runs r SET is_current = (r.doc_id = t.top), superseded_by = CASE WHEN r.doc_id = t.top THEN NULL ELSE t.top END
FROM t WHERE r.inst_code=t.inst_code AND r.item_code=t.item_code
  AND (r.is_current IS DISTINCT FROM (r.doc_id = t.top) OR r.superseded_by IS DISTINCT FROM CASE WHEN r.doc_id = t.top THEN NULL ELSE t.top END)"""


def gp_of(d):
    return d.get('group_period') or d.get('report_period') or 'unknown'


def fields_apply(db, g, ver, d, F, eff, old, injected):
    if injected: raise RuntimeError('주입된 문서 실패(시험)')
    pairs, tuples = [], []
    for it, no, inst, gp in ([(d['item_code'], d.get('disclosure_no'), d['inst_code'], gp_of(d))] + ([(old['item_code'], old['dno'], old['inst_code'], old['gp'])] if old else [])):
        if no: pairs.append({'item_code': it, 'disclosure_no': no})
        tuples.append({'inst_code': inst, 'item_code': it, 'group_period': gp})
    st = [('DELETE FROM {S}.doc_fields WHERE doc_id=$1', [d['doc_id']]), ('DELETE FROM {S}.doc_field_runs WHERE doc_id=$1', [d['doc_id']]),
          (RUN_INS, [jd(d), eff, ver])]
    st += [(FIELD_INS, [jd(c)]) for c in chunks(F, 2000)]
    st += [(SHARED_SQL, [jd(pairs)]), (CURRENT_D if g == 'D' else CURRENT_A, [jd(pairs), jd(tuples)])]
    db.tx(st)


def fields_remove(db, g, rec):
    pairs = [{'item_code': rec['item_code'], 'disclosure_no': rec['dno']}] if rec['dno'] else []
    db.tx([('DELETE FROM {S}.doc_fields WHERE doc_id=$1', [rec['doc_id']]), ('DELETE FROM {S}.doc_field_runs WHERE doc_id=$1', [rec['doc_id']]),
           (SHARED_SQL, [jd(pairs)]), (CURRENT_D if g == 'D' else CURRENT_A, [jd(pairs), jd([{'inst_code': rec['inst_code'], 'item_code': rec['item_code'], 'group_period': rec['gp']}])])])


def recover_filter(docs):
    """A 그룹: content.md 문서는 그대로, 그 외는 «content.md 없는 폴더의 웹 기록 md»(field_extractor.body_files 가 고르는 것)만 남긴다. (Goldkv recover584)"""
    fe = importlib.import_module('field_extractor'); out = {}; cache = {}
    for i, d in docs.items():
        rp = d['rel_path']
        if rp.endswith('/content.md'): out[i] = d; continue
        dd, fn = os.path.split(MD_ROOT + rp); sub = os.path.dirname(dd)
        if sub not in cache: cache[sub] = set((r, f) for r, f in fe.body_files(sub))
        if (os.path.basename(dd), fn) in cache[sub]: out[i] = d
    return out


def run_fields(ctx, g):
    db, a, bud = ctx.db, ctx.a, ctx.bud
    codes = codes_of(g, a)
    mod = importlib.import_module('field_extractor' if g == 'A' else 'd_field_extractor')
    ver, script = mod.VERSION, ('field_extractor.py' if g == 'A' else 'd_field_extractor.py')
    S = new_stats(); ctx.stats[g] = S
    docs = list_docs(db, (r'/(%s)_[^/]*/[^/]*/(content\.md|[^/]*\(\d{8}\)\.md)$' if g == 'A' else r'/(%s)_[^/]*/[^/]*/content\.md$') % '|'.join(codes), a.inst)
    if g == 'A': docs = recover_filter(docs)
    runs = db.q("SELECT doc_id, inst_code, item_code, coalesce(disclosure_no,'') dno, group_period gp, coalesce(body_md5,'') md5, extractor_ver ver, extract(epoch from loaded_at)::float8 ts "
                "FROM {S}.doc_field_runs WHERE item_code = ANY($1)", codes)
    recs = {r['doc_id']: r for r in runs}
    new, chg, adopt = classify(docs, recs, ver)
    orphans = [r for r in db.q("SELECT r.doc_id FROM {S}.doc_field_runs r WHERE r.item_code = ANY($1) AND NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.doc_id=r.doc_id)", codes)]
    S.update(target=len(docs), new=len(new), changed=len(chg), deleted=len(orphans), adopted=len(adopt))
    log('%s 대상 %d · 신규 %d · 변경 %d · 삭제대상 %d · 해시채택 %d' % (g, len(docs), len(new), len(chg), len(orphans), len(adopt)))
    if a.dry: return
    for c in chunks(adopt, 500):
        db.tx([("UPDATE {S}.doc_field_runs r SET body_md5 = x.m FROM (SELECT * FROM jsonb_to_recordset($1::jsonb) AS y(i text, m text)) x WHERE r.doc_id = x.i",
                [jd([{'i': i, 'm': docs[i]['eff']} for i in c])])])
    targets, S['deferred'] = pick(new, chg, a.limit)
    bad = 0
    with tempfile.TemporaryDirectory(prefix='refresh_%s_' % g) as td:
        for bi, batch in enumerate(chunks(targets, 300)):
            if bud.over(): S['deferred'] += sum(len(b) for b in chunks(targets[bi * 300:], 300)); log(g, '시간 상한 — 나머지 이월'); break
            dm, ids, out, dout = [os.path.join(td, n) for n in ('dm.tsv', 'ids.txt', 'f.jsonl', 'd.jsonl')]
            with open(dm, 'w', encoding='utf-8') as f:
                for i in batch:
                    d = docs[i]
                    f.write('\t'.join(x.replace('\t', ' ').replace('\n', ' ') for x in (i, d['rel_path'], d['inst_code'], d['cat'], d['dd'], d['pq'], d['pl'], d['sa'], d['dno'], d['dg'], d['eff'])) + '\n')
            open(ids, 'w', encoding='utf-8').write('\n'.join(batch) + '\n')
            try:
                run_extractor(script, ['--docmap', dm, '--codes', ','.join(codes), '--out', out, '--docs', dout, '--only-ids', ids], HERE)
            except Exception as e:
                log(g, '추출기 실패:', e); S['failed'] += len(batch); S['failed_ids'] += batch[:5]; S['error'] = str(e)[:200]; bad += 1
                if bad >= 3: S['deferred'] += len(targets) - (bi + 1) * 300; S['error'] = '추출기 3회 연속 실패 — 중단'; break
                continue
            bad = 0
            byd = collections.defaultdict(list)
            for r in jl(out): byd[r['doc_id']].append(r)
            got = set()
            for d in jl(dout):
                i = d.get('doc_id'); got.add(i)
                if 'exception' in (d.get('doc_flags') or []):
                    S['failed'] += 1; S['failed_ids'].append(i); log(g, '추출 예외', i, d.get('error')); continue   # 옛 행은 그대로 둔다(다음 회차 재시도)
                F = byd.get(i, [])
                for r in F:
                    if r.get('kind') == 'cell':
                        m = S['metric'].setdefault(r['item_code'], [0, 0]); m[0] += 1; m[1] += r.get('field_key') is None
                try:
                    fields_apply(db, g, ver, d, F, docs[i]['eff'], recs.get(i), ctx.inject == g + ':doc' and S['ok'] + S['failed'] == 0)
                    S['ok'] += 1; S['rows'] += len(F)
                except Exception as e:
                    S['failed'] += 1; S['failed_ids'].append(i); log(g, '적재 실패', i, str(e)[:200])
            for i in batch:
                if i not in got: S['failed'] += 1; S['failed_ids'].append(i); log(g, '추출 결과 없음(파일 없음?)', i)
    sweep_generic(ctx, g, S, orphans, len(recs), lambda i: fields_remove(db, g, recs[i]))


def sweep_generic(ctx, g, S, orphans, total, remover):
    if not ctx.a.sweep or ctx.a.dry or not orphans: return
    if len(orphans) > max(50, 0.05 * total):
        S['error'] = 'sweep 차단: 삭제대상 %d > 한도(%d) — documents 비정상 의심, --force-sweep 필요' % (len(orphans), max(50, int(0.05 * total)))
        if not ctx.a.force_sweep: log(g, S['error']); S['sweep_blocked'] = True; return
    n = 0
    for r in orphans:
        i = r['doc_id'] if isinstance(r, dict) else r
        try: remover(i); n += 1
        except Exception as e: log(g, 'sweep 실패', i, str(e)[:200])
    S['swept'] = n; log(g, 'sweep 삭제 %d' % n)


# ------------------------------------------------------------------ DISC / FIND : extract_log 기준
LOG_UP = """INSERT INTO {S}.extract_log (doc_id, tbl, body_md5, ver, status, n_rows, dup_of, base_date, submitted_date, extracted_at)
SELECT j->>'doc_id', $2::text, j->>'body_md5', j->>'ver', j->>'status', COALESCE((j->>'n_rows')::int,0), j->>'dup_of', rag_ext.safe_date(NULLIF(j->>'base_date','')), rag_ext.safe_date(NULLIF(j->>'submitted_date','')), now()
FROM (SELECT $1::jsonb AS j) s
ON CONFLICT (tbl, doc_id) DO UPDATE SET body_md5=EXCLUDED.body_md5, ver=EXCLUDED.ver, status=EXCLUDED.status, n_rows=EXCLUDED.n_rows, dup_of=EXCLUDED.dup_of,
  base_date=EXCLUDED.base_date, submitted_date=EXCLUDED.submitted_date, extracted_at=now()"""
DATE_COLS = ('base_date', 'submitted_date', 'action_date', 'period_start', 'period_end')


def run_logged(ctx, g, tbl, regex, script, ver, outname, table, pk_rows):
    db, a, bud = ctx.db, ctx.a, ctx.bud
    S = new_stats(); ctx.stats[g] = S
    docs = list_docs(db, regex, a.inst)
    if g == 'FIND':   # 코드 한정(B1210 만 등)
        docs = {i: d for i, d in docs.items() if re.search(r'/(%s)_' % '|'.join(codes_of(g, a)), d['rel_path'])}
    recs = {r['doc_id']: r for r in db.q("SELECT doc_id, coalesce(body_md5,'') md5, ver, status, dup_of, extract(epoch from extracted_at)::float8 ts FROM {S}.extract_log WHERE tbl=$1", tbl)}
    new, chg, adopt = classify(docs, recs, ver)
    for i, r in recs.items():   # 대표 문서가 사라진 dup_of 는 다시 처리
        if r['status'] == 'dup_of' and i in docs and i not in chg and i not in new and r['dup_of'] not in docs: chg.append(i)
    orphans = [r['doc_id'] for r in db.q("SELECT l.doc_id FROM {S}.extract_log l WHERE l.tbl=$1 AND NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.doc_id=l.doc_id)", tbl)]
    S.update(target=len(docs), new=len(new), changed=len(chg), deleted=len(orphans), adopted=len(adopt))
    log('%s 대상 %d · 신규 %d · 변경 %d · 삭제대상 %d · 해시채택 %d' % (g, len(docs), len(new), len(chg), len(orphans), len(adopt)))
    if a.dry: return
    for c in chunks(adopt, 500):
        st = [("UPDATE {S}.extract_log l SET body_md5 = x.m FROM (SELECT * FROM jsonb_to_recordset($1::jsonb) AS y(i text, m text)) x WHERE l.tbl=$2 AND l.doc_id = x.i", [jd([{'i': i, 'm': docs[i]['eff']} for i in c]), tbl])]
        if g == 'FIND': st.append(("UPDATE {S}.finding_meta f SET body_md5 = x.m FROM (SELECT * FROM jsonb_to_recordset($1::jsonb) AS y(i text, m text)) x WHERE f.doc_id = x.i", [jd([{'i': i, 'm': docs[i]['eff']} for i in c])]))
        db.tx(st)
    targets, S['deferred'] = pick(new, chg, a.limit)
    bad = 0
    with tempfile.TemporaryDirectory(prefix='refresh_%s_' % g) as td:
        for bi, batch in enumerate(chunks(targets, 500)):
            if bud.over(): S['deferred'] += len(targets) - bi * 500; log(g, '시간 상한 — 나머지 이월'); break
            tsv, od = os.path.join(td, 'docs.tsv'), os.path.join(td, 'out')
            with open(tsv, 'w', encoding='utf-8') as f:
                for i in batch:
                    d = docs[i]
                    f.write('\t'.join(x.replace('\t', ' ').replace('\n', ' ') for x in (i, d['rel_path'], d['inst_code'], d['dg'], d['eff'], d['pl'], d['sa'], d['title'], d['dd'], d['pq'], d['dno'], '')) + '\n')
            try:
                run_extractor(script, ['--docs', tsv, '--out', od], HERE)
            except Exception as e:
                log(g, '추출기 실패:', e); S['failed'] += len(batch); S['failed_ids'] += batch[:5]; S['error'] = str(e)[:200]; bad += 1
                if bad >= 3: S['deferred'] += len(targets) - (bi + 1) * 500; S['error'] = '추출기 3회 연속 실패 — 중단'; break
                continue
            bad = 0
            rows = collections.defaultdict(list)
            for r in jl(os.path.join(od, outname)): rows[r['doc_id']].append(r)
            logs = {l['doc_id']: l for l in jl(os.path.join(od, 'extract_log.jsonl'))}
            for i in batch:
                l = logs.get(i)
                if l is None: S['failed'] += 1; S['failed_ids'].append(i); log(g, '로그 없음(파일 없음?)', i); continue
                R = rows.get(i, [])
                try:
                    if ctx.inject == g + ':doc' and S['ok'] + S['failed'] == 0: raise RuntimeError('주입된 문서 실패(시험)')
                    for r in R:
                        for c in DATE_COLS:
                            if c in r and r[c] and not iso_ok(r[c]): r[c] = None
                    if g == 'DISC': R = [r for r in R if r.get('action_date')]   # action_date NOT NULL — 달력에 없는 날짜 행은 제외(건수 로그)
                    if g == 'DISC':
                        for r in R:
                            m = S['metric'].setdefault('rows', [0, 0]); m[0] += not r.get('is_placeholder'); m[1] += (not r.get('is_placeholder')) and not r.get('type_base')
                    else:
                        for r in R:
                            m = S['metric'].setdefault(r['code'], [0, 0]); m[0] += 1; m[1] += not r.get('status_class')
                    st = [(pk_rows[0], [i])]
                    if R: st.append((pk_rows[1], [jd(R)]))
                    st.append((LOG_UP, [jd(l), tbl]))
                    db.tx(st)
                    S['ok'] += 1; S['rows'] += len(R)
                except Exception as e:
                    S['failed'] += 1; S['failed_ids'].append(i); log(g, '적재 실패', i, str(e)[:200])
    sweep_generic(ctx, g, S, orphans, len(recs), lambda i: db.tx([(pk_rows[0], [i]), ('DELETE FROM {S}.extract_log WHERE tbl=$1 AND doc_id=$2', [tbl, i])]))


def run_disc(ctx):
    ver = importlib.import_module('extract_discipline').VER
    run_logged(ctx, 'DISC', 'discipline_case', r'/21211_', 'extract_discipline.py', ver, 'discipline_case.jsonl', 'discipline_case',
               ('DELETE FROM {S}.discipline_case WHERE doc_id=$1',
                "INSERT INTO {S}.discipline_case SELECT x.* FROM jsonb_populate_recordset(NULL::{S}.discipline_case, $1::jsonb) x"))


def run_find(ctx):
    ver = importlib.import_module('extract_findings').VER
    run_logged(ctx, 'FIND', 'finding_meta', r'/(B1210|B1220)_.*/내용\.md$', 'extract_findings.py', ver, 'finding_meta.jsonl', 'finding_meta',
               ('DELETE FROM {S}.finding_meta WHERE doc_id=$1',
                "INSERT INTO {S}.finding_meta SELECT x.* FROM jsonb_populate_recordset(NULL::{S}.finding_meta, (SELECT jsonb_agg(e || jsonb_build_object('extract_ver','%s')) FROM jsonb_array_elements($1::jsonb) e)) x" % ver))


# ------------------------------------------------------------------ B : 계약(70301) contract_docs / contract_rows
BCOLS = ('doc_id', 'table_idx', 'table_row', 'inst_code', 'contract_year', 'row_no', 'contract_name', 'first_date', 'change_date', 'first_period', 'period_start', 'period_end',
         'change_period', 'first_amount', 'final_amount', 'amount_won', 'rep_name', 'counterparty_raw', 'counterparty_norm', 'content', 'reason', 'est_price',
         'contract_type', 'contract_method', 'item_name', 'unit_mult')
BDATES = ('first_date', 'change_date', 'period_start', 'period_end'); BINTS = ('first_amount', 'final_amount', 'amount_won', 'est_price', 'unit_mult')
B_DOC_INS = """INSERT INTO {S}.contract_docs (doc_id, inst_code, source_md_path, source_file, round_label, round_dir, submitted_at, target_year, group_key, body_md5, parser_ver, parse_status, n_rows, status, superseded_by, coverage_warn)
SELECT j->>'doc_id', j->>'inst_code', j->>'source_md_path', j->>'source_file', j->>'round_label', j->>'round_dir', rag_ext.safe_date(NULLIF(j->>'submitted_at','')), NULLIF(j->>'target_year','')::int,
 j->>'group_key', $2::text, $3::text, j->>'parse_status', (j->>'n_rows')::int, j->>'status', NULLIF(j->>'superseded_by',''), (j->>'coverage_warn')::boolean FROM (SELECT $1::jsonb AS j) s"""
B_ROW_INS = ("INSERT INTO {S}.contract_rows (%s) SELECT %s FROM jsonb_populate_recordset(NULL::{S}.contract_rows, $1::jsonb)"
             % (', '.join(BCOLS + ('is_summary', 'parse_flags')), ', '.join(BCOLS[:-1]) + ', COALESCE(unit_mult,1), COALESCE(is_summary,false), COALESCE(parse_flags,\'{}\')'))


# 데이터 층 후처리(운영 cfix_p1.sql 과 같은 규칙 — 새로 적재한 문서의 행에만 적용). 순서 중요: 합계행 표식 → 상대방 분류 → norm2 → 단위 의심.
B_POST = [
 """UPDATE {S}.contract_rows SET is_summary = true, parse_flags = array_append(parse_flags,'summary_by_name')
  WHERE doc_id=$1 AND NOT is_summary AND (contract_name ~ '^\\s*(합|소|총)\\s*계' OR contract_name ~ '^\\s*(합계|소계|총계|계)\\s*[\\(\\[]\\s*[0-9,]+\\s*건')""",
 """UPDATE {S}.contract_rows SET counterparty_class = CASE
   WHEN counterparty_norm IS NULL OR btrim(counterparty_norm) IN ('','-','－','—','–','.','(미상)') THEN 'empty'
   WHEN counterparty_norm ~ '[*＊]' OR counterparty_norm ~ '^[가-힣A-Za-z]{1,2}(OO|○○|ㅇㅇ|XX|xx|ΟΟ|oo|OOO|○○○|ㅇㅇㅇ|００)(\\(.*\\))?$' THEN 'person_masked'
   WHEN counterparty_norm ~ '^(\\(?개인\\)?|개인사업자|개인.*|해당\\s*없음|해당없음|비공개|\\(비공개\\)|미공개|기타|다수|외\\s*[0-9]+.*)$' THEN 'placeholder'
   ELSE 'company' END WHERE doc_id=$1""",
 """UPDATE {S}.contract_rows SET counterparty_norm2 = nullif(regexp_replace(regexp_replace(counterparty_norm, '(유한책임회사|유한회사|합자회사|합명회사|농업회사법인|영농조합법인|사회복지법인|의료법인|학교법인|재단법인|사단법인|\\(유\\)|\\(재\\)|\\(사\\)|\\(합\\)|\\(의\\)|\\(학\\))', '', 'g'), '[\\(\\)\\[\\]\\.,·\\-_/&]', '', 'g'), '')
  WHERE doc_id=$1 AND counterparty_class = 'company'""",
 # cp_v2 N7: 단위 표기 없는 천원 단위 문서 환산(저금액 가드보다 먼저)
 """UPDATE {S}.contract_rows r SET amount_won = coalesce(r.final_amount, r.first_amount) * 1000, first_amount = r.first_amount * 1000, final_amount = r.final_amount * 1000,
  est_price = r.est_price * 1000, unit_mult = 1000, parse_flags = array_append(r.parse_flags, 'unit_inferred_kwon')
  FROM (SELECT count(*) n, percentile_cont(0.5) WITHIN GROUP (ORDER BY first_amount) med, max(first_amount) mx FROM {S}.contract_rows
        WHERE doc_id=$1 AND first_amount > 0 AND unit_mult = 1 AND NOT is_summary AND NOT ('housing_lease_sheet'=ANY(parse_flags))) s
  WHERE r.doc_id=$1 AND s.n >= 10 AND s.med BETWEEN 10000 AND 100000 AND s.mx < 1000000 AND r.unit_mult = 1 AND NOT r.is_summary
  AND NOT ('housing_lease_sheet'=ANY(r.parse_flags)) AND NOT ('unit_declared_won'=ANY(r.parse_flags)) AND r.first_amount IS NOT NULL""",
 """UPDATE {S}.contract_rows r SET amount_won = NULL, parse_flags = array_append(r.parse_flags, CASE WHEN s.med > 3e9 THEN 'unit_suspect' ELSE 'unit_suspect_low' END)
  FROM (SELECT count(*) n, percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_won) med FROM {S}.contract_rows WHERE doc_id=$1 AND amount_won > 0 AND NOT is_summary AND NOT ('housing_lease_sheet'=ANY(parse_flags))) s
  WHERE r.doc_id=$1 AND s.n >= 10 AND (s.med > 3e9 OR (s.med < 3e5 AND NOT ('unit_declared_won' = ANY(r.parse_flags)))) AND r.amount_won IS NOT NULL""",   # cp_v2 F5b
 """UPDATE {S}.contract_rows SET amount_won = NULL, parse_flags = array_append(parse_flags,'unit_suspect_est')
  WHERE doc_id=$1 AND amount_won > 1000000000 AND est_price > 0 AND amount_won > est_price * 20 AND NOT ('amount_col_won_preferred_v2' = ANY(parse_flags))
  AND COALESCE((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY coalesce(x.final_amount, x.first_amount)::float8 / x.est_price) FROM {S}.contract_rows x
                WHERE x.doc_id=$1 AND x.est_price > 0 AND coalesce(x.final_amount, x.first_amount) > 0 HAVING count(*) >= 10), 1e9) > 5""",   # cp_v2 fix2: 문서 중앙값 비율이 5 이하(est 신뢰 불가)면 면제
 # 비정상 거액(>1조원): 운영 g5 보정과 같은 결과(보정 SQL 원문을 못 구해 운영 데이터에서 역추론 — 최대 비-NULL 금액이 정확히 1e12): 금액 비움 + amount_outlier, 단위 의심 표식은 대체
 """UPDATE {S}.contract_rows SET amount_won = NULL, parse_flags = array_append(array_remove(array_remove(array_remove(parse_flags,'unit_suspect'),'unit_suspect_low'),'unit_suspect_est'),'amount_outlier')
  WHERE doc_id=$1 AND coalesce(final_amount, first_amount) > 1000000000000
  AND NOT COALESCE(est_price > 0 AND coalesce(final_amount, first_amount) BETWEEN est_price * 0.5 AND est_price * 2, false)
  AND NOT ('amount_col_won_preferred_v2' = ANY(parse_flags))""",   # cp_v2 F5
 # cp_v2 F6: 천원·만원 라벨 표에서 같은 표 중앙값의 300배 초과(원값 100만 이상)인 행 = 표 내부 혼합 단위 → 금액 비움
 """UPDATE {S}.contract_rows r SET amount_won = NULL, parse_flags = array_append(r.parse_flags, 'unit_mixed')
  FROM (SELECT table_idx, percentile_cont(0.5) WITHIN GROUP (ORDER BY first_amount / unit_mult) med FROM {S}.contract_rows
        WHERE doc_id=$1 AND unit_mult > 1 AND first_amount > 0 AND NOT is_summary AND NOT ('housing_lease_sheet'=ANY(parse_flags)) GROUP BY table_idx HAVING count(*) >= 5) t
  WHERE r.doc_id=$1 AND r.table_idx = t.table_idx AND r.unit_mult > 1 AND NOT r.is_summary AND NOT ('housing_lease_sheet'=ANY(r.parse_flags))
  AND r.first_amount / r.unit_mult > 300 * t.med AND r.first_amount / r.unit_mult >= 10000000 AND r.amount_won IS NOT NULL""",
]


# 운영 g5 보정의 «단위 배수 되돌림»(문서 10건·4,191행)은 규칙이 아니라 사람이 고른 문서 목록이다 — 데이터에서 규칙을 역추론하지 못함(시험 §B). 목록 파일에 있는 doc_id 만 되돌린다.
UNIT_REVERT = set(l.strip() for l in open(os.path.join(HERE, 'b_unit_revert_docs.txt'), encoding='utf-8') if l.strip()) if os.path.exists(os.path.join(HERE, 'b_unit_revert_docs.txt')) else set()
B_REVERT = """UPDATE {S}.contract_rows SET first_amount = first_amount / unit_mult, final_amount = final_amount / unit_mult, amount_won = amount_won / unit_mult,
  est_price = est_price / unit_mult, unit_mult = 1, parse_flags = array_append(parse_flags,'unit_mult_reverted') WHERE doc_id=$1 AND unit_mult > 1"""


def b_row_stmts(doc_id, rows):
    """문서 행 적재 + 후처리(같은 트랜잭션)."""
    return ([(B_ROW_INS, [jd(c)]) for c in chunks(rows, 4000)] + ([(B_REVERT, [doc_id])] if doc_id in UNIT_REVERT else []) + [(q, [doc_id]) for q in B_POST])


def b_stem(name):
    return re.sub(r'[0-9]+|분기|Q|제?\s*년도?|\(.*?\)|[_\s\-\.]+|xlsx?$', '', name or '')


def b_parse(cp, d):
    """문서 1건 파싱 → (contract_docs 메타 dict, 적재용 행 list, 중복 판정 키 집합)."""
    sa = d['sa'] or (d['dd'][:4] + '-' + d['dd'][4:6] + '-' + d['dd'][6:8] if len(d['dd']) == 8 else '')
    dm = {d['rel_path']: {'doc_id': d['doc_id'], 'period_label': d['pl'], 'submitted_at': sa, 'dup_group': d['dg'], 'body_group': None, 'size_bucket': None}}
    rows, rec = cp.parse_file(cp.MD_ROOT + d['rel_path'], dm)
    if rec.get('error'): raise RuntimeError(rec['error'])
    yrs, keys, out = collections.Counter(), set(), []
    for j in rows:
        fl = set(j.get('parse_flags') or [])
        r = {k: j.get(k) for k in BCOLS}; r['doc_id'] = d['doc_id']
        r['is_summary'] = bool(fl & SUMMARY_FLAGS); r['parse_flags'] = list(j.get('parse_flags') or [])
        for c in BDATES:                                   # 달력에 없는 날짜(2023-09-31) → NULL
            if r.get(c) and not iso_ok(r[c]): r[c] = None   # 운영 적재와 같게 플래그 없이 NULL(safe_date 동작)
        for c in BINTS:                                    # bigint 초과 금액 → NULL + amount_overflow
            v = r.get(c)
            if isinstance(v, (int, float)) and abs(v) > 9e18: r[c] = None; r['parse_flags'].append('amount_overflow')
        if r.get('unit_mult') is None: r['unit_mult'] = 1
        out.append(r)
        if fl & SUMMARY_FLAGS or 'housing_lease_sheet' in fl: continue
        if j.get('first_date'): yrs[j['first_date'][:4]] += 1
        keys.add((j.get('contract_name') or '', j.get('first_date') or '', j.get('counterparty_norm') or ''))
    ty = int(yrs.most_common(1)[0][0]) if yrs else rec.get('file_year')
    meta = {'doc_id': d['doc_id'], 'inst_code': rec['inst_code'], 'source_md_path': d['rel_path'], 'source_file': rec.get('source_file'), 'round_label': rec.get('round_label'),
            'round_dir': rec.get('round_dir'), 'submitted_at': sa or None, 'target_year': ty, 'group_key': '%s|%s|%s' % (rec['inst_code'], ty, b_stem(rec.get('source_file'))),
            'parse_status': 'ok' if rows else 'no_table', 'n_rows': len(rows)}
    return meta, out, keys


def run_b(ctx):
    db, a, bud = ctx.db, ctx.a, ctx.bud
    cp = importlib.import_module('contract_parser')
    S = new_stats(); ctx.stats['B'] = S
    S['matview_refreshed'] = False
    docs = list_docs(db, r'/70301_.*\.md$', a.inst)
    docs = {i: d for i, d in docs.items() if not d['rel_path'].endswith('/content.md')}
    recs = {r['doc_id']: r for r in db.q("SELECT doc_id, coalesce(body_md5,'') md5, parser_ver ver, extract(epoch from parsed_at)::float8 ts, group_key, submitted_at::text sa, coalesce(round_dir,'') rd, parse_status ps, status, coalesce(superseded_by,'') sb, coverage_warn warn FROM {S}.contract_docs")}
    new, chg, adopt = classify(docs, recs, B_VER)
    orphans = [r['doc_id'] for r in db.q("SELECT c.doc_id FROM {S}.contract_docs c WHERE NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.doc_id=c.doc_id)")]
    S.update(target=len(docs), new=len(new), changed=len(chg), deleted=len(orphans), adopted=len(adopt))
    log('B 대상 %d · 신규 %d · 변경 %d · 삭제대상 %d · 해시채택 %d' % (len(docs), len(new), len(chg), len(orphans), len(adopt)))
    if a.dry: return
    for c in chunks(adopt, 500):
        db.tx([("UPDATE {S}.contract_docs r SET body_md5 = x.m FROM (SELECT * FROM jsonb_to_recordset($1::jsonb) AS y(i text, m text)) x WHERE r.doc_id = x.i", [jd([{'i': i, 'm': docs[i]['eff']} for i in c])])])
    targets, S['deferred'] = pick(new, chg, a.limit)
    removed = set(orphans) if (a.sweep and (len(orphans) <= max(50, 0.05 * len(recs)) or a.force_sweep)) else set()
    if a.sweep and orphans and not removed: S['sweep_blocked'] = True; S['error'] = 'sweep 차단: 삭제대상 %d' % len(orphans)
    # 1) 변경 문서 메타 파싱(행은 버린다 — 현행 문서만 2차에서 다시 파싱해 적재)
    newmeta, groups = {}, collections.defaultdict(set)
    for n, i in enumerate(targets):
        if bud.over(): S['deferred'] += len(targets) - n; log('B 시간 상한 — 나머지 이월'); break
        try:
            if ctx.inject == 'B:doc' and not newmeta and not S['failed']: raise RuntimeError('주입된 문서 실패(시험)')
            meta, _, _ = b_parse(cp, docs[i]); newmeta[i] = meta; groups[meta['group_key']].add(i)
        except Exception as e:
            S['failed'] += 1; S['failed_ids'].append(i); log('B 파싱 실패', i, str(e)[:200])
    for i in list(targets) + list(removed):          # 옛 그룹도 재계산(그룹이 바뀌었거나 문서가 사라진 경우)
        if i in recs and recs[i]['group_key']: groups.setdefault(recs[i]['group_key'], set())
    # 2) 영향 그룹별 재판정·교체
    for gk in sorted(groups):
        if bud.over(): S['deferred'] += 1; log('B 시간 상한 — 남은 그룹 이월'); break
        try:
            S['ok'] += len(groups[gk] & set(newmeta)); S['rows'] += b_group(ctx, cp, gk, docs, recs, newmeta, removed)
        except Exception as e:
            S['failed'] += 1; S['failed_ids'].append(gk); log('B 그룹 실패', gk, str(e)[:200])
    S['swept'] = len(removed)
    b_refresh_mv(ctx, S)
    # 삭제 문서 중 그룹 처리에 안 걸린 것(그룹 키가 비어 있는 옛 기록 등) 정리
    if removed:
        left = [i for i in removed if i in recs and recs[i]['group_key'] not in groups]
        for c in chunks(left, 200): db.tx([('DELETE FROM {S}.contract_rows WHERE doc_id = ANY($1)', [c]), ('DELETE FROM {S}.contract_docs WHERE doc_id = ANY($1)', [c])])


def b_refresh_mv(ctx, S):
    """계약 데이터가 바뀌었고 그룹이 오류 없이 끝났을 때만 contract_current_m 을 1회 갱신(없는 스키마면 건너뜀). 비치명. tx=False = 자동커밋(CONCURRENTLY 는 트랜잭션 밖)."""
    S['matview_refreshed'] = False
    if ctx.a.dry or S['failed'] or S['error'] or not (S['ok'] or S.get('swept')): return
    try:
        if not ctx.db.q("SELECT 1 FROM pg_matviews WHERE schemaname=$1 AND matviewname='contract_current_m'", ctx.db.S): return
        t = time.time(); ctx.db.tx([('REFRESH MATERIALIZED VIEW CONCURRENTLY {S}.contract_current_m', [])], tx=False)
        S['matview_refreshed'] = True; log('B contract_current_m 갱신 %.1fs' % (time.time() - t))
    except Exception as e:
        S['alerts_extra'] = ['B: contract_current_m 갱신 실패 — %s' % str(e)[:150]]; log('B MV 갱신 실패(비치명)', str(e)[:200])


def b_group(ctx, cp, gk, docs, recs, newmeta, removed):
    """한 그룹(기관|대상연도|파일 stem)의 현행/대체·coverage_warn 재판정 + 교체. 적재한 행 수 반환."""
    db = ctx.db
    mem = {}
    for r in db.q("SELECT doc_id, submitted_at::text sa, coalesce(round_dir,'') rd, parse_status ps, status, coalesce(superseded_by,'') sb, coverage_warn warn, n_rows FROM {S}.contract_docs WHERE group_key=$1", gk):
        if r['doc_id'] in removed or r['doc_id'] in newmeta or r['doc_id'] not in docs: continue      # 새 메타로 대체되거나 삭제될 문서는 기존 기록을 쓰지 않는다
        mem[r['doc_id']] = {'sa': r['sa'] or '', 'rd': r['rd'], 'ps': r['ps'], 'status': r['status'], 'sb': r['sb'], 'warn': r['warn'], 'n': r['n_rows']}
    mine = [i for i, m in newmeta.items() if m['group_key'] == gk]
    for i in mine:
        m = newmeta[i]; mem[i] = {'sa': m['submitted_at'] or '', 'rd': m['round_dir'] or '', 'ps': m['parse_status'], 'status': None, 'sb': '', 'warn': False, 'n': m['n_rows']}
    elig = sorted((i for i, m in mem.items() if m['ps'] in ('ok', 'partial')), key=lambda i: (mem[i]['sa'], mem[i]['rd'], mem[i]['n'], i))   # 제출일·회차가 같으면 행이 더 많은(완전한) 문서, 그다음 doc_id
    top = elig[-1] if elig else None
    cache = {}
    def parsed(i):
        if i not in cache: cache[i] = b_parse(cp, docs[i])
        return cache[i]
    warn = False
    if len(elig) > 1:
        ck = parsed(top)[2]
        for p in elig[:-1][-2:]:
            pk = parsed(p)[2]
            if pk and len(pk - ck) / len(pk) > 0.05: warn = True; break
    st = []
    gone = [i for i in removed if i in recs and recs[i]['group_key'] == gk]
    if gone: st += [('DELETE FROM {S}.contract_rows WHERE doc_id = ANY($1)', [gone]), ('DELETE FROM {S}.contract_docs WHERE doc_id = ANY($1)', [gone])]
    for i in mine:                                    # 변경·신규 문서: 행·문서 기록 교체(옛 기록이 다른 그룹이어도 doc_id 로 지운다)
        m = dict(newmeta[i]); is_top = i == top
        m['status'] = 'current' if is_top else 'superseded'; m['superseded_by'] = None if is_top or top is None else top; m['coverage_warn'] = bool(is_top and warn)
        st += [('DELETE FROM {S}.contract_rows WHERE doc_id=$1', [i]), ('DELETE FROM {S}.contract_docs WHERE doc_id=$1', [i]), (B_DOC_INS, [jd(m), docs[i]['eff'], B_VER])]
        if is_top:
            st += b_row_stmts(i, parsed(i)[1])
    for i, m in mem.items():                          # 기존 문서: 상태만 갱신, 새 현행이 되면 행 적재, 현행에서 밀리면 행 삭제
        if i in newmeta: continue
        is_top = i == top
        status = 'current' if is_top else 'superseded'; sb = '' if is_top or top is None else top; w = bool(is_top and warn)
        if status != m['status'] or sb != m['sb'] or w != m['warn']:
            st.append(("UPDATE {S}.contract_docs SET status=$2, superseded_by=NULLIF($3,''), coverage_warn=$4 WHERE doc_id=$1", [i, status, sb, w]))
        if not is_top and m['status'] == 'current':
            st.append(('DELETE FROM {S}.contract_rows WHERE doc_id=$1', [i]))
        if is_top and m['status'] != 'current':
            st += [('DELETE FROM {S}.contract_rows WHERE doc_id=$1', [i])] + b_row_stmts(i, parsed(i)[1])
    if st:
        db.tx(st)
    return sum(len(c) for c in [parsed(i)[1] for i in cache if i == top and (i in newmeta or mem[i]['status'] != 'current')])


# ------------------------------------------------------------------ RECR : recruit_post (트리 워커 → 전체 산출 후 DB 와 비교)
REC_COLS = ('sn', 'inst_code', 'title', 'start_date', 'end_date', 'hire_type', 'region', 'n_hire', 'ncs', 'edu', 'recruit_kind', 'source', 'always_open', 'rolling_title',
            'has_rag_doc', 'has_rag_content', 'rag_doc_ids', 'rel_path_dir', 'src_hash', 'extract_ver', 'updated_at')
REC_UP = ("INSERT INTO {S}.recruit_post SELECT x.* FROM jsonb_populate_recordset(NULL::{S}.recruit_post, (SELECT jsonb_agg(e || jsonb_build_object('extract_ver','%s','updated_at',now())) FROM jsonb_array_elements($1::jsonb) e)) x "
          "ON CONFLICT (post_key) DO UPDATE SET %s" % (REC_VER, ', '.join('%s=EXCLUDED.%s' % (c, c) for c in REC_COLS)))


def run_recr(ctx):
    db, a = ctx.db, ctx.a
    S = new_stats(); ctx.stats['RECR'] = S
    docs = list_docs(db, r'/B10[12]0', a.inst)
    for d in docs.values(): d['eff'] = ''
    have = {r['post_key']: r for r in db.q("SELECT post_key, src_hash, has_rag_doc, has_rag_content, rag_doc_ids ids, extract_ver ver FROM {S}.recruit_post")}
    with tempfile.TemporaryDirectory(prefix='refresh_RECR_') as td:
        tsv, out = os.path.join(td, 'docs.tsv'), os.path.join(td, 'rec.jsonl')
        open(tsv, 'w', encoding='utf-8').write(''.join('%s\t%s\n' % (i, d['rel_path']) for i, d in docs.items()))
        r = subprocess.run(['node', os.path.join(HERE, 'extract_recruit.js'), '--docs', tsv, '--out', out], cwd=HERE, capture_output=True, text=True, timeout=1800)
        if r.returncode != 0: raise RuntimeError('extract_recruit.js rc=%d %s' % (r.returncode, (r.stderr or r.stdout)[-300:]))
        rows = list(jl(out))
    seen = {r['post_key'] for r in rows}; todo = []
    for r in rows:
        h = have.get(r['post_key']); ids = set(r.get('rag_doc_ids') or [])
        if h is None: S['new'] += 1; todo.append(r)
        elif h['src_hash'] != r['src_hash'] or h['ver'] != REC_VER or h['has_rag_doc'] != r['has_rag_doc'] or h['has_rag_content'] != r['has_rag_content'] or set(h['ids'] or []) != ids: S['changed'] += 1; todo.append(r)
    gone = [k for k in have if k not in seen]
    S.update(target=len(rows), deleted=len(gone))
    log('RECR 산출 %d · 신규 %d · 변경 %d · 사라짐 %d' % (len(rows), S['new'], S['changed'], len(gone)))
    if a.dry: return
    todo, S['deferred'] = pick(todo, [], a.limit)
    for r in todo:
        for c in ('start_date', 'end_date'):
            if r.get(c) and not iso_ok(r[c]): r[c] = None
    for c in chunks(todo, 500):
        try:
            db.tx([(REC_UP, [jd(c)])]); S['ok'] += len(c)
        except Exception as e:                                   # 한 행 때문에 배치가 실패하면 행 단위로 격리
            for r in c:
                try: db.tx([(REC_UP, [jd([r])])]); S['ok'] += 1
                except Exception as e2: S['failed'] += 1; S['failed_ids'].append(r['post_key']); log('RECR 적재 실패', r['post_key'], str(e2)[:200])
    S['rows'] = S['ok']
    if a.sweep and gone and rows:
        if len(gone) > max(50, 0.05 * len(have)) and not a.force_sweep: S['sweep_blocked'] = True; S['error'] = 'sweep 차단: 사라진 공고 %d' % len(gone)
        else:
            for c in chunks(gone, 500): db.tx([('DELETE FROM {S}.recruit_post WHERE post_key = ANY($1)', [c])])
            S['swept'] = len(gone)


# ------------------------------------------------------------------ 알림 · 요약 · 메인
def alerts_for(ctx):
    out, a = [], ctx.a
    for g, S in ctx.stats.items():
        done = S['ok'] + S['failed']
        if S.get('error') and S['failed'] and not S['ok']: out.append('%s: 전량 실패(%s)' % (g, S['error']))
        elif done and S['failed'] >= FAIL_MIN and S['failed'] / done > FAIL_RATE: out.append('%s: 추출 실패율 %.1f%% (%d/%d)' % (g, 100.0 * S['failed'] / done, S['failed'], done))
        out += S.get('alerts_extra', [])
        if S.get('sweep_blocked'): out.append('%s: sweep 차단(%s)' % (g, S.get('error')))
        for k, (n, u) in S['metric'].items():
            lim = (UNMAPPED_MAX.get(k, UNMAPPED_DEFAULT) if g in ('A', 'D') else DISC_UNCLASS_MAX if g == 'DISC' else FIND_UNCLASS_MAX.get(k, 0.5))
            if n >= 50 and u / n > lim: out.append('%s/%s: 미분류율 %.1f%% > %.0f%% (n=%d)' % (g, k, 100.0 * u / n, 100 * lim, n))
        if ctx.streak.get(g, 0) >= ZERO_STREAK[g]: out.append('%s: 신규·변경 0건 %d일 연속(임계 %d)' % (g, ctx.streak[g], ZERO_STREAK[g]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--schema', default=os.environ.get('RAG_EXT_SCHEMA', 'rag_ext'))
    ap.add_argument('--only-code', default=''); ap.add_argument('--inst', default='')
    ap.add_argument('--limit', type=int, default=0); ap.add_argument('--max-sec', type=int, default=1800)
    ap.add_argument('--dry', action='store_true'); ap.add_argument('--sweep', action='store_true'); ap.add_argument('--force-sweep', action='store_true')
    ap.add_argument('--summary'); ap.add_argument('--state'); ap.add_argument('--lock')
    a = ap.parse_args()
    if not re.fullmatch(r'[a-z_][a-z0-9_]*', a.schema): print('bad schema'); return 2
    a.only_code = [c for c in a.only_code.split(',') if c]; a.inst = [c for c in a.inst.split(',') if c] or None
    if a.schema == 'rag_ext' and not a.dry and os.environ.get('RAG_EXT_PROD') != '1':
        print('운영 스키마 rag_ext 쓰기는 RAG_EXT_PROD=1 필요(시험은 --schema rag_ext_test)'); return 2
    run_groups = [g for g in ORDER if not a.only_code or set(a.only_code) & (set(GROUPS[g]) | {g})]
    for c in a.only_code:
        if c not in ORDER and not any(c in v for v in GROUPS.values()): print('알 수 없는 코드', c); return 2
    lockf = open(a.lock or '/tmp/rag_ext_refresh.%s.lock' % a.schema, 'w')
    try: fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError: log('다른 rag_ext_refresh 가동 중 — 종료(75)'); return 75
    class Ctx: pass
    ctx = Ctx(); ctx.a = a; ctx.stats = {}; ctx.bud = Budget(a.max_sec, a.limit); ctx.inject = os.environ.get('REFRESH_INJECT', '')
    t0 = time.time(); today = time.strftime('%F')
    state = {}
    if a.state and os.path.exists(a.state):
        try: state = json.load(open(a.state))
        except Exception: state = {}
    log('=== rag_ext_refresh 시작 schema=%s groups=%s%s%s ===' % (a.schema, ','.join(run_groups), ' DRY' if a.dry else '', ' sweep' if a.sweep else ''))
    try: ctx.db = DB(a.schema); ctx.db.q('select 1')
    except Exception as e: log('DB 접속 실패', e); return 1
    fn = {'A': lambda: run_fields(ctx, 'A'), 'D': lambda: run_fields(ctx, 'D'), 'B': lambda: run_b(ctx), 'DISC': lambda: run_disc(ctx), 'FIND': lambda: run_find(ctx), 'RECR': lambda: run_recr(ctx), 'B2': lambda: b2_refresh.run(ctx.db, ctx.a, ctx.bud, ctx.stats.setdefault('B2', new_stats()))}
    for g in run_groups:
        if ctx.bud.over(): log(g, '시간 상한 — 그룹 건너뜀'); ctx.stats[g] = new_stats(error='시간 상한 전 미실행'); continue
        tg = time.time()
        try:
            if ctx.inject == g: raise RuntimeError('주입된 그룹 실패(시험)')
            fn[g]()
        except Exception as e:
            log(g, '그룹 실패(비치명):', str(e)[:300]); S = ctx.stats.setdefault(g, new_stats()); S['error'] = str(e)[:300]; S['failed'] += 1 if not S['failed'] else 0
        ctx.stats[g]['sec'] = round(time.time() - tg, 1)
    ctx.db.close()
    ctx.streak = {}
    for g, S in ctx.stats.items():   # 0건 연속: 그룹이 끝까지 돌았고(이월·오류 없음) 하루 한 번만 센다
        st = state.setdefault(g, {'zero_streak': 0, 'date': ''})
        if not a.dry and not S['deferred'] and not S['error'] and st['date'] != today:
            st['zero_streak'] = st['zero_streak'] + 1 if (S['new'] + S['changed'] == 0) else 0; st['date'] = today
        ctx.streak[g] = st['zero_streak']
    al = alerts_for(ctx)
    tot = {k: sum(S[k] for S in ctx.stats.values()) for k in ('new', 'changed', 'failed', 'deferred')}
    res = {'ran_at': time.strftime('%FT%T%z'), 'schema': a.schema, 'dry': a.dry, 'sweep': a.sweep, 'elapsed_s': round(time.time() - t0, 1),
           'status': 'warn' if (al or tot['failed']) else 'ok', 'totals': tot, 'alerts': al, 'groups': {g: {k: v for k, v in S.items() if k != 'metric'} | {'metric': {m: {'n': x[0], 'unmapped_or_unclassified': x[1]} for m, x in S['metric'].items()}} for g, S in ctx.stats.items()}}
    for g in res['groups'].values(): g['failed_ids'] = g['failed_ids'][:10]
    log('=== 종료 %s 신규 %d · 변경 %d · 실패 %d · 이월 %d · %.0fs%s ===' % (res['status'], tot['new'], tot['changed'], tot['failed'], tot['deferred'], res['elapsed_s'], (' · 경보: ' + ' | '.join(al)) if al else ''))
    if a.summary: json.dump(res, open(a.summary, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    if a.state and not a.dry: json.dump(state, open(a.state, 'w', encoding='utf-8'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
