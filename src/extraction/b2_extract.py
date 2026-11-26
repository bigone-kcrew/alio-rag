#!/usr/bin/env python3
"""B 유형 확대 추출기(Bexp, 2026-11-24): 변환 md 의 xlsx 유래 표 → 행 JSONL. 오프라인·읽기 전용.
코드: 20701 업무추진비 · 21301 소송 · 43009 이사회(개별 비상임이사 활동) · 21502 기부 내역 · 32001 출연 내역.
방식(계약 contract_parser 와 같음): 머리글 변이가 커서 «열 이름 → 역할» 매핑, 행은 버리지 않고 사유를 parse_flags 로 남긴다.
  python3 b2_extract.py CODE --out rows.jsonl --docs-out docs.jsonl [--docs-csv docmap.csv] [--files a.md ...] [--limit N]
"""
import os, re, sys, json, csv, argparse, unicodedata, datetime, collections

import os
MD_ROOT = os.environ.get('MD_ROOT', './data/md/기관별공시') + '/'
B2_VER = {'20701': 'b2_bz_v2', '21301': 'b2_ls_v1', '43009': 'b2_bd_v1', '21502': 'b2_dn_v2', '32001': 'b2_co_v2'}
CODES = list(B2_VER)
import hashlib
# 행 동일성 키(문서 간 비교용): 파서 개정에도 같은 의미의 행이면 같은 키
SIGKEY = {'20701': ('yr', 'month', 'spent_date', 'category', 'n_cases', 'amount_won'), '21301': ('yr', 'case_no_raw', 'side', 'delegation', 'case_type'),
          '43009': ('meeting_no', 'meeting_date', 'agenda_text'), '21502': ('event_date', 'recipient', 'amount_won', 'row_no'), '32001': ('event_date', 'recipient', 'amount_won', 'row_no')}

# ---------------------------------------------------------------- 공통: md → 표
def split_row(line):
    s = line.strip()
    if s.startswith('|'): s = s[1:]
    if s.endswith('|') and not s.endswith('\\|'): s = s[:-1]
    cells = re.split(r'(?<!\\)\|', s)
    return [re.sub(r'\\([\\`*_\[\]#~<>(){}+!.-])', r'\1', c.replace('\\|', '|').replace('<br>', '\n')).strip() for c in cells]

def is_sep(cells):
    return all(re.fullmatch(r':?-{2,}:?', c.strip()) for c in cells if c.strip()) and any(c.strip() for c in cells)

def read_md(path):
    txt = open(path, encoding='utf-8', errors='replace').read()
    meta = {}
    m = re.match(r'---\n(.*?)\n---\n', txt, re.S)
    if m:
        for l in m.group(1).split('\n'):
            if ':' in l:
                k, v = l.split(':', 1); meta[k.strip()] = v.strip().strip('\'"')
        txt = txt[m.end():]
    sections = []; head = ''; cur = None; lastt = []
    for line in txt.split('\n'):
        if line.startswith('#'):
            head = line.lstrip('#').strip(); cur = None; lastt = []; continue
        if line.startswith('|'):
            cells = split_row(line)
            if is_sep(cells): continue
            if cur is None:
                cur = []; sections.append((head + (' ' + ' '.join(lastt[-2:]) if lastt else ''), cur)); lastt = []   # 표 바로 앞 본문 줄(pdf/hwp 유래 «(단위 : 천원)»)도 머리말로
            cur.append(cells)
        else:
            cur = None
            if line.strip(): lastt.append(line.strip()[:120])
    return meta, sections

def clean(s):
    s = unicodedata.normalize('NFKC', s or '')
    return re.sub(r'\s+', '', s)

def flat(s): return re.sub(r'\s+', ' ', (s or '').replace('\n', ' ')).strip()

DATE_RE = [re.compile(r'(?<!\d)(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})'),
           re.compile(r'(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)'),
           re.compile(r'(?<!\d)(\d{2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})(?!\d)')]

def valid_date(y, m, d):
    try: return datetime.date(y, m, d).isoformat()
    except ValueError: return None

def find_dates(s):
    s = unicodedata.normalize('NFKC', s or '')
    for i, rx in enumerate(DATE_RE):
        out = []
        for m in rx.finditer(s):
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if i == 2: y += 2000
            v = valid_date(y, mo, d) if 1990 <= y <= 2100 else None
            if v: out.append((m.start(), v))
        if out: return [d for _, d in sorted(out)]
    return []

def to_int(s, mult, flags, tag):
    s0 = (s or '').strip()
    if not s0 or re.fullmatch(r'[-–—ー~.]+|해당없음|없음|-원', s0): return None
    t = unicodedata.normalize('NFKC', s0)
    parts = [x for x in re.split(r'\n', t) if re.search(r'\d', x)]
    if len(parts) >= 2:                                   # 병합 셀에 값이 줄바꿈으로 여럿(«70,000<br>300,000», 실측 C0005) → 합산하고 표식
        flags.append('multi_value_cell_sum')
        vs = [to_int(x, mult, flags, tag) for x in parts]
        return sum(v for v in vs if v is not None) if any(v is not None for v in vs) else None
    neg = bool(re.match(r'^\(\s*[\d,.]+\s*\)$', t)) or t.startswith('-') or t.startswith('△') or t.startswith('▲')
    t = re.sub(r'[,\s원₩\\]|VAT포함|부가세포함|\(.*?\)', '', t).lstrip('-△▲')
    try: v = float(t)
    except ValueError:
        flags.append('amount_unparsed:' + tag); return None
    v = round(v * mult)
    if abs(v) > 9e18: flags.append('amount_overflow'); return None
    return -v if neg else v

UNIT_MULT = {'원': 1, '천원': 1000, '만원': 10000, '백만원': 1000000, '억원': 100000000}
def detect_unit(texts):
    """('단위: 천원' | '(천원)') 만 인정. 반환 (mult, name) — 없으면 (None, None)."""
    for t in texts:
        t = unicodedata.normalize('NFKC', t or '')
        m = re.search(r'단위\s*[:：]?\s*[^)]*?(백만원|천원|만원|억원|원)', t)      # «(단위: 건, 천원)» 처럼 앞에 다른 단위가 섞인 표기도
        if m: return UNIT_MULT[m.group(1)], m.group(1)
    for t in texts:
        t = unicodedata.normalize('NFKC', t or '')
        m = re.search(r'\((백만원|천원|만원|억원|원)\)', t)
        if m: return UNIT_MULT[m.group(1)], m.group(1)
    return None, None

YEAR_RE = re.compile(r'(?<!\d)(20[12]\d)\s*(?:년|학년|\.|-|\)|_|$|\s|도)|(?<!\d)(20[12]\d)(?!\d)')
def year_in(s):
    m = re.search(r"(?<!\d)(20[12]\d)(?!\d)", unicodedata.normalize('NFKC', s or ''))
    if m: return int(m.group(1))
    m = re.search(r"(?<!\d)'?(\d{2})\s*년", unicodedata.normalize('NFKC', s or ''))
    if m and 10 <= int(m.group(1)) <= 29: return 2000 + int(m.group(1))
    return None

TOTAL_RE = re.compile(r'^(합\s*계|소\s*계|총\s*계|계|누\s*계|총\s*합\s*계|월\s*계|요\s*약)$')
def is_total_label(s):
    t = re.sub(r'[:：]', '', clean(s))
    if re.search(r'(grandtotal|subtotal|total|sum)$', t.lower()): return True
    if re.match(r'^(누계|합계|소계|월계|총계|계|총)\s*(총)?\s*\d+건$', t): return True          # «누계 총 5건»
    return bool(TOTAL_RE.match(t)) or bool(re.search(r'(소계|합계|총계|월계|누계|요약)$', t))

def looks_data(cells):
    return any(re.search(r'\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{5,}', c) for c in cells)

def inst_of(folder):
    m = re.match(r'^\[(.*?)\](.*)_(C\d+)$', folder)
    if m: return m.group(3), m.group(2)
    m = re.match(r'^(.*)_(C\d+)$', folder)
    return (m.group(2), m.group(1)) if m else ('', folder)

