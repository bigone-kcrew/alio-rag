#!/usr/bin/env python3
"""B2(업무추진비·소송·이사회·기부·출연) 증분 갱신 — rag_ext_refresh.py 의 «B 그룹(계약)» 과 같은 모양의 독립 모듈.
  python3 b2_refresh.py [--dry] [--only-code 20701,43009] [--inst C0035,C0064] [--limit N] [--max-sec 600] [--schema rag_ext]
판정: public.documents(corpus='disclosure', rel_path 가 5개 코드) ↔ {S}.b2_docs 의 (body_md5, parser_ver). body_md5 가 NULL 이면 파일 md5('f:…').
쓰기: 문서 단위 트랜잭션(DELETE 부모(행 CASCADE) → INSERT 문서·행) → 영향받은 (코드, 기관)만 SELECT rag_ext.b2_recompute(코드, 기관[]) → 현행·status·coverage_warn 갱신.
      documents 에서 사라진 문서는 --sweep 일 때만 삭제(삭제 5%·50건 초과 시 차단, 기존 러너와 같은 규칙).
통합(훅 수정 없음): rag_ext_refresh.py 의 GROUPS['B2']=b2_refresh.CODES, ORDER 끝에 'B2', 디스패치에 `elif g == 'B2': b2_refresh.run(ctx.db, ctx.a, ctx.bud, S)` 한 줄.
  일일 델타 훅은 이미 rag_ext_refresh.py 를 호출하므로 훅 파일 변경이 필요 없다.
운영 쓰기 가드: RAG_EXT_PROD=1 (기존 러너와 동일).
"""
import argparse, collections, hashlib, json, os, sys, time, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import b2_extract as X

CODES = X.CODES
TBL = {'20701': ('b2_bizcost_rows', 'table_idx,table_row,inst_code,yr,month,spent_date,category,n_cases,amount_won,spender,place,target,pay_method,headcount,remark,unit_name,unit_mult,is_summary,is_current,parse_flags'),
       '21301': ('b2_lawsuit_rows', 'table_idx,table_row,inst_code,yr,case_no_raw,n_cases,side,side_raw,delegation,delegation_raw,case_type,remark,is_summary,is_current,parse_flags'),
       '43009': ('b2_board_rows', 'table_idx,table_row,inst_code,yr,meeting_no,meeting_date,agenda_type,agenda_text,result,n_vote_cols,n_for,n_against,n_absent,n_abstain,n_not_eligible,is_summary,is_current,parse_flags'),
       '21502': ('b2_donation_rows', 'table_idx,table_row,inst_code,row_no,event_date,yr,recipient,relation,amount_won,object,reason,unit_name,unit_mult,is_summary,is_current,parse_flags'),
       '32001': ('b2_contrib_rows', 'table_idx,table_row,inst_code,row_no,event_date,yr,recipient,relation,amount_won,object,reason,unit_name,unit_mult,is_summary,is_current,parse_flags')}
DOC_COLS = 'doc_id,code,inst_code,source_md_path,source_file,round_label,round_dir,submitted_at,target_year,group_key,body_md5,parser_ver,parse_status,n_rows,n_rows_core,unit_fix,status,superseded_by,coverage_warn,order_key,rows_sig,sum_mismatch,sum_check,total_decl,detail_sum'
DOC_INS = ("INSERT INTO {S}.b2_docs (%s) SELECT %s FROM jsonb_populate_record(NULL::{S}.b2_docs, $1::jsonb) x" % (DOC_COLS, ','.join('x.' + c for c in DOC_COLS.split(','))))
ZERO_STREAK = {'20701': 45, '21301': 45, '43009': 45, '21502': 90, '32001': 90}   # 신규·변경 0건이 이만큼 연속이면 경보(추정치)


def jd(o): return json.dumps(o, ensure_ascii=False).replace('\\u0000', '')


def vdate(x):
    try: return datetime.date.fromisoformat((x or '')[:10]).isoformat()
    except ValueError: return None


