# -*- coding: utf-8 -*-
"""시범 A: 공시 페이지(content.md) -> 필드 JSONL. 읽기 전용(운영 DB·파일 쓰기 없음).

실행(파이프라인 컨테이너):
  python3 -I field_extractor.py --docmap docmap.tsv --codes 20201,20601 --out fields.jsonl --docs docs.jsonl [--inst C0451] [--limit N]
레코드 = 값 1칸(표 셀) 또는 서술 1건. 실패는 버리지 않고 parse_flags 에 남긴다.
"""
import os, sys, re, json, argparse, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mdparse import *
from keydict import make_key
import xcodes   # 20261124 DextA: A·D 표 코드 확대(코드별 규칙) — CODES 밖 코드는 영향 없음

import os
ROOT = os.environ.get('MD_ROOT', './data/md/기관별공시')
VERSION = 'pilotA-0.1'
QUARTERLY_ITEMS = {'20201', '20401'}   # 분기 보고 항목: 본문 «(YYYY년 N/4분기)» 가 보고기간(날짜 폴더 문서 포함)
KV_FIRST = {'직위', '직책', '임기', '기준일', '성명', '성별', '주요경력', '선임절차', '선임절차규정', '당연직여부',
            '출생연도', '전공', '최종학위', '출신고교', '사유발생일', '기관명'}
KV_LABEL = {'직위', '성명', '직책', '성별', '임기', '(시작일)', '(종료일)', '재직기간', '주요경력', '선임절차', '선임절차규정',
            '당연직여부', '출생연도', '전공', '최종학위', '출신고교', '사유발생일'}
BOILER = ('공통공개기준',)
TOP_RESET = re.compile(r'^(임직원 ?총계|상임임원 ?정원|비정규직|소속외|자회사|연수직|여성현원)')


def body_files(subdir):
    """-> [(round_dir, filename)]. content.md 우선, 없으면 웹 기록 md(첫 줄 '# ![ALIO') 전부. (Goldkv recover584)"""
    out = []
    for rnd in sorted(os.listdir(subdir)):
        d = os.path.join(subdir, rnd)
        if not os.path.isdir(d):
            continue
        if os.path.isfile(os.path.join(d, 'content.md')):
            out.append((rnd, 'content.md')); continue
        for f in sorted(os.listdir(d)):
            if f.endswith('.md'):
                try:
                    if open(os.path.join(d, f), encoding='utf-8').read(40).startswith('# ![ALIO'):
                        out.append((rnd, f))
                except OSError:
                    pass
    return out


def strip_bullet(s):
    return re.sub(r'^[\-◈□ㅇ▷※\*\s]+', '', s or '').strip()


def pick_unit(unit_s, label):
    """'천원, 명, 월, %' 같은 다중 단위에서 행 라벨로 하나 고른다 -> (unit, flags)"""
    if not unit_s:
        m = re.search(r'\(([%명개월년원천원]{1,4})\)\s*$', label or '')
        return (m.group(1), ['unit_from_label']) if m else (None, ['unit_unknown'])
    us = [u.strip() for u in re.split(r'[,，]', unit_s) if u.strip()]
    if len(us) == 1:
        return us[0], []
    L = label or ''
    # 20261126 UnitFix: 비율 행은 표 단위 목록에 '%' 가 없어도 '%' (예: «(단위: 천원, 명, 월)» 표의 «평균임금 비율(남성)» 이 '임금' 에 걸려 천원이 되던 오류)
    if re.search(r'비율|률|%|비중', L):
        return '%', ([] if '%' in us else ['unit_pct_implied'])
    for key, pat in (('월', r'근속|개월'), ('명', r'종업원|인원|명|정원|현원|인력'),
                     ('천원', r'급|수당|보수|상여|임금|연봉|초임|복리|기타|합계|성과')):
        if key in us and re.search(pat, L):
            return key, []
    if us[:2] == ['명', '%']:
        return '명', ['unit_default_first']
    return None, ['unit_ambiguous']


def n_period_cells(h):
    return [i for i, c in enumerate(h) if col_key(c)[1] in ('ytdq', 'year')]


def date_iso(v):
    m = RE_DATE.search(v or '')
    return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}' if m else None