PHONE = re.compile(r'(?<!\d)(0\d{1,3}[-.\s]?\d{3,4}[-.\s]?\d{4})(?!\d)|(?<!\d)(1[5-9]\d{2}[-.]\d{4})(?!\d)')
def nophone(x):
    """전화번호는 저장하지 않는다(개인정보 방어). 바꾼 경우 호출부가 플래그를 남긴다."""
    return PHONE.sub('[전화번호]', x) if x else x

def get(cells, j):
    return cells[j].strip() if j is not None and j < len(cells) else ''

# ---------------------------------------------------------------- 20701 업무추진비
BZ_ROLE = [
    ('year', r'^(집행|사용)?(연도|년도|년)$'),
    ('count', r'건수|횟수'),
    ('amount', r'금액|사용액|집행액|이용금액|합계|^금$'),
    ('headcount', r'^인원|참석인원|인원\(명\)'),
    ('who', r'집행자|사용자|집행관'),
    ('place', r'사용처|장소|집행처'),
    ('target', r'집행대상|대상자'),
    ('method', r'집행구분|결제|사용방법'),
    ('remark', r'^비고'),
    ('category', r'내역|내용|종류|목적|용도|구분|항목|적요|개요|유형'),
    ('when', r'^(집행|사용|이용)?(월|일|일자|일시|연월|년월|기간)$|집행월|집행일|사용일|이용일|월별|^월$|[년연]/?월'),
]
def bz_role(label):
    t = clean(label)
    if not t: return None
    for r, rx in BZ_ROLE:
        if re.search(rx, t): return r
    return 'other'

def bz_find_header(rows):
    # 1차: «금액/집행액/사용액» 라벨이 실제로 있는 행(다열 가로형 표에서 «총 합계» 그룹 행을 머리글로 오인하지 않도록), 2차: 기존 규칙
    for strict in (True, False):
        for i, r in enumerate(rows[:12]):
            if strict and not any(re.search(r'금액|집행액|사용액|지출액', clean(c)) for c in r): continue
            rs = [bz_role(c) for c in r]
            if 'amount' in rs and ('when' in rs or 'category' in rs or 'who' in rs) and not looks_data(r) \
               and not any(re.fullmatch(r'\d+', c.strip()) for c in r[:2] if c.strip()):
                return i
    return None

def bz_find_header_old(rows):
    for i, r in enumerate(rows[:12]):
        rs = [bz_role(c) for c in r]
        if 'amount' in rs and ('when' in rs or 'category' in rs or 'who' in rs) and not looks_data(r) \
           and not any(re.fullmatch(r'\d+', c.strip()) for c in r[:2] if c.strip()):
            return i
    return None

def bz_count_from_text(s):
    m = re.search(r'\(?\s*(\d[\d,]*|-)\s*건\s*\)?', s or '')
    if not m: return None
    return None if m.group(1) == '-' else int(m.group(1).replace(',', ''))

MONTH_VAL = re.compile(r'^\s*(\d{4}\s*년\s*)?\d{1,2}\s*월')
def bz_spec(rows, hi, head, prev=None):
    """머리글 행 hi 에서 열 역할·단위를 정한다. 반환 (spec, 다음 데이터 행)."""
    pre = [' '.join(r) for r in rows[:hi]]
    labels = list(rows[hi]); start = hi + 1
    mult, uname = detect_unit(pre[-3:] + [head] + labels)
    if start < len(rows) and not looks_data(rows[start]) and any(re.search(r'\((천원|원|만원)\)', c) for c in rows[start]) \
       and not any(re.fullmatch(r'\d+', c.strip()) for c in rows[start][:1] if c.strip()):
        labels = [(a + ' ' + b).strip() for a, b in zip(labels, rows[start] + [''] * len(labels))]; start += 1
        m2, u2 = detect_unit(labels)
        if m2: mult, uname = m2, u2
    roles = [bz_role(c) for c in labels]
    # 내용 기반 보정: 값이 «N월»·날짜인 열이 when 이 아니면(예: 머리글 «구분») when 으로, 밀려난 category 는 다음 글자 열로
    sample = rows[start:start + 15]
    if 'when' not in roles:
        for j in range(len(labels)):
            vals = [get(r, j) for r in sample if get(r, j)]
            if len(vals) >= 2 and sum(1 for v in vals if MONTH_VAL.match(unicodedata.normalize('NFKC', v)) or find_dates(v)) * 2 >= len(vals):
                roles[j] = 'when'; break
        if 'category' not in roles:
            for j in range(len(labels)):
                if roles[j] in ('other', None) and j != (roles.index('when') if 'when' in roles else -1) and sum(1 for r in sample if re.search(r'[가-힣A-Za-z]{2,}', get(r, j))) * 2 >= max(1, len(sample)):
                    roles[j] = 'category'; break
    seen = set(); rr = []
    for r in roles:
        if r in ('other', None): rr.append(r)
        elif r in seen: rr.append('dup_' + r)
        else: rr.append(r); seen.add(r)
    tflags = []
    if mult is None and prev is not None: mult, uname = prev['mult'], prev['uname']; tflags = [f for f in prev['tflags'] if f != 'unit_assumed_won'] + (['unit_assumed_won'] if 'unit_assumed_won' in prev['tflags'] else [])   # 표 안 머리글 반복: 앞 머리글의 단위를 이어받는다
    elif mult is None: mult, uname = 1, 'won_assumed'; tflags.append('unit_assumed_won')
    # 교차표(월 × 항목별 건수·금액 쌍): 금액 열이 둘 이상이고 윗 머리글 줄에 항목명이 있을 때 항목별로 펼친다
    pairs = []
    amt_cols = [j for j, c in enumerate(labels) if bz_role(c) == 'amount']
    if len(amt_cols) >= 2 and hi > 0 and not any('단위' in c for c in rows[hi - 1]):
        top = list(rows[hi - 1]) + [''] * len(labels); cur = ''; grp = []
        for j in range(len(labels)):
            if top[j].strip(): cur = flat(top[j])
            grp.append(cur)
        if len(set(grp[j] for j in amt_cols)) >= 2:
            for j in amt_cols:
                cj = next((k for k in list(range(j - 1, max(j - 3, -1), -1)) + [j + 1, j + 2] if 0 <= k < len(labels) and bz_role(labels[k]) == 'count' and grp[k] == grp[j]), None)
                pairs.append((grp[j], cj, j))
    return {'roles': rr, 'idx': {r: rr.index(r) for r in set(rr) if r}, 'mult': mult, 'uname': uname, 'tflags': tflags, 'labels': labels,
            'title': ' '.join(pre) + ' ' + head, 'pairs': pairs,
            'tposed': bool(pairs) and sum(1 for g, _, _ in pairs if re.match(r'\s*\d{1,2}\s*월', g or '')) >= 3}, start

def bz_is_header(r):
    rs = [bz_role(c) for c in r]
    return 'amount' in rs and ('when' in rs or 'category' in rs or 'who' in rs) and not looks_data(r) \
        and not any(re.search(r'\d', c) for c in r) or (len([x for x in rs if x not in ('other', None)]) >= 3 and not any(re.search(r'\d', c) for c in r) and 'amount' in rs)