def okey(d):
    dn = d.get('disclosure_no') or ''
    sa = d.get('submitted_at') or (('%s-%s-%s' % (dn[:4], dn[4:6], dn[6:8])) if len(dn) >= 8 else '')
    return '%s|%s' % (sa, d.get('round_dir') or '')


def row_stmt(code):
    t, cols = TBL[code]
    return ("INSERT INTO {S}.%s (doc_id,%s) SELECT x.doc_id,%s FROM jsonb_array_elements($1::jsonb) s(j), LATERAL jsonb_populate_record(NULL::{S}.%s, s.j) x" %
            (t, cols, ','.join('x.' + c for c in cols.split(',')), t))


def parse_doc(code, d):
    """documents 한 행 d → (문서 JSON, 행 JSON 목록). 로더(b2_load.py)와 같은 모양."""
    rows, doc = X.parse_file(code, X.MD_ROOT + d['rel_path'], {d['rel_path']: {'doc_id': d['doc_id'], 'period_label': d['pl'], 'submitted_at': vdate(d['sa'])}})
    doc['doc_id'] = d['doc_id']; doc['submitted_at'] = vdate(d['sa']); doc['body_md5'] = d['eff']
    o = {k: doc.get(k) for k in ('doc_id', 'code', 'inst_code', 'source_md_path', 'source_file', 'round_label', 'round_dir', 'submitted_at', 'target_year', 'group_key',
                                  'body_md5', 'parser_ver', 'parse_status', 'n_rows', 'n_rows_core', 'unit_fix', 'rows_sig', 'sum_mismatch', 'sum_check', 'total_decl', 'detail_sum')}
    o['order_key'] = okey(doc); o['status'] = 'current'; o['coverage_warn'] = False; o['sum_mismatch'] = bool(o.get('sum_mismatch')); o['total_decl'] = doc.get('tot_decl'); o['detail_sum'] = doc.get('tot_sum')
    out = []
    for r in rows:
        r['doc_id'] = d['doc_id']; r['inst_code'] = doc['inst_code']; r['is_current'] = False
        if not r.get('yr') and doc.get('target_year'): r['yr'] = doc['target_year']; r['parse_flags'].append('yr_from_doc')
        r.pop('source_md_path', None); r.pop('code', None)
        out.append(r)
    return o, out


def list_docs(db, codes, inst, md_root=X.MD_ROOT):
    sql = ("SELECT doc_id, rel_path, inst_code, coalesce(body_md5,'') md5, coalesce(meta->>'period_label','') pl, coalesce(meta->>'submitted_at','') sa FROM public.documents "
           "WHERE corpus='disclosure' AND rel_path ~ $1 AND rel_path !~ '/content[.]md$'")
    P = ['/(%s)_' % '|'.join(codes)]
    if inst: sql += ' AND inst_code = ANY($2)'; P.append(inst)
    docs = {}
    for r in db.q(sql + ' ORDER BY doc_id', *P):
        r['code'] = r['rel_path'].split('/')[1].split('_')[0]
        if r['md5']: r['eff'] = r['md5']
        else:
            try: r['eff'] = 'f:' + hashlib.md5(open(md_root + r['rel_path'], 'rb').read()).hexdigest()
            except OSError: r['eff'] = 'f:nofile'
        docs[r['doc_id']] = r
    return docs