def extract_doc(path_txt, meta):
    """-> (fields[], docrec). meta: 공통 컬럼 dict"""
    items = parse_md(path_txt)
    tbs = tables(items)
    F, flags = [], set()
    d = dict(meta)
    d.update({'n_tables': len(tbs), 'report_period': None, 'report_period_src': None, 'base_date': None, 'submit_date': None,
              'is_correction': False, 'orig_submit_date': None})
    ctx = {'section': None, 'title': None, 'unit': None, 'note': None, 'unit_last': None}
    # 문서 머리의 (YYYY년 N/4분기)
    for t in tbs[:6]:
        for c in (t['header'] or []) + [x for _, r, _, _ in t['rows'] for x in r]:
            m = RE_Q.search(c or '')
            if m and re.match(r'^\(?\s*\d{4}', c):
                d['report_period'], d['report_period_src'] = f'{m.group(1)}Q{m.group(2)}', 'body_title'
                break
        if d['report_period']:
            break
    # 문서 전체의 pre(서술) 줄에서 절 제목 추적을 위해 표별 pre 사용
    prev_wide_path = None
    ent = 0  # 카드형(kv) 블록 순번: 임원 1명=표 1개 -> 같은 field_key 반복 행을 구분 (Goldkv)
    for ti, t in enumerate(tbs):
        h, rows = t['header'], t['rows']
        for tx in t['pre']:
            if re.match(r'^\d+(-\d+)?\.\s', tx):
                ctx['section'] = tx[:60]
        if h is None:  # 머리 없는 행 덩어리
            if rows:
                flags.add('headless_rows')
                for ri, (ln, r, rn, ind) in enumerate(rows):
                    F.append(rec(d, ti, ri, ln, 'headless', None, ' / '.join(x for x in r if x), ' | '.join(x for x in r if x), ctx, ['headless_rows']))
            continue
        hs = [c for c in h if c]
        if not hs and not rows:
            continue  # 빈 표
        first = h[0] if h else ''
        # --- 메타/제외
        if first == '기준일' and len(h) >= 4:
            d['base_date'], d['submit_date'] = date_iso(h[1]), date_iso(h[3]); continue
        if first == '기관 공시 담당자' or (first == '구분' and len(h) > 1 and h[1] == '담당자명'):
            continue  # 담당자 개인정보 — 추출 제외
        if first in BOILER:
            continue
        if re.match(r'^\d+\.\s*수정대상 공시서류의 최초제출', first):
            d['is_correction'] = True
            d['orig_submit_date'] = date_iso(' '.join(h[1:]) + ' ' + ' '.join(x for _, r, _, _ in rows for x in r))
            continue
        if re.match(r'^\d+\.\s*수정사항', first):
            d['is_correction'] = True; continue
        if first.replace(' ', '') == '항목' and ''.join(h[1:3]).replace(' ', '') == '수정전수정후':
            d['is_correction'] = True
            for ri, (ln, r, rn, ind) in enumerate(rows):
                F.append(rec(d, ti, ri, ln, 'correction', None, r[0] if r else '', ' | '.join(r[1:]), ctx, ['correction_note'],
                             extra={'col_label': ' | '.join(h[1:])}))
            continue
        if first.startswith('기관 세부 작성기준'):
            txt = ' '.join(x for _, r, _, _ in rows for x in r if x)
            if txt:
                F.append(rec(d, ti, 0, rows[0][0] if rows else t['start'], 'note', None, '기관 세부 작성기준', txt, ctx, []))
            continue
        # --- 제목/단위 표(데이터 없음)
        if not rows:
            u = next((find_unit(c) for c in h if find_unit(c)), None)
            if u:
                ctx['unit'] = u
            txt = [c for c in h if c and not find_unit(c)]
            if txt and len(h) <= 3 and not n_period_cells(h):
                t0 = strip_bullet(txt[0])
                if re.match(r'^해당\s*사항\s*없음', t0):
                    F.append(rec(d, ti, 0, t['start'], 'text', None, ctx['title'] or '', t0, ctx, ['group_na']))
                    continue
                if len(t0) <= 30 and not re.match(r'^[ㅇ\*※\-]', txt[0]) and t0 != d['inst_name']:
                    ctx['title'] = t0
                elif len(h) == 1 and not u:
                    F.append(rec(d, ti, 0, t['start'], 'text', None, t0[:60], h[0], ctx, ['note_text']))
            continue
        pc = n_period_cells(h)
        # --- 와이드(연도/분기 열)
        if pc and pc[0] >= 1:
            lc = pc[0]
            hdr_unit = next((find_unit(c) for c in h if find_unit(c)), None) or ctx['unit']
            carried = False
            if not hdr_unit and ctx.get('unit_last'):
                hdr_unit, carried = ctx['unit_last'], True
            elif hdr_unit:
                ctx['unit_last'] = hdr_unit
            nv = len(h) - lc
            cols = [col_key(c) for c in h[lc:]]
            prev_path, root = [], None
            for ri, (ln, r, rn, ind) in enumerate(rows):
                fl = []
                if len(r) >= nv + 1 or (len(r) == nv):
                    vals = r[-nv:]
                    own = [x for x in r[:len(r) - nv] if x]
                    if len(r) == nv:
                        own, fl = [], ['no_label_cell']
                else:
                    own = [x for x in r if x]
                    F.append(rec(d, ti, ri, ln, 'note', None, ' / '.join(own[:1]), ' | '.join(own[1:]) or ' | '.join(own), ctx,
                                 ['note_row'], extra={'row_labels': own}))
                    continue
                if own:
                    child = False
                    if prev_path and len(own) < len(prev_path) and not TOP_RESET.match(own[0]):
                        path = prev_path[:len(prev_path) - len(own)] + own
                        fl.append('path_inferred')
                    elif root and len(own) == 1 and (own[0].startswith('(') or ind >= 2) and own[0] != root:
                        path, child = [root, own[0]], True
                        fl.append('path_inferred')
                    else:
                        path = own
                        if len(own) == 1:
                            root = own[0]
                    if not child:
                        prev_path = path
                        if len(own) > 1:
                            root = None
                else:
                    path = prev_path
                label = ' / '.join(path)
                if any(re.fullmatch(r'-|\d[\d,\.]*', x) for x in own):
                    fl.append('label_has_values')
                unit, uf = pick_unit(hdr_unit, label)
                if carried and unit:
                    uf = uf + ['unit_carried']
                for j, v in enumerate(vals):
                    k, kind, y, basis, q = cols[j]
                    num, nf = parse_num(v)
                    vs, us = std_value(num, unit)
                    if num is None:
                        us = None
                    ex = {'col_label': h[lc + j], 'col_key': k, 'col_kind': kind, 'col_year': y, 'col_basis': basis, 'col_quarter': q,
                          'col_idx': j, 'is_last_col': j == nv - 1, 'path': path, 'row_labels': own, 'unit': unit if num is not None else None, 'unit_std': us,
                          'value_num': num, 'value_std': vs}
                    F.append(rec(d, ti, ri, ln, 'cell', None, label, v, ctx, fl + (uf if num is not None else []) + nf, extra=ex, cell=j))
            ctx['title'] = ctx['unit'] = None
            continue
        # --- 카드형(kv)
        even = len(h) % 2 == 0
        if first == '직위' and len(h) > 1 and h[1].startswith('변경'):
            kvlike = False
        else:
            kvlike = first in KV_FIRST
        if kvlike and not pc:
            ent += 1
            for ri, (ln, r, rn, ind) in enumerate([(t['start'], h, h, 0)] + rows):
                for pi, (lab, val, f2) in enumerate(kv_pairs(r)):
                    F.append(rec(d, ti, ri, ln, 'kv', None, lab, val, ctx, f2, extra={'value_date': date_iso(val) if date_iso(val) and len(val) < 20 else None, 'entity_idx': ent}, cell=pi))
            continue
        # --- 단일 머리 셀: "- 기관설립일", "◈ 주요 기능 및 역할", "상임감사"
        if len([c for c in h if c]) == 1:
            lab = strip_bullet(h[0])
            body = '\n'.join('\n'.join(x for x in rn if x) if len(rn) <= 2 else ' | '.join(x for x in rn if x) for _, r, rn, _ in rows if any(r))
            F.append(rec(d, ti, 0, rows[0][0], 'text', None, lab, body.strip(), ctx, [], extra={'value_date': date_iso(body) if len(body) < 24 else None}))
            continue
        # --- 직급별 인원수(2단 머리: 직급 구분 | 정원 | 현원[계·남성·여성])
        if h[0].replace(' ', '') == '직급구분' and rows and rows[0][1] and rows[0][1][0].replace(' ', '') == '현원계':
            sub = [('quota', '정원'), ('actual_total', '현원 계'), ('actual_male', '현원 남성'), ('actual_female', '현원 여성')]
            for ri, (ln, r, rn, ind) in enumerate(rows[1:], 1):
                if len(r) == 5:
                    for j, (kk, cl) in enumerate(sub, 1):
                        num, nf = parse_num(r[j])
                        F.append(rec(d, ti, ri, ln, 'list', f"{d['item_code']}:grade.{kk}", r[0], r[j], ctx, nf + ['two_level_header'] + (['unit_default_myeong'] if num is not None and not ctx['unit'] else []),
                                     extra={'col_label': cl, 'value_num': num, 'row_labels': [r[0]], 'unit': (ctx['unit'] or '명') if num is not None else None,
                                            'unit_std': '명' if num is not None else None, 'value_std': num}, cell=j))   # 20261126 UnitFix: 자기 표 단위(ctx['unit']) 사용(종전 unit_last=직전 와이드 표 «명, %» 이월)
                else:
                    F.append(rec(d, ti, ri, ln, 'list', None, r[0] if r else '', ' | '.join(r[1:]), ctx, ['list_len_mismatch'], extra={'col_label': ' | '.join(h)}))
            continue
        # --- 목록형(list): 머리 = 열 이름
        for ri, (ln, r, rn, ind) in enumerate(rows):
            if len(r) == len(h):
                for j in range(1, len(h)):
                    if not h[j]:
                        continue
                    num, nf = parse_num(r[j])
                    rk = col_key(r[0])[0]
                    F.append(rec(d, ti, ri, ln, 'list', None, r[0], r[j], ctx, nf, extra={'col_label': h[j], 'value_num': num, 'row_key': rk,
                                 'row_labels': [r[0]], 'unit': find_unit(h[j]) or ctx['unit']}, cell=j))
            else:
                F.append(rec(d, ti, ri, ln, 'list', None, ' / '.join(x for x in r[:1]), ' | '.join(r[1:]), ctx, ['list_len_mismatch'],
                             extra={'col_label': ' | '.join(h)}))
    if d['item_code'] in xcodes.CODES:   # 20261124 DextA
        F = xcodes.apply(d, tbs, items, F)
        if tbs and not any(r['kind'] in ('cell', 'list') for r in F):
            flags.add('no_values')
    d['n_fields'] = len(F)
    if not tbs:
        flags.add('no_tables')
    elif not F:
        flags.add('no_fields')
    d['doc_flags'] = sorted(flags)
    return F, d