def parse_20701(path, meta, sections, base):
    fname = base['file_stem']
    topical = ('업무추진비' in fname) or ('업무추진비' in (meta.get('original_file') or '')) or \
              any('업무추진비' in ' '.join(r[0] for r in rows[:3]) for _, rows in sections)
    if not topical: return [], {'parse_status': 'off_topic'}
    rows_out = []; years = collections.Counter(); ntab = 0; tinfo = []
    file_year = year_in(fname) or year_in(meta.get('original_file') or '')
    # 업무추진비 표 게이트(D3): 제목·머리글에 «업무추진비» 또는 «집행(일/월/내역/금액)» 이 있는 표만. 이름 붙은 표가 하나라도 있으면 나머지(경조비·물품구입 등 다른 시트)는 버린다.
    many = True
    named = [bool(re.search('업무추진비|집행', (' '.join(' '.join(r) for r in rows[:(bz_find_header(rows) or 0) + 1]) + ' ' + head))) for head, rows in sections]
    for ti, (head, rows) in enumerate(sections):
        hi = bz_find_header(rows)
        if hi is None: continue
        if many and any(named) and not named[ti]: continue
        if re.search(r'행레이블|합계:|개수:|평균:|열레이블', clean(' '.join(' '.join(r) for r in rows[:hi + 2]))): continue   # 엑셀 피벗 시트(실측 C0232): 별도 표로 적재하지 않는다
        tt = ' '.join(' '.join(r) for r in rows[:hi + 1]) + ' ' + head
        if re.search(r'신규채용|임원연봉|평균보수|복리후생|노동조합|임직원|초임|인턴|유연근무|자본금|일반현황', tt) and '업무추진비' not in tt:
            continue   # 공시 전체 통합 워크북의 다른 시트(실측: 파일명만 업무추진비)
        spec, start = bz_spec(rows, hi, head)
        t_year = year_in(spec['title']) or file_year
        ntab += 1
        cur_when = None; cur_year = None; n_before = len(rows_out); nhdr = 1
        k = start
        while k < len(rows):
            cells = list(rows[k]); kk = k; k += 1
            if not any(c.strip() for c in cells): continue
            if bz_is_header(cells):          # 표 안에서 머리글이 다시 나옴(총괄표 → 세부표, 반복 머리글)
                spec, st2 = bz_spec(rows, kk, head, spec); k = st2; cur_when = None; nhdr += 1; continue
            roles, idx, mult, uname = spec['roles'], spec['idx'], spec['mult'], spec['uname']
            cells = cells + [''] * (len(roles) - len(cells))
            fl = list(spec['tflags'])
            when = get(cells, idx.get('when')); cat = get(cells, idx.get('category')); cnt_s = get(cells, idx.get('count'))
            for jj, rl in enumerate(roles):
                if rl == 'dup_category' and get(cells, jj) and get(cells, jj) not in cat: cat = (cat + ' / ' + get(cells, jj)) if cat else get(cells, jj)
            amt_s = get(cells, idx.get('amount')); ycell = get(cells, idx.get('year'))
            summ = is_total_label(when) or is_total_label(cat) or any(is_total_label(c) for c in cells[:3])
            if any('javascript:' in c for c in cells):      # 공시 페이지 본문 표의 첨부 다운로드 링크 행(실측: 본문 doc 의 연도별 합계표)
                summ = True; fl.append('page_link_row')
            month = None; sdate = None
            wc = unicodedata.normalize('NFKC', when).replace('月', '월')
            if 'when' not in idx and not summ and re.fullmatch(r'\s*\d{1,2}\s*월?\s*', unicodedata.normalize('NFKC', cat)) and 1 <= int(re.sub(r'\D', '', cat)) <= 12:
                mh = int(re.sub(r'\D', '', cat)); cur_when = (mh, None)      # 월 머리 행(«1», «2» …): 그 아래 항목 행의 월, 자신은 월 합계 → 집계 제외
                rows_out.append({'table_idx': ti, 'table_row': kk - start, 'yr': cur_year or t_year, 'month': mh, 'spent_date': None, 'category': None, 'n_cases': None, 'amount_won': to_int(amt_s, mult, [], 'amount'),
                                 'spender': None, 'place': None, 'target': None, 'pay_method': None, 'headcount': None, 'remark': None, 'unit_name': uname, 'unit_mult': mult,
                                 'is_summary': True, 'parse_flags': list(spec['tflags']) + ['month_header_row', 'total_row']})
                continue
            m = re.match(r'^\s*(\d{1,2})\s*월', wc)
            ds = find_dates(wc)
            ym = re.match(r'^\s*(20\d\d)\s*[년.\-/]\s*(\d{1,2})\s*[월.]?\s*$', wc)
            if ds: sdate = ds[0]; month = int(sdate[5:7])
            elif re.fullmatch(r'\s*(\d{1,2})\s*[./-]\s*(\d{1,2})\s*\.?\s*', wc) and 1 <= int(re.match(r'\s*(\d{1,2})', wc).group(1)) <= 12 and (cur_year or t_year):
                mdm = re.fullmatch(r'\s*(\d{1,2})\s*[./-]\s*(\d{1,2})\s*\.?\s*', wc)
                month = int(mdm.group(1)); sdate = valid_date(cur_year or t_year, month, int(mdm.group(2))); fl.append('date_md_year_from_title')
            elif ym and 1 <= int(ym.group(2)) <= 12: month = int(ym.group(2)); cur_year = int(ym.group(1)); fl.append('year_from_when')
            elif m and 1 <= int(m.group(1)) <= 12: month = int(m.group(1))
            elif re.fullmatch(r'\d{1,2}', wc.strip()) and 'when' in idx and 1 <= int(wc) <= 12: month = int(wc)
            if not when: fl.append('when_blank')
            if when and not summ and (month is not None): cur_when = (month, sdate)
            elif not when and not summ and cur_when and cat:
                month, sdate = cur_when; fl.append('month_carried')
            if summ: fl.append('total_row')
            if ycell and re.search(r'20\d\d', ycell): cur_year = int(re.search(r'20\d\d', ycell).group(0))
            ymv = re.search(r'(20\d\d)\s*년', wc)
            if ymv: cur_year = int(ymv.group(1))
            yr = int(sdate[:4]) if sdate else (cur_year or t_year)
            if spec['pairs'] and spec.get('tposed'):
                # 가로 월형(행=분류, 열 그룹=월별 건수·금액, 마지막 그룹=합계): 분류는 첫 칸, 월은 열 그룹 머리글
                cat0 = flat(get(cells, 0))
                if not cat0 or re.fullmatch(r'\d+', cat0): continue
                for gl, cj, aj in spec['pairs']:
                    f2 = fl + ['crosstab_transposed']
                    a2 = to_int(get(cells, aj), mult, f2, 'amount')
                    cs = get(cells, cj); n2 = int(cs) if re.fullmatch(r'\d+', cs.strip()) else None
                    if a2 is None and n2 is None: continue
                    mm = re.match(r'\s*(\d{1,2})\s*월', gl or '')
                    rows_out.append({'table_idx': ti, 'table_row': kk - start, 'yr': cur_year or t_year, 'month': int(mm.group(1)) if mm else None, 'spent_date': None,
                                     'category': cat0, 'n_cases': n2, 'amount_won': a2, 'spender': None, 'place': None, 'target': None, 'pay_method': None, 'headcount': None,
                                     'remark': None, 'unit_name': uname, 'unit_mult': mult, 'is_summary': bool(summ or is_total_label(cat0) or not mm), 'parse_flags': f2 + (['total_row'] if (is_total_label(cat0) or not mm) else [])})
                continue
            if spec['pairs']:
                if not (month or sdate or summ): continue      # 월 칸이 비면 머리글 잔여·주석 줄
                for gl, cj, aj in spec['pairs']:
                    f2 = fl + ['crosstab']
                    a2 = to_int(get(cells, aj), mult, f2, 'amount')
                    cs = get(cells, cj); n2 = int(cs) if re.fullmatch(r'\d+', cs.strip()) else None
                    if a2 is None and n2 is None: continue
                    rows_out.append({'table_idx': ti, 'table_row': kk - start, 'yr': yr, 'month': month, 'spent_date': sdate, 'category': gl or None,
                                     'n_cases': n2, 'amount_won': a2, 'spender': None, 'place': None, 'target': None, 'pay_method': None, 'headcount': None,
                                     'remark': None, 'unit_name': uname, 'unit_mult': mult, 'is_summary': bool(summ or is_total_label(gl)), 'parse_flags': f2})
                continue
            n = None
            if cnt_s:
                n = bz_count_from_text(cnt_s)
                if n is None:
                    t = unicodedata.normalize('NFKC', cnt_s).replace(',', '').strip()
                    n = int(t) if re.fullmatch(r'\d+', t) else None
            if n is None:
                n = bz_count_from_text(cat)
                if n is not None: fl.append('count_from_text')
            amt = to_int(amt_s, mult, fl, 'amount')
            if (cat in ('', '-') and amt is None and (n in (None, 0))) and not summ:
                continue   # 내역·금액·건수가 모두 비어 있는 줄(월 칸만 숫자): 집행 없음 표기 — 행으로 저장하지 않는다
            if not when and not cat and not summ and amt is not None and 'when' in idx:
                summ = True; fl.append('unlabeled_total')   # 월·내역 칸이 모두 빈 금액 줄 = 합계(실측: «계 : 6564620»)
            elif 'when' in idx and not when and not cat and not summ: fl.append('no_when_no_cat')
            if month is None and sdate is None and not summ: fl.append('no_month')
            if amt is not None and abs(amt) > 1e12: fl.append('amount_gt_1e12')
            elif amt is not None and abs(amt) >= 1e11: fl.append('amount_review_ge_1e11')
            hc = get(cells, idx.get('headcount'))
            for _k in ('place', 'target', 'remark', 'who', 'method'):
                _v = get(cells, idx.get(_k))
                if _v and PHONE.search(_v): fl.append('phone_removed'); break
            rows_out.append({'table_idx': ti, 'table_row': kk - start, 'yr': yr, 'month': month, 'spent_date': sdate,
                             'category': flat(cat) or None, 'n_cases': n, 'amount_won': amt,
                             'spender': nophone(flat(get(cells, idx.get('who')))) or None, 'place': nophone(flat(get(cells, idx.get('place')))) or None,
                             'target': nophone(flat(get(cells, idx.get('target')))) or None, 'pay_method': nophone(flat(get(cells, idx.get('method')))) or None,
                             'headcount': int(re.sub(r'\D', '', hc)) if re.fullmatch(r'\s*\d+\s*(명)?\s*', hc) else None,
                             'remark': nophone(flat(get(cells, idx.get('remark')))) or None,
                             'unit_name': uname, 'unit_mult': mult, 'is_summary': summ, 'parse_flags': fl})
            if not summ and yr: years[yr] += 1
        tinfo.append({'table_idx': ti, 'unit': spec['uname'], 'labels': [flat(x) for x in spec['labels']], 'n_rows': len(rows_out) - n_before, 'n_headers': nhdr})
    if not ntab:      # N5: 머리글 없는 «월 | (내역) | 건수? | 금액» 표 — 월 값 행이 6개 이상(서로 다른 월)이고 숫자열이 있는 표만 채택(오탐 방지)
        for ti, (head, rows) in enumerate(sections):
            mrows = [r for r in rows if r and re.fullmatch(r'\s*\d{1,2}\s*월\s*', unicodedata.normalize('NFKC', r[0])) and any(re.fullmatch(r'-?[\d,.]+', c.strip()) for c in r[1:])]
            if len(set(clean(r[0]) for r in mrows)) < 6: continue
            if sum(1 for r in mrows if any(re.search(r'금액|건수|합계|구분', c) for c in r[1:3])) * 3 > len(mrows): continue   # 라벨 낱말이 값 칸에 있으면 가로형 등 다른 구조 → 채택 안 함
            mult, uname = detect_unit([head] + [' '.join(r) for r in rows[:4]])
            fl0 = ['headerless_table']
            if mult is None: mult, uname = 1, 'won_assumed'; fl0.append('unit_assumed_won')
            yr0 = year_in(head + ' ' + ' '.join(' '.join(r) for r in rows[:3])) or file_year
            ntab += 1; nb = len(rows_out); cur_m = None
            for k, r in enumerate(rows):
                if not r or not any(c.strip() for c in r): continue
                m0 = re.fullmatch(r'\s*(\d{1,2})\s*월\s*', unicodedata.normalize('NFKC', r[0]))
                nums = [(j, c) for j, c in enumerate(r[1:], 1) if re.fullmatch(r'-?[\d,.]+', c.strip())]
                texts = [c for c in r[1:] if c.strip() and not re.fullmatch(r'-?[\d,.]+|-', c.strip())]
                summ = is_total_label(r[0]) or any(is_total_label(c) for c in texts[:1])
                if m0: cur_m = int(m0.group(1))
                if not nums or (not m0 and not summ and cur_m is None): continue
                fl = list(fl0)
                amt = to_int(nums[-1][1], mult, fl, 'amount')
                n = int(nums[-2][1]) if len(nums) >= 2 and re.fullmatch(r'\d{1,3}', nums[-2][1].strip()) else None
                rows_out.append({'table_idx': ti, 'table_row': k, 'yr': yr0, 'month': cur_m if not summ else None, 'spent_date': None,
                                 'category': flat(texts[0]) if texts else None, 'n_cases': n, 'amount_won': amt, 'spender': None, 'place': None, 'target': None,
                                 'pay_method': None, 'headcount': None, 'remark': None, 'unit_name': uname, 'unit_mult': mult, 'is_summary': summ or not m0 and cur_m is None,
                                 'parse_flags': fl + (['total_row'] if summ else [])})
                if not summ and yr0: years[yr0] += 1
            tinfo.append({'table_idx': ti, 'unit': uname, 'labels': ['(headerless)'], 'n_rows': len(rows_out) - nb, 'n_headers': 0})
    docx = {'parse_status': 'ok' if rows_out else ('no_table' if not ntab else 'no_rows'), 'tables': tinfo}
    docx['target_year'] = years.most_common(1)[0][0] if years else file_year
    # 월이 항목 행 아래의 «소계» 행에 적힌 표(산업은행형): 직전의 월 없는 항목 행들에 그 월을 달아 준다
    pend = []
    for r in rows_out:
        if r['is_summary'] and r['month'] is not None and pend and pend[0]['table_idx'] == r['table_idx']:
            for q in pend: q['month'] = r['month']; q['parse_flags'].append('month_from_subtotal')
            pend = []
        elif not r['is_summary'] and r['month'] is None and r['spent_date'] is None and 'when_blank' in r['parse_flags']: pend.append(r)
        else: pend = []
    # 병합 셀 금액 반복: «월 칸이 있는 첫 행 + 월 칸이 빈 이어진 행들» 이 같은 금액(>0)을 모두 가지면 월 합계가 병합 셀로 반복 표기된 것 → 첫 행만 남기고 NULL
    i = 0
    while i < len(rows_out):
        r0 = rows_out[i]
        if r0['is_summary'] or 'month_carried' in r0['parse_flags'] or not r0['amount_won'] or 'crosstab' in r0['parse_flags']: i += 1; continue
        j = i + 1
        while j < len(rows_out) and 'month_carried' in rows_out[j]['parse_flags'] and not rows_out[j]['is_summary'] and rows_out[j]['table_idx'] == r0['table_idx']: j += 1
        if j - i >= 2 and all(rows_out[k]['amount_won'] == r0['amount_won'] for k in range(i + 1, j)):
            r0['parse_flags'].append('amount_merged_first')
            for k in range(i + 1, j): rows_out[k]['amount_won'] = None; rows_out[k]['parse_flags'].append('amount_merged_dup')
        i = j
    # 월(일자)이 있는 행이 있는 문서에서 월이 없는 행 = «총괄집행내역» 같은 요약 블록(실측: 노사발전재단 «기관장 50건 7,385,000») → 이중 집계 방지로 집계 제외
    if any((r['month'] or r['spent_date']) and not r['is_summary'] for r in rows_out):
        for r in rows_out:
            if not r['is_summary'] and r['month'] is None and r['spent_date'] is None:
                r['is_summary'] = True; r['parse_flags'].append('overall_block')
    # 한 문서에 월별 집계표와 건별(일자) 세부표가 함께 있으면(실측 53/3,283 문서) 같은 금액이 두 번 잡힌다 → 한쪽만 집계 대상.
    # 두 합계가 ±2% 이내로 맞으면 세부(건별)를, 아니면 합계가 큰(더 완전한) 쪽을 남기고 나머지는 is_summary + granularity_dup 플래그.
    # N3: «N건» 라벨뿐인 행인데 금액이 문서 총계행 금액과 같다 → 총계(실측 C0866 «102건»); 같은 (월,금액) 시그니처 표가 한 문서에 둘 이상이면 첫 표만(C0902 table 0·1)
    decl_all = [r['amount_won'] for r in rows_out if r['is_summary'] and 'total_row' in r['parse_flags'] and r.get('amount_won') and not r.get('month')]
    dmax = max(decl_all) if decl_all else None
    if dmax:
        for r in rows_out:
            if not r['is_summary'] and r['amount_won'] == dmax and re.fullmatch(r'\s*\d+\s*건\s*', r['category'] or '') :
                r['is_summary'] = True; r['parse_flags'].append('count_label_total')
    seen_sig = {}
    for ti in sorted(set(r['table_idx'] for r in rows_out)):
        tr = [r for r in rows_out if r['table_idx'] == ti and not r['is_summary'] and r['amount_won']]
        if len(tr) < 6: continue
        sig = tuple(sorted((r['month'] or 0, r['amount_won']) for r in tr))
        if sig in seen_sig:
            for r in rows_out:
                if r['table_idx'] == ti and not r['is_summary']: r['is_summary'] = True; r['parse_flags'].append('dup_table')
        else: seen_sig[sig] = ti
    # N8: «연간 개요표 + 월별 시트»(C0284·C0043·C1120): 같은 연도에서 표 합 최대 ≈ 나머지 표 합(±2%) 이면 나머지(작은 쪽) 표들은 요약 처리
    for yy in set(r.get('yr') for r in rows_out):
        tabs = collections.defaultdict(list)
        for r in rows_out:
            if r.get('yr') == yy and not r['is_summary'] and r['amount_won']: tabs[r['table_idx']].append(r)
        sums = {ti: sum(x['amount_won'] for x in rs) for ti, rs in tabs.items()}
        if len(sums) == 2:      # 거의 같은 표가 둘(반올림 차이 등): 행 수 같고 합이 ±2% 이내면 뒤의 표를 중복으로
            (t1, a1), (t2, a2) = sorted(sums.items())
            if len(tabs[t1]) == len(tabs[t2]) >= 6 and a1 and abs(a1 - a2) <= 0.02 * a1:
                for x in tabs[t2]: x['is_summary'] = True; x['parse_flags'].append('dup_table_approx')
        if len(sums) >= 3:
            big = max(sums, key=sums.get); rest = sum(v for k, v in sums.items() if k != big)
            if rest and abs(sums[big] - rest) <= 0.02 * sums[big]:
                for ti, rs in tabs.items():
                    if ti != big:
                        for x in rs: x['is_summary'] = True; x['parse_flags'].append('overview_dup')
    det = [r for r in rows_out if not r['is_summary'] and r['spent_date']]
    agg = [r for r in rows_out if not r['is_summary'] and not r['spent_date'] and r['month']]
    if det and agg:
        ds_, as_ = sum(r['amount_won'] or 0 for r in det), sum(r['amount_won'] or 0 for r in agg)
        if dmax:       # N6: 문서 총계행에 더 가까운 쪽을 채택(±2% 안이면 세부 우선)
            ed, ea = abs(ds_ - dmax) / dmax, abs(as_ - dmax) / dmax
            keep_det = ed <= 0.02 or (ea > 0.02 and ed <= ea)
        else:
            keep_det = (as_ and 0.98 <= ds_ / as_ <= 1.02) or ds_ >= as_
        for r in (agg if keep_det else det):
            r['is_summary'] = True; r['parse_flags'].append('granularity_dup:' + ('detail' if keep_det else 'monthly'))
        docx['granularity'] = 'detail' if keep_det else 'monthly'
    bz_unit_fix(rows_out, docx)
    return rows_out, docx