def run(db, a, bud, S, log=print):
    """S: 통계 dict(기존 러너의 new_stats 와 같은 키). bud: 시간 예산(over()). a: argparse 결과(only_code·inst·limit·dry·sweep)."""
    codes = [c for c in CODES if not getattr(a, 'only_code', None) or c in a.only_code] or CODES
    docs = list_docs(db, codes, getattr(a, 'inst', None))
    recs = {r['doc_id']: r for r in db.q("SELECT doc_id, coalesce(body_md5,'') md5, parser_ver ver, inst_code, code, extract(epoch from parsed_at)::float8 ts FROM {S}.b2_docs WHERE code = ANY($1)", codes)}
    new = [i for i in docs if i not in recs]
    chg, adopt = [], []
    for i, d in docs.items():
        r = recs.get(i)
        if r is None: continue
        if r['ver'] != X.B2_VER[d['code']]: chg.append(i)
        elif r['md5'] == '' and d['eff'].startswith('f:'):        # body_md5 가 NULL 인 문서: 파일이 적재 뒤에 바뀌었을 때만 «변경», 아니면 해시만 채택(기존 러너와 같은 규칙)
            try: newer = os.stat(X.MD_ROOT + d['rel_path']).st_mtime > r['ts']
            except OSError: newer = False
            (chg if newer else adopt).append(i)
        elif r['md5'] != d['eff']: chg.append(i)
    orphans = [i for i in recs if i not in docs and not getattr(a, 'inst', None)]
    S.update(target=len(docs), new=len(new), changed=len(chg), deleted=len(orphans), adopted=len(adopt))
    log('B2 대상 %d · 신규 %d · 변경 %d · 삭제대상 %d · 해시채택 %d' % (len(docs), len(new), len(chg), len(orphans), len(adopt)))
    if getattr(a, 'dry', False): return
    for k in range(0, len(adopt), 500):
        db.tx([("UPDATE {S}.b2_docs r SET body_md5 = x.m FROM (SELECT * FROM jsonb_to_recordset($1::jsonb) AS y(i text, m text)) x WHERE r.doc_id = x.i",
                [jd([{'i': i, 'm': docs[i]['eff']} for i in adopt[k:k + 500]])])])
    removed = set()
    if getattr(a, 'sweep', False) and orphans:
        if len(orphans) <= max(50, 0.05 * len(recs)) or getattr(a, 'force_sweep', False): removed = set(orphans)
        else: S['error'] = 'sweep 차단: 삭제대상 %d' % len(orphans); log(S['error'])
    todo = (new + chg)[:getattr(a, 'limit', None) or None]
    S['deferred'] = len(new) + len(chg) - len(todo)
    affected = collections.defaultdict(set)
    for n, i in enumerate(todo):
        if bud.over(): S['deferred'] += len(todo) - n; log('B2 시간 상한 — 나머지 이월'); break
        d = docs[i]
        try:
            doc, rows = parse_doc(d['code'], d)
            st = [('DELETE FROM {S}.b2_docs WHERE doc_id=$1', [i]), (DOC_INS, [jd(doc)])]
            for k in range(0, len(rows), 2000): st.append((row_stmt(d['code']), [jd(rows[k:k + 2000])]))
            db.tx(st); S['ok'] += 1; S['rows'] += len(rows)
            affected[d['code']].add(d['inst_code'])
            if i in recs: affected[recs[i]['code']].add(recs[i]['inst_code'])
        except Exception as e:
            S['failed'] += 1; S['failed_ids'].append(i); log('B2 문서 실패', i, str(e)[:200])
    for i in removed:
        db.tx([('DELETE FROM {S}.b2_docs WHERE doc_id=$1', [i])]); affected[recs[i]['code']].add(recs[i]['inst_code'])
    for code, insts in affected.items():
        db.tx([('SELECT rag_ext.b2_recompute($1, $2)', [code, sorted(insts)])])
    S['swept'] = len(removed)


if __name__ == '__main__':   # 독립 실행(시험용): 기존 러너의 DB 어댑터를 재사용
    import rag_ext_refresh as R
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry', action='store_true'); ap.add_argument('--only-code', default=''); ap.add_argument('--inst', default='')
    ap.add_argument('--limit', type=int, default=0); ap.add_argument('--max-sec', type=int, default=600); ap.add_argument('--schema', default='rag_ext')
    ap.add_argument('--sweep', action='store_true'); ap.add_argument('--force-sweep', action='store_true')
    a = ap.parse_args(); a.only_code = [c for c in a.only_code.split(',') if c]; a.inst = [c for c in a.inst.split(',') if c] or None
    if not a.dry and a.schema == 'rag_ext' and os.environ.get('RAG_EXT_PROD') != '1': sys.exit('운영 스키마 쓰기는 RAG_EXT_PROD=1 필요')
    db = R.DB(a.schema); S = R.new_stats(); bud = R.Budget(a.max_sec, a.limit)
    try: run(db, a, bud, S, R.log)
    finally: db.close()
    print(json.dumps(S, ensure_ascii=False))