def kv_pairs(cells):
    """카드형 한 행 -> [(label,value,flags)] ; 임기 행처럼 홀수 칸도 라벨 사전으로 분해"""
    out, cur = [], None
    cs = [c for c in cells]
    if len(cs) % 2 == 0 and not any(c in KV_LABEL and i % 2 == 1 for i, c in enumerate(cs)):
        for i in range(0, len(cs), 2):
            if cs[i] or cs[i + 1]:
                out.append((cs[i], cs[i + 1], [] if cs[i] else ['kv_no_label']))
        return out
    lab, vals = None, []
    prefix = None
    for c in cs:
        if c in KV_LABEL:
            if lab is not None:
                out.append((lab, ' '.join(vals).strip(), []))
            if c.startswith('(') and prefix:
                lab = f'{prefix}/{c.strip("()")}'
            else:
                lab, prefix = c, c
            vals = []
        else:
            vals.append(c)
    if lab is not None:
        out.append((lab, ' '.join(vals).strip(), []))
    elif any(cs):
        out.append((cs[0], ' | '.join(cs[1:]), ['kv_irregular']))
    return out


def rec(d, ti, ri, ln, kind, key, label, value_raw, ctx, flags, extra=None, cell=None):
    flags = list(flags)
    if kind in ('cell', 'kv', 'text', 'list') and key is None:
        if kind == 'cell':
            toks = (extra or {}).get('path') or [label]
        elif kind == 'list':
            toks = [label, (extra or {}).get('col_label') or '']
        else:
            toks = [label]
        key, kf = make_key(d['item_code'], ctx['title'] if kind == 'cell' else None, toks)
        if key is None and kind == 'list' and (extra or {}).get('col_label'):
            # 행 라벨이 가변(직위·직급·연도 외)이면 열 이름만으로 키: code:row.<열>
            k2, _ = make_key(d['item_code'], None, [extra['col_label']])
            if k2:
                key, kf = k2.replace(d['item_code'] + ':', d['item_code'] + ':row.', 1), ['key_by_col']
        flags += kf
    r = {'inst_code': d['inst_code'], 'inst_name': d['inst_name'], 'item_code': d['item_code'], 'doc_id': d['doc_id'],
         'rel_path': d['rel_path'], 'kind': kind, 'table_idx': ti, 'row_idx': ri, 'section': ctx['section'], 'table_title': ctx['title'],
         'field_label': label, 'field_key': key, 'value_raw': value_raw, 'source_ref': f'L{ln}:t{ti}:r{ri}' + (f':c{cell}' if cell is not None else ''),
         'parse_flags': flags}
    if extra:
        r.update(extra)
    return r