def bz_unit_fix(rows_all, docx):
    """단위 오판 방어 — (표, 연도) 단위(한 문서에 연도별 시트가 있고 시트마다 단위 사정이 다르다: 실측 C1055).
    ① 천원 환산 합계 >10억원 → 값이 이미 원 단위로 보고 배수 1(unit_corrected_to_won).
    ② 원 단위(선언·가정)인데 0 아닌 금액 중앙값 <1,000 → 천원 단위로 보고 ×1000(unit_corrected_to_thousand).
    행마다 플래그를 남긴다. 기관 내 이웃연도 대조는 b2_recompute 가 한 번 더 한다."""
    groups = collections.defaultdict(list)
    for r in rows_all: groups[(r['table_idx'], r.get('yr'))].append(r)
    fixes = set()
    for rows in groups.values():
        vals = [r['amount_won'] for r in rows if not r['is_summary'] and r['amount_won']]
        if not vals: continue
        mults = set(r['unit_mult'] for r in rows)
        if mults == {1000} and sum(vals) > 1_000_000_000:
            for r in rows:
                r['unit_mult'] = 1; r['unit_name'] += '->원보정'; r['parse_flags'].append('unit_corrected_to_won')
                if r['amount_won'] is not None: r['amount_won'] //= 1000
            fixes.add('to_won')
        elif mults == {1} and ((sorted(vals)[len(vals) // 2] < 1000 and max(vals) < 100000) or (len(vals) >= 6 and sum(vals) < 300000 and max(vals) < 50000)):   # 뒤쪽: 연 합계 30만원 미만에 6건 이상 = 천원 값(실측 C0327·C0920 2021)
            for r in rows:
                r['unit_mult'] = 1000; r['unit_name'] += '->천원보정'; r['parse_flags'].append('unit_corrected_to_thousand')
                if r['amount_won'] is not None: r['amount_won'] *= 1000
            fixes.add('to_thousand')
    if fixes: docx['unit_fix'] = '+'.join(sorted(fixes))

# ---------------------------------------------------------------- 21301 소송
def ls_find_header(rows):
    for i, r in enumerate(rows[:6]):
        t = [clean(c) for c in r]
        if any(re.search(r'제.{0,2}피소|제소', c) for c in t) and any('사건' in c for c in t):
            return i
    return None

def parse_21301(path, meta, sections, base):
    rows_out = []; ntab = 0; tinfo = []; skipped = 0
    file_year = year_in(base['file_stem']) or year_in(meta.get('original_file') or '')
    for ti, (head, rows) in enumerate(sections):
        hi = ls_find_header(rows)
        if hi is None: continue
        labels = [clean(c) for c in rows[hi]]
        title = ' '.join(' '.join(r) for r in rows[:hi]) + ' ' + head
        ntab += 1
        def col(rx):
            for j, c in enumerate(labels):
                if re.search(rx, c): return j
            return None
        j_no = col(r'^(구분|순번|연번|번호|No)'); j_side = col(r'제.{0,2}피소|제소'); j_del = col(r'위임|수행'); j_kind = col(r'사건|종류'); j_rem = col(r'비고')
        if j_no is None: j_no = 0
        nb = len(rows_out)
        for k, cells in enumerate(rows[hi + 1:]):
            cells = list(cells) + [''] * 5
            if not any(c.strip() for c in cells): continue
            fl = []
            no = get(cells, j_no); side = flat(get(cells, j_side)); dele = flat(get(cells, j_del)); kind = flat(get(cells, j_kind))
            if re.match(r'^(구분|순번|연번)$', clean(no)) and re.search(r'피소', clean(side)): continue
            summ = is_total_label(no) or is_total_label(kind) or bool(re.match(r'^(총|합)', clean(no)))
            if summ: fl.append('total_row')
            no_n = unicodedata.normalize('NFKC', no).replace('\\', '')
            n_cases = None
            no_n = re.sub(r'(?<=\d),(?=\d{3}(?!\d))', '', no_n)   # 천 단위 쉼표(1,590-1,615)
            m = re.fullmatch(r'\s*(\d+)\s*[~∼～\-–]\s*(\d+)\s*', no_n)
            if m:
                a, b = int(m.group(1)), int(m.group(2))
                if b >= a: n_cases = b - a + 1; fl.append('case_range')
                else: fl.append('range_invalid')
            elif re.fullmatch(r'\s*\d+\s*', no_n): n_cases = 1
            elif re.fullmatch(r'\s*\d+(\s*,\s*\d+)+\s*', no_n): n_cases = len(no_n.split(',')); fl.append('case_list')
            side_n = clean(side)
            if not (re.search(r'제소|피소|^제$|^피$|제.피', side_n) or re.fullmatch(r'[-–없음해당사항무0]*', side_n)):
                skipped += 1; continue   # 옆 표(소송대리인 명단·건수 요약)가 같은 md 표로 이어진 줄: 소송 행이 아님
            no_case = bool(re.fullmatch(r'[-–없음해당무]*', side_n)) and bool(re.fullmatch(r'[-–없음해당무]*', clean(kind)))
            if no_case and not summ:
                fl.append('no_case'); n_cases = 0
            if n_cases is None and not summ: fl.append('no_count')
            plaintiff = None
            if '피소' in side_n: plaintiff = 'defendant'          # 기관이 피소(피고)
            elif '제소' in side_n: plaintiff = 'plaintiff'          # 기관이 제소(원고)
            elif not no_case: fl.append('side_unknown')
            delg = None
            if re.search(r'직접|자체', clean(dele)) or clean(dele) == '부': delg = 'direct'
            elif '위임' in clean(dele) or clean(dele) == '여': delg = 'delegated'
            elif re.fullmatch(r'[-–없음해당사항미선임]*', clean(dele)): delg = None
            else: fl.append('delegation_other')
            rows_out.append({'table_idx': ti, 'table_row': k, 'yr': year_in(title) or file_year, 'case_no_raw': no_n.strip() or None, 'n_cases': n_cases,
                             'side': plaintiff, 'side_raw': side or None, 'delegation': delg, 'delegation_raw': dele or None,
                             'case_type': kind or None, 'remark': flat(get(cells, j_rem)) or None,
                             'is_summary': summ, 'parse_flags': fl})
        tinfo.append({'table_idx': ti, 'labels': labels, 'n_rows': len(rows_out) - nb, 'title': flat(title)[:80]})
    y = collections.Counter(r['yr'] for r in rows_out if r['yr'])
    return rows_out, {'parse_status': 'ok' if rows_out else ('no_table' if not ntab else 'no_rows'), 'tables': tinfo, 'n_skipped': skipped,
                      'target_year': y.most_common(1)[0][0] if y else file_year}

# ---------------------------------------------------------------- 43009 이사회(개별 비상임이사 활동)
VOTE_TOK = {'찬성': 'for', '반대': 'against', '불참': 'absent', '기권': 'abstain', '보류': 'hold', '임명전': 'pre', '퇴직': 'retired', '퇴임': 'retired',
            '회피': 'abstain', '사임': 'retired', '해임': 'retired', '면직': 'retired', '임기만료': 'retired', '불출석': 'absent',
            '참석': 'attend', '출석': 'attend'}
def bd_vote(c):
    t = clean(c)
    if t in ('', '-', 'ㅡ', '–'): return None
    for k, v in VOTE_TOK.items():
        if t.startswith(k): return v
    if re.fullmatch(r'[○O◯ㅇ]', t): return 'attend'
    if re.fullmatch(r'[Xx×]', t): return 'absent'
    return 'other'

MTG_NO = re.compile(r'^제?(\d{1,3})(?:\.0)?(차|회|회차)?$')
def parse_43009(path, meta, sections, base):
    rows_out = []; tinfo = []; ntab = 0; hdr_only = 0
    for ti, (head, rows) in enumerate(sections):
        c_no = None
        for r in rows[:8]:
            for j, c in enumerate(r):
                if clean(c) == '회차': c_no = j; break
            if c_no is not None: break
        if c_no is None: c_no = 0
        c_dt = c_no + 1
        ds = None
        for i, r in enumerate(rows):
            if len(r) > c_dt and MTG_NO.match(clean(get(r, c_no))) and find_dates(get(r, c_dt)):
                ds = i; break
        if ds is None:
            if any('회차' in clean(c) for r in rows[:6] for c in r): hdr_only += 1; tinfo.append({'table_idx': ti, 'status': 'header_only'})
            continue
        hdr = rows[:ds]
        hcl = [[clean(c) for c in r] for r in hdr]
        ntab += 1
        def find(rx):
            for r in hcl:
                for j, c in enumerate(r):
                    if re.fullmatch(rx, c): return j
            return None
        j_type = find(r'유형'); j_item = find(r'내용|안건내용'); j_res = find(r'가결(\(?부결\)?)?여부|가결|결과')
        wide = j_type is not None or j_item is not None
        j_type = c_no + 2 if j_type is None else j_type
        j_res = (c_no + 4 if j_res is None else j_res)
        if j_item is None: j_item = c_no + 3
        probe = [clean(get(r, j_type)) for r in rows[ds:ds + 6]]
        flags_t = []
        if not any(re.match(r'의결|보고|협의|논의|심의|토의|기타|수정|원안|조건', p) for p in probe):
            flags_t.append('type_col_unverified')
        ncol = max(len(r) for r in rows)
        vote_cols = []
        for j in range(j_res + 1, ncol):
            vals = [bd_vote(get(r, j)) for r in rows[ds:] if get(r, j)]
            vals = [v for v in vals if v]                      # '-' 칸(보고 안건)은 세지 않는다
            if vals and sum(1 for v in vals if v != 'other') >= max(1, len(vals) // 2): vote_cols.append(j)
        nb = len(rows_out); cur = {}
        for k, cells in enumerate(rows[ds:]):
            cells = list(cells) + [''] * (ncol - len(cells))
            fl = list(flags_t)
            mm = MTG_NO.match(clean(cells[c_no])); dts = find_dates(cells[c_dt])
            if not (mm and dts):
                if cur and not clean(cells[c_no]) and not clean(cells[c_dt]) and (clean(get(cells, j_type)) or clean(get(cells, j_item))):
                    fl.append('meeting_carried')
                else:
                    continue
            else:
                cur = {'no': int(mm.group(1)), 'date': dts[0]}
                if len(dts) > 1: fl.append('date_range')
            vt = [bd_vote(get(cells, j)) for j in vote_cols]
            cnt = collections.Counter(v for v in vt if v)
            item = get(cells, j_item)
            if not wide and '\n' in item: fl.append('multi_agenda_cell')   # 안건내용 한 칸에 여러 안건(광해광업공단형)
            typ = flat(get(cells, j_type)); res = flat(get(cells, j_res))
            if not typ and not item: continue
            rows_out.append({'table_idx': ti, 'table_row': k, 'meeting_no': cur['no'], 'meeting_date': cur['date'],
                             'agenda_type': typ or None, 'agenda_text': flat(item) or None, 'result': res or None,
                             'n_vote_cols': len(vote_cols), 'n_for': cnt.get('for', 0), 'n_against': cnt.get('against', 0), 'n_absent': cnt.get('absent', 0),
                             'n_abstain': cnt.get('abstain', 0) + cnt.get('hold', 0), 'n_not_eligible': cnt.get('pre', 0) + cnt.get('retired', 0),
                             'yr': int(cur['date'][:4]), 'is_summary': False, 'parse_flags': fl})
        tinfo.append({'table_idx': ti, 'n_rows': len(rows_out) - nb, 'vote_cols': len(vote_cols), 'wide': wide})
    y = collections.Counter(r['yr'] for r in rows_out)
    return rows_out, {'parse_status': 'ok' if rows_out else ('header_only' if hdr_only else ('no_table' if not ntab else 'no_rows')), 'tables': tinfo,
                      'target_year': y.most_common(1)[0][0] if y else year_in(base['file_stem'])}

# ---------------------------------------------------------------- 32001 출연 / 21502 기부 (같은 모양: 일자·수령인·관계·금액·목적물·사유)
def lst_roles(labels, kind):
    out = []
    for c in labels:
        t = clean(c)
        if re.search(r'^(연번|번호|순번|No|구분)$', t): r = 'no'
        elif re.search(r'출연일|기부일|^날짜|일자|지급일|집행일|^일시', t): r = 'date'
        elif re.search(r'수령인|수증인|피출연|출연대상|수혜|기부처|수령처|기부대상|^대상|수령기관', t): r = 'recipient'
        elif re.search(r'^관계', t): r = 'relation'
        elif re.search(r'금액|지급액|출연액|기부액', t): r = 'amount'
        elif re.search(r'출연목적물|목적물|기부물품|형태|종류', t): r = 'object'
        elif re.search(r'사유|목적|내용|비고', t): r = 'reason'
        else: r = 'other'
        out.append(r)
    return out

def lst_find_header(rows, kind):
    for i, r in enumerate(rows[:8]):
        rs = lst_roles(r, kind)
        if 'amount' in rs and 'recipient' in rs and 'date' in rs and not looks_data(r): return i
        # 2단 머리글(출연금액 / (천원))
        if 'recipient' in rs and 'date' in rs and 'amount' not in rs and i + 1 < len(rows):
            m = lst_roles([a + b for a, b in zip(r, rows[i + 1] + [''] * len(r))], kind)
            if 'amount' in m and not looks_data(rows[i + 1]): return i
    return None

def parse_list(code, path, meta, sections, base):
    kind = 'co' if code == '32001' else 'dn'
    rows_out = []; ntab = 0; tinfo = []
    file_year = year_in(base['file_stem']) or year_in(meta.get('original_file') or '')
    for ti, (head, rows) in enumerate(sections):
        hi = lst_find_header(rows, kind)
        if hi is None: continue
        labels = list(rows[hi]); start = hi + 1
        pre = [' '.join(r) for r in rows[:hi]]
        if start < len(rows) and not looks_data(rows[start]) and roles_amount_split(labels, rows[start], kind):
            labels = [(a + ' ' + b).strip() for a, b in zip(labels, rows[start] + [''] * len(labels))]; start += 1
        roles = lst_roles(labels, kind)
        seen = set(); rr = []
        for r in roles:
            if r in ('other',): rr.append(r)
            elif r in seen: rr.append('dup_' + r)
            else: rr.append(r); seen.add(r)
        roles = rr; idx = {r: roles.index(r) for r in set(roles)}
        mult, uname = detect_unit(pre + [head] + labels)
        tflags = []
        if mult is None:
            if code == '32001': mult, uname = 1000, 'thousand_form_default'; tflags.append('unit_form_default_thousand')
            else: mult, uname = 1, 'won_assumed'; tflags.append('unit_assumed_won')
        title = ' '.join(pre) + ' ' + head
        ntab += 1; nb = len(rows_out)
        for k, cells in enumerate(rows[start:]):
            cells = list(cells) + [''] * (len(roles) - len(cells))
            if not any(c.strip() for c in cells): continue
            fl = list(tflags)
            no = get(cells, idx.get('no')); rec = flat(get(cells, idx.get('recipient'))); dts = get(cells, idx.get('date'))
            amt_s = get(cells, idx.get('amount'))
            summ = is_total_label(no) or is_total_label(rec) or is_total_label(dts) or (not no and not rec and not dts and bool(amt_s)) \
                   or bool(re.search(r'(합계|소계|총계|누계|총액|계)$', re.sub(r'\s+', '', no))) or bool(re.search(r'(내역|기부|출연)?(합계|소계|총계|누계)$|^(연간|총)\s*(기부|출연)', re.sub(r'\s+', '', rec)))
            if re.match(r'^[※*주]', cells[0].strip()) : continue   # 주석 줄
            if not any(re.search(r'\d', c) for c in cells) and sum(1 for r in lst_roles(cells, kind) if r not in ('other', 'reason')) >= 3: continue   # 반복·2단 머리글 줄
            if summ: fl.append('total_row')
            if not summ and not rec and not dts and not amt_s: continue
            ds = find_dates(dts)
            sdate = ds[0] if ds else None
            dt = unicodedata.normalize('NFKC', dts).strip()
            if not sdate and re.fullmatch(r'\d{5}(\.0)?', dt) and 30000 < int(float(dt)) < 60000:      # 엑셀 일련번호가 변환되지 않고 남은 경우
                sdate = (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(float(dt)))).isoformat(); fl.append('date_serial')
            elif not sdate and re.fullmatch(r'\d{6}', dt) and 10 <= int(dt[:2]) <= 29:                 # YYMMDD
                sdate = valid_date(2000 + int(dt[:2]), int(dt[2:4]), int(dt[4:])); fl.append('date_yymmdd' if sdate else 'date_unparsed')
            ym = re.match(r'^(20\d\d)\s*[-./년]\s*(\d{1,2})\s*월?$', dt) if not sdate else None
            if ym: fl.append('date_month_only')
            if dts and not sdate and not ym and not summ and 'date_unparsed' not in fl: fl.append('date_unparsed')
            amt = to_int(amt_s, mult, fl, 'amount')
            if amt is not None and abs(amt) > 1e12: fl.append('amount_gt_1e12')
            elif amt is not None and abs(amt) >= 1e11: fl.append('amount_review_ge_1e11')   # 1000억원 이상: 단위 오기 의심 검토 표식(뷰 제외)
            if not summ and amt is None: fl.append('no_amount')
            rm = re.search(r'[가-힣]\s*[\*○ㅇ●]{1,3}$|^[가-힣][\*○ㅇ●]{1,3}|^[가-힣][OＯXx0]{2}$', rec)
            if rm: fl.append('recipient_masked')
            rows_out.append({'table_idx': ti, 'table_row': k, 'row_no': no or None, 'event_date': sdate, 'yr': int(sdate[:4]) if sdate else (int(ym.group(1)) if ym else (year_in(title) or file_year)),
                             'recipient': rec or None, 'relation': flat(get(cells, idx.get('relation'))) or None, 'amount_won': amt,
                             'object': flat(get(cells, idx.get('object'))) or None, 'reason': flat(get(cells, idx.get('reason'))) or None,
                             'unit_name': uname, 'unit_mult': mult, 'is_summary': summ, 'parse_flags': fl})
        tinfo.append({'table_idx': ti, 'labels': [flat(x) for x in labels], 'unit': uname, 'n_rows': len(rows_out) - nb})
    seen_sig = {}      # 같은 문서에 같은 표가 둘 이상(시트 복제)이면 첫 표만 집계(실측 C0076 21502 2025: 합계의 2배)
    for ti in sorted(set(r['table_idx'] for r in rows_out)):
        tr = [r for r in rows_out if r['table_idx'] == ti and not r['is_summary'] and r['amount_won']]
        if len(tr) < 4: continue
        sig = tuple(sorted((r['event_date'] or '', r['recipient'] or '', r['amount_won']) for r in tr))
        if sig in seen_sig:
            for r in rows_out:
                if r['table_idx'] == ti and not r['is_summary']: r['is_summary'] = True; r['parse_flags'].append('dup_table')
        else: seen_sig[sig] = ti
    # 단위 오판 방어: «천원» 으로 환산했는데 비요약 행 하나라도 1조원 초과 → 값이 이미 원 단위로 보고 ÷1000(실측: 한국산업은행·한국전력공사 등 5개 기관 296행,
    # 한전→한전공대 «41,280,000,000» = 412.8억원). 문서 단위로 적용하고 행마다 플래그를 남긴다.
    fixed = None
    if any(r['unit_mult'] == 1000 and not r['is_summary'] and (r['amount_won'] or 0) > 1e12 for r in rows_out):
        fixed = 'to_won'
        for r in rows_out:
            if r['unit_mult'] == 1000:
                r['unit_mult'] = 1; r['unit_name'] += '->원보정'; r['parse_flags'] = [f for f in r['parse_flags'] if f != 'amount_gt_1e12'] + ['unit_corrected_to_won']
                if r['amount_won'] is not None: r['amount_won'] //= 1000
                r['parse_flags'] = [f for f in r['parse_flags'] if f != 'amount_review_ge_1e11']
                if abs(r['amount_won'] or 0) > 1e12: r['parse_flags'].append('amount_gt_1e12')
                elif abs(r['amount_won'] or 0) >= 1e11: r['parse_flags'].append('amount_review_ge_1e11')
    y = collections.Counter(r['yr'] for r in rows_out if r['yr'] and not r['is_summary'])
    return rows_out, {'parse_status': 'ok' if rows_out else ('no_table' if not ntab else 'no_rows'), 'tables': tinfo, 'unit_fix': fixed,
                      'target_year': y.most_common(1)[0][0] if y else file_year}

def roles_amount_split(labels, nxt, kind):
    m = lst_roles([a + b for a, b in zip(labels, nxt + [''] * len(labels))], kind)
    return 'amount' in m and 'amount' not in lst_roles(labels, kind)

# ---------------------------------------------------------------- 문서 단위
def sum_check(rows, by_year=True):
    """상세합 vs 문서 «총계행»(연도별로: 월 없는 합계행 중 최대값) 단독 비교. 소계 합과는 비교하지 않는다.
    ok(±2%) · unit(×1000 보정 시 ±2%) · double(상세합이 총계행의 1.9배 이상 = 이중집계 의심) · diff(그 밖의 불일치, 1.8배 이상 포함) · none(총계행 없음).
    분류별 합계행들의 합(총계행이 따로 없는 «분류별 합계» 표)이 상세합과 맞으면 ok. 연도 단위로 판정하고 문서 상태는 최악값(double>diff>unit>ok)."""
    def judge(tot, decl):
        if not decl or not tot: return None
        r = tot / decl
        if 0.98 <= r <= 1.02: return 'ok'
        if 980 <= r <= 1020 or 0.00098 <= r <= 0.00102: return 'unit'
        return 'double' if r >= 1.9 else 'diff'
    groups = collections.defaultdict(list)
    for r in rows: groups[r.get('yr') if by_year else 0].append(r)
    sts = []; first = (None, None)
    for yy, rs in groups.items():
        decl_all = [r['amount_won'] for r in rs if r['is_summary'] and 'total_row' in r['parse_flags'] and r.get('amount_won') and not r.get('month')]
        if not decl_all: continue
        dmax = max(decl_all)
        tot = sum(r['amount_won'] or 0 for r in rs if not r['is_summary'])
        alt = sum(r['amount_won'] or 0 for r in rs if any(f.startswith('granularity_dup') for f in r['parse_flags']))
        rest = sum(decl_all) - dmax
        dsum = sum(decl_all) if (decl_all.count(dmax) == 1 and abs(rest - dmax) > 0.02 * dmax) else None
        if 'ok' in (judge(tot, dmax), judge(alt, dmax)) or (dsum and len(decl_all) >= 2 and 'ok' in (judge(tot, dsum), judge(alt, dsum))): st = 'ok'
        else: st = judge(tot, dmax) or 'diff'
        if st == 'ok' and judge(tot, dmax) != 'ok' and not (0.6 <= tot / dmax < 1.8): st = 'diff'   # 분류합·버린 표 합으로 ok 가 났어도 직접 합이 총계행과 크게 다르면 total_diff     # N9: 분류합·버린 표 합으로 ok 가 났어도 상세합이 총계행의 1.8배 이상이면 total_diff(플래그)
        if first == (None, None): first = (dmax, tot)
        sts.append(st)
    if not sts: return 'none', (None, None)
    st = 'double' if 'double' in sts else 'diff' if 'diff' in sts else 'unit' if 'unit' in sts else 'ok'
    return st, first

def stem_of(fname):
    s = os.path.splitext(fname)[0]
    s = unicodedata.normalize('NFKC', s)
    s = re.sub(r'20\d\d|\d+\s*(년도|년|월|분기|차|회차|회|학년도)|\d+', '', s)
    return re.sub(r'[\s_\-()\[\]\'".·]', '', s)

def parse_file(code, path, docmap=None):
    rel = path[len(MD_ROOT):]
    parts = rel.split('/')
    inst_code, inst_name = inst_of(parts[0])
    rd = parts[2] if len(parts) >= 4 else ''
    meta, sections = read_md(path)
    dm = (docmap or {}).get(rel, {})
    fname = os.path.basename(path)
    disc = None
    rdir = os.path.dirname(path)
    while rdir.startswith(MD_ROOT) and rdir.count('/') >= (MD_ROOT.count('/') + 2):
        mf = rdir + '/manifest.json'
        if os.path.exists(mf):
            try: disc = (json.load(open(mf, encoding='utf-8')).get('report') or {}).get('disclosure_no')
            except Exception: disc = None
            break
        rdir = os.path.dirname(rdir)
    base = {'disclosure_no': disc, 'inst_code': inst_code, 'inst_name': inst_name, 'source_md_path': rel, 'source_file': meta.get('original_file'),
            'round_dir': rd, 'round_label': dm.get('period_label') or rd.split('__')[0], 'submitted_at': dm.get('submitted_at') or None,
            'doc_id': dm.get('doc_id'), 'file_stem': os.path.splitext(fname)[0]}
    if code == '20701': rows, dx = parse_20701(path, meta, sections, base)
    elif code == '21301': rows, dx = parse_21301(path, meta, sections, base)
    elif code == '43009': rows, dx = parse_43009(path, meta, sections, base)
    else: rows, dx = parse_list(code, path, meta, sections, base)
    ctr = collections.Counter()           # table_row = 표 안 순번(교차표는 한 원본 행이 여러 행이 되므로 새로 매긴다 → (doc, table, row) 유일)
    for r in rows:
        r['table_row'] = ctr[r['table_idx']]; ctr[r['table_idx']] += 1
    ty = dx.get('target_year')
    stem = stem_of(meta.get('original_file') or fname)
    gk = '%s|%s|%s' % (inst_code, code, ty) if code in ('43009', '21301') else '%s|%s|%s|%s' % (inst_code, code, ty, stem)
    docrec = dict(base); docrec.update(dx); docrec.update({'code': code, 'n_rows': len(rows), 'group_key': gk, 'parser_ver': B2_VER[code], 'stem': stem})
    docrec['n_rows_core'] = sum(1 for r in rows if not r.get('is_summary'))
    if code in ('20701', '21502', '32001'):
        sc, info = sum_check(rows, by_year=(code == '20701'))
        docrec['sum_check'] = sc; docrec['sum_mismatch'] = (sc == 'double'); docrec['tot_ok'] = None if sc == 'none' else (sc in ('ok', 'unit'))
        docrec['tot_decl'], docrec['tot_sum'] = info
    docrec['year_rows'] = dict(collections.Counter(str(r.get('yr') or ty) for r in rows if not r.get('is_summary')))
    docrec['rows_sig'] = hashlib.md5(json.dumps(sorted(json.dumps([r.get(k) for k in SIGKEY[code]], ensure_ascii=False) for r in rows if not r.get('is_summary')), ensure_ascii=False).encode()).hexdigest()
    return rows, docrec

def iter_files(code, insts=None):
    for folder in sorted(x for x in os.listdir(MD_ROOT) if os.path.isdir(MD_ROOT + x)):
        if insts and not any(i in folder for i in insts): continue
        for a in sorted(os.listdir(MD_ROOT + folder)):
            if a.split('_')[0] != code: continue
            for root, dirs, files in os.walk(MD_ROOT + folder + '/' + a):
                dirs.sort()
                for f in sorted(files):
                    if f.endswith('.md') and f != 'content.md': yield root + '/' + f

def load_docmap(path):
    m = {}
    if path and os.path.exists(path):
        rd = csv.reader(open(path, encoding='utf-8')); next(rd)
        for r in rd:   # doc_id,rel_path,period_label,submitted_at,body_md5
            m[r[1]] = {'doc_id': r[0], 'period_label': r[2], 'submitted_at': r[3], 'body_md5': r[4]}
    return m

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('code', choices=CODES); ap.add_argument('--out', required=True); ap.add_argument('--docs-out')
    ap.add_argument('--docs-csv'); ap.add_argument('--inst', nargs='*'); ap.add_argument('--files', nargs='*'); ap.add_argument('--limit', type=int)
    a = ap.parse_args()
    dm = load_docmap(a.docs_csv)
    files = a.files or iter_files(a.code, a.inst)
    fo = open(a.out, 'w'); fd = open(a.docs_out, 'w') if a.docs_out else None
    n = 0
    for p in files:
        try: rows, doc = parse_file(a.code, p, dm)
        except Exception as e:
            doc = {'source_md_path': p[len(MD_ROOT):], 'code': a.code, 'parse_status': 'error', 'error': repr(e)[:300], 'n_rows': 0}; rows = []
        for i, r in enumerate(rows):
            r['source_md_path'] = doc['source_md_path']; r['code'] = a.code
            fo.write(json.dumps(r, ensure_ascii=False) + '\n')
        if fd: fd.write(json.dumps(doc, ensure_ascii=False) + '\n')
        n += 1
        if a.limit and n >= a.limit: break
    print('files', n)