def load_docmap(p):
    m = {}
    for ln in open(p, encoding='utf-8'):
        a = ln.rstrip('\n').split('\t')
        if len(a) < 10:
            continue
        m[a[1]] = {'doc_id': a[0], 'db_category': a[3], 'doc_date': a[4], 'period_quarter': a[5], 'period_label': a[6],
                   'submitted_at': a[7], 'disclosure_no': a[8]}
    return m


def adj_period_label(pl, sa):
    """search.js adjPeriodLabel 과 동일: YYYYQ4 가 같은 해 1~3월 제출이면 전년 4분기"""
    m = re.match(r'^(\d{4})Q4$', pl or '')
    s = re.match(r'^(\d{4})-(\d{2})-', sa or '')
    return f'{int(m.group(1)) - 1}Q4' if m and s and s.group(1) == m.group(1) and int(s.group(2)) <= 3 else pl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--docmap', required=True); ap.add_argument('--codes', required=True)
    ap.add_argument('--out', required=True); ap.add_argument('--docs', required=True)
    ap.add_argument('--inst', default=None); ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--root', default=ROOT)
    ap.add_argument('--only-ids', default=None, help='증분: 이 파일(줄마다 doc_id)에 있는 문서만 추출 (rag_ext_refresh.py 용)')
    a = ap.parse_args()
    dm = load_docmap(a.docmap)
    only = set(l.strip() for l in open(a.only_ids, encoding='utf-8')) if a.only_ids else None
    codes = a.codes.split(',')
    fo, do = open(a.out, 'w', encoding='utf-8'), open(a.docs, 'w', encoding='utf-8')
    n = 0
    for inst in sorted(os.listdir(a.root)):
        if a.inst and a.inst not in inst:
            continue
        m = re.match(r'^\[(.*)\](.*)_(C\d+)$', inst)
        iname, icode = (m.group(2), m.group(3)) if m else (inst, None)
        ip = os.path.join(a.root, inst)
        if not os.path.isdir(ip):
            continue
        for sub in sorted(os.listdir(ip)):
            code = sub.split('_')[0]
            if code not in codes:
                continue
            for rnd, bname in body_files(os.path.join(ip, sub)):
                f = os.path.join(ip, sub, rnd, bname)
                if not os.path.isfile(f):
                    continue
                rel = f'{inst}/{sub}/{rnd}/{bname}'
                db = dm.get(rel, {})
                if only is not None and db.get('doc_id') not in only:
                    continue
                meta = {'inst_code': icode, 'inst_name': iname, 'item_code': code, 'rel_path': rel, 'round_dir': rnd,
                        'doc_id': db.get('doc_id'), 'period_label': db.get('period_label'), 'submitted_at': db.get('submitted_at'),
                        'period_label_adj': adj_period_label(db.get('period_label'), db.get('submitted_at')),
                        'disclosure_no': db.get('disclosure_no'), 'in_db': bool(db), 'extractor': VERSION}
                try:
                    F, d = extract_doc(open(f, encoding='utf-8').read(), meta)
                except Exception as e:  # 실패는 문서 단위로 기록
                    F, d = [], dict(meta, error=repr(e)[:200], doc_flags=['exception'], n_fields=0)
                if not d.get('report_period') and d.get('period_label_adj'):
                    d['report_period'], d['report_period_src'] = d['period_label_adj'], 'db_period_label_adj'
                pl = d.get('period_label') or ''
                d['period_kind'] = 'quarter' if re.match(r'^\d{4}Q\d$', pl) else 'year' if re.match(r'^\d{4}$', pl) else 'other'
                # 그룹(교체 판정) 기준기간: 분기형은 본문 보고기간, 연·수시형은 DB 라벨(본문 제목의 분기는 «제출 분기»라 연간 항목에는 부적합)
                d['group_period'] = d['report_period'] if (d['period_kind'] == 'quarter' or d['item_code'] in QUARTERLY_ITEMS) and d['report_period'] else d.get('period_label_adj') or d['round_dir']
                if d.get('gp_override'):   # 20261124 DextA: 사건형 코드(20905·32135)의 교체 단위
                    d['group_period'] = d['gp_override']
                d['data_year'] = int(d['base_date'][:4]) if d.get('base_date') else None
                for si, r in enumerate(F):
                    r['seq'] = si
                    r['report_period'] = d['group_period']; r['body_period'] = d.get('report_period'); r['report_period_src'] = d.get('report_period_src')
                    r['is_correction'] = d['is_correction']; r['round_dir'] = d['round_dir']
                    for k in ('rel_path', 'inst_name', 'path'):
                        r.pop(k, None)  # doc 단위 정보는 docs.jsonl(doc_id 조인)
                    fo.write(json.dumps(r, ensure_ascii=False) + '\n')
                do.write(json.dumps(d, ensure_ascii=False) + '\n')
                n += 1
                if a.limit and n >= a.limit:
                    return
    print('docs', n)


if __name__ == '__main__':
    main()
