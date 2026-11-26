#!/usr/bin/env python3
"""70301(수의계약 현황) 변환 md → 행 단위 JSONL. 오프라인·읽기 전용.

사용:
  python3 contract_parser.py --out ./out/rows.jsonl --docs-out ./out/docs.jsonl \
      [--docs-csv ./out/docs70301.csv] [--inst 창업진흥원 ...] [--limit N] [--files a.md b.md]
원칙: 행을 버리지 않는다(빈 행 제외). 못 맞추면 parse_flags 에 사유.
머리글 변이가 커서(실측 수백 종) 열 이름 → 역할(role) 매핑 방식. 가정은 parse_flags 로 남긴다.
"""
import os, re, sys, json, argparse, csv, unicodedata, datetime

MD_ROOT = '<MD_ROOT>/'

# ---------- 셀·표 분해 ----------
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
    sections = []  # (heading, [rows])
    head = ''; cur = None
    for line in txt.split('\n'):
        if line.startswith('#'):
            head = line.lstrip('#').strip(); cur = None; continue
        if line.startswith('|'):
            cells = split_row(line)
            if is_sep(cells): continue
            if cur is None:
                cur = []; sections.append((head, cur))
            cur.append(cells)
        else:
            if line.strip(): cur = None  # 본문 줄 → 표 종료
            elif cur is not None: cur = None
    return meta, sections

# ---------- 열 역할 ----------
def clean(s):
    s = unicodedata.normalize('NFKC', s)
    s = re.sub(r'[①-⑳]', '', s)
    return re.sub(r'\s+', '', s)

def role_of(label):
    t = clean(label)
    if not t: return None
    if '예정가격' in t or '예정가' in t: return 'est_price'
    if t.startswith('비고'): return 'remark'
    if '근거' in t or '사유' in t: return 'reason'
    if t.startswith('계약내용') or t == '내용': return 'content'
    if re.search(r'계약명|계약건명|건명|용역명|사업명|공사명|계약품명|품명|품목명|과제|요청명', t): return 'name'
    if '변경' in t:
        if '금액' in t: return 'final_amount'
        if '기간' in t: return 'change_period'
        if '일' in t: return 'change_date'
    if '최종' in t and '금액' in t: return 'final_amount'
    if '최초' in t and '금액' in t: return 'first_amount'
    if re.search(r'설계금액|추정금액', t) or (re.search(r'공급가|부가세|예산', t) and '계약' not in t): return 'other'
    if '금액' in t or re.fullmatch(r'계약액(\(.*\))?', t): return 'amount'
    if re.search(r'시작|개시', t): return 'period_start'
    if re.search(r'종료|만료|완료', t): return 'period_end'
    if '최초' in t and '기간' in t: return 'period'
    if '기간' in t: return 'period'
    if '최초' in t and '일' in t: return 'first_date'
    if re.search(r'계약일|체결일|계약일자|계약체결|일자', t): return 'first_date'
    if re.search(r'상대|대상자|업체|상호|계약처|거래처|수의계약자|법인명|기업명|계약기관|계약자', t):
        if '대표' in t:
            if '상호' in t or '업체명' in t:
                return 'cp_rep'  # 계약상대자(대표성명,상호) 형: 한 칸에 둘이 섞일 수 있음
            return 'rep'         # 계약업체 대표자 / 계약상대자(대표성명)
        return 'cp'
    if re.search(r'대표|성명', t): return 'rep'
    if re.fullmatch(r'(년도|연도|연\s*도|계약연도|계약년도)', t): return 'year'
    if re.fullmatch(r'(번호|순번|연번|no\.?|no|순서|일련번호|구분|순)', t.lower()): return 'no'
    if re.fullmatch(r'\d분기|[1-4]분기', t): return 'no'
    return 'other'

DATE_RE = [
    re.compile(r'(?<!\d)(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})'),
    re.compile(r'(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)'),
    re.compile(r'(?<!\d)(\d{2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})(?!\d)'),
]
def find_dates(s):
    out = []
    for i, rx in enumerate(DATE_RE):
        for m in rx.finditer(s):
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if i == 2: y += 2000
            if 1990 <= y <= 2100 and 1 <= mo <= 12 and 1 <= d <= 31:
                out.append((m.start(), '%04d-%02d-%02d' % (y, mo, d)))
        if out: break
    return [d for _, d in sorted(out)]

def to_date(s, flags, tag):
    s = (s or '').strip()
    if not s or s in ('-', '–', '해당없음', '없음'): return None
    ds = find_dates(s)
    if ds: return ds[0]
    if re.fullmatch(r'\d{5}(\.0)?', s):
        n = int(float(s))
        if 20000 < n < 80000:
            flags.append('date_serial'); return (datetime.date(1899, 12, 30) + datetime.timedelta(days=n)).isoformat()
    flags.append('date_unparsed:' + tag)
    return None

def to_int(s, mult, flags, tag):
    s0 = (s or '').strip()
    _ls = [l for l in s0.split('\n') if l.strip()]
    if len(_ls) > 1 and re.search(r'\d', _ls[0]): s0 = _ls[0].strip()   # v4 R5
    if not s0 or s0 in ('-', '–', '—', '해당없음', '없음'): return None
    t = unicodedata.normalize('NFKC', s0)
    neg = bool(re.match(r'^\(\s*[\d,.]+\s*\)$', t)) or t.startswith('-') or t.startswith('△') or t.startswith('▲')
    t = re.sub(r'[,\s원₩\\]|VAT포함|부가세포함|\(.*?\)', '', t).lstrip('-△▲')
    try:
        v = float(t)
    except ValueError:
        flags.append('amount_unparsed:' + tag); return None
    v = round(v * mult)
    return -v if neg else v

# ---------- 표 분석 ----------
UNIT_RE = re.compile(r'단위\s*[:：]?\s*([^)\s]*?)(천원|백만원|만원|억원|원)')
def detect_unit(texts):
    for t in texts:
        m = UNIT_RE.search(unicodedata.normalize('NFKC', t))
        if m: return {'원': 1, '천원': 1000, '만원': 10000, '백만원': 1000000, '억원': 100000000}[m.group(2)], m.group(2)
        m = re.search(r'\((천원|백만원|만원|억원)\)', t) or re.search(r'\([^)]*,\s*(천원|백만원|만원|억원)\)', t)   # v4 R2: «(건, 천원)»
        if m: return {'천원': 1000, '백만원': 1000000, '만원': 10000, '억원': 100000000}[m.group(1)], m.group(1)
    return 1, None

def looks_data(cells):
    return any(re.search(r'\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{5,}', c) for c in cells)

def find_header(rows):
    for i, r in enumerate(rows[:20]):
        roles = [role_of(c) for c in r]
        rs = set(x for x in roles if x and x != 'other')
        if 'name' in rs and rs & {'amount', 'first_amount', 'final_amount', 'cp', 'cp_rep'} and not looks_data(r):
            return i
        # 계약명 열 머리글이 없거나 깨진 표(암센터 '\\', 기술보증기금 '계약종류'): 금액+상대자+일자/기간이 있으면 머리글로 인정
        if rs & {'amount', 'first_amount'} and rs & {'cp', 'cp_rep'} and rs & {'first_date', 'period', 'period_start'} and not looks_data(r):
            return i
    return None

TOT_NAME = re.compile(r'(총\s*금\s*액|총\s*건\s*수|(?<!통)합\s*계|소\s*계|총\s*계|누\s*계|ⓐ\s*[+＋]\s*ⓑ|(?:500만원|5백만원|오백만원)\s*초과.{0,10}\d[\d,]*\s*건)')
TYPE_VAL = re.compile(r'^(물품|용역|공사|연구|기타|구매|제조|임대차|서비스|일반용역|연구용역|시설공사|전문공사|설계|감리|콘텐츠|물품구매|물품제조|물품계약|용역계약|공사계약|임차)')
METHOD_VAL = re.compile(r'수의|입찰|경쟁|견적|나라장터|조달|다수공급자|제한|협상')
TYPE_LAB = re.compile(r'(종류|구분|방법|방식|유형|분류)')
PERSON = re.compile(r'^[가-힣]{2,4}$')
CORP = re.compile(r'㈜|\(주\)|주식회사|\(유\)|\(사\)|\(재\)|법인|협회|공사|센터|대학|연구|재단|조합|회사|은행|서비스|산업|기술|시스템|건설|컨설팅')

def build_columns(rows, hi):
    top = rows[hi]
    sub = None
    if hi + 1 < len(rows):
        nx = rows[hi + 1]
        if not looks_data(nx) and sum(1 for c in nx if role_of(c) not in (None, 'other')) >= 2 \
           and not re.fullmatch(r'\d+', nx[0].strip() or 'x') and not (len(nx) > 1 and role_of(nx[0]) == 'no' and False):
            # 첫 칸이 일련번호 숫자이면 데이터 → 위 looks_data/숫자 검사로 제외
            sub = nx
    n = max(len(top), len(sub) if sub else 0)
    top = top + [''] * (n - len(top))
    sub = (sub + [''] * (n - len(sub))) if sub else None
    labels = []
    last_top = ''
    for j in range(n):
        t = top[j]; s = sub[j] if sub else ''
        if t: last_top = t
        if sub and s:
            lab = s if (role_of(s) not in (None, 'other')) else (t + ' ' + s).strip()
            if role_of(s) in ('cp', 'rep') and role_of(last_top) == 'cp_rep' and False: pass
            if t and role_of(t) not in (None, 'other') and role_of(s) not in (None, 'other') and role_of(t) != role_of(s):
                lab = s
        else:
            lab = t
        labels.append(lab)
    return labels, (hi + 2 if sub else hi + 1), top, sub

def assign_roles(labels, flags):
    roles = []
    prev = None
    for j, lab in enumerate(labels):
        r = role_of(lab)
        if r is None:  # 빈 머리글: 병합 셀 이어짐 추정
            if prev in ('period', 'period_start', 'change_period'): r = 'period_cont'
            elif prev in ('cp', 'cp_rep'): r = 'cp_follow'
            elif prev in ('rep',): r = None
            else: r = None
        roles.append(r)
        if r: prev = r
    return roles

def row_to_dict(cells, roles):
    d = {}
    for j, r in enumerate(roles):
        if r is None or j >= len(cells): continue
        d.setdefault(r, []).append((j, cells[j]))
    return d

def first(d, key):
    v = d.get(key)
    return v[0][1] if v else ''

def norm_cp(s):
    t = unicodedata.normalize('NFKC', s)
    t = re.sub(r'\(주\)|주식회사|㈜', '', t)
    t = re.sub(r'\s+', '', t)
    return t


def is_person(s):
    s = s.strip()
    if not s or CORP.search(s): return False
    return bool(re.fullmatch(r'[가-힣*○ㅇOo●]{2,5}', s) and re.search(r'[*○●]|^[가-힣]{2,4}$', s)) \
        or bool(re.fullmatch(r'[A-Z][A-Z .\-]{2,30}|[A-Z][a-z]+(\.[A-Z]\.?)?[A-Z a-z.\-]{0,20}', s) and s.upper() == s)

def split_cp_rep(cell, order_known=False):
    """'대표성명,상호' 가 한 칸에 든 경우 분리. returns (cp, rep, flag)"""
    parts = [p.strip() for p in re.split(r'[,、]', cell) if p.strip()]
    if len(parts) < 2: return cell, None, None
    persons = [p for p in parts if is_person(p)]
    corps = [p for p in parts if not is_person(p)]
    if len(corps) == 1 and persons: return corps[0], ', '.join(persons), 'cp_rep_split'
    if len(corps) >= 2 and not persons: return cell, None, None      # 진짜 복수 업체 → cp_multi 플래그로
    if not corps:
        if order_known and len(parts) == 2: return parts[1], parts[0], 'cp_rep_split_by_order'   # 머리글이 «대표성명,상호» 순서를 밝힌 표
        return cell, None, 'cp_all_person_like'
    return cell, None, None

def decide_cp_columns(table_rows, roles, labels):
    """cp 와 대표자 열이 헷갈리는 표(cp_rep/cp_follow/blank)에서 내용으로 판정."""
    idx = [j for j, r in enumerate(roles) if r in ('cp', 'cp_rep', 'cp_follow', 'rep')]
    if len(idx) < 2: return roles, []
    notes = []
    sc = {}
    for j in idx:
        vals = [r[j].strip() for r in table_rows if j < len(r) and r[j].strip()]
        if not vals: sc[j] = 0; continue
        sc[j] = sum(1 for v in vals if PERSON.match(v) and not CORP.search(v)) / len(vals)
    roles = list(roles)
    cands = [j for j in idx if roles[j] in ('cp', 'cp_rep', 'cp_follow')]
    # 사람 이름 비율이 가장 높은 열을 rep, 가장 낮은 열을 cp
    if len(idx) == 2 and any(roles[j] in ('cp_rep', 'cp_follow') for j in idx):
        a, b = idx
        if sc[a] > sc[b]: roles[a], roles[b] = 'rep', 'cp'; notes.append('cp_rep_swapped_by_content')
        else: roles[a], roles[b] = 'cp', 'rep'; notes.append('cp_rep_by_content')
    return roles, notes

def parse_table(rows, heading, ctx):
    """returns (status, list_of_row_dicts, table_info)"""
    info = {'heading': heading, 'n_raw_rows': len(rows)}
    hi = find_header(rows)
    if hi is None:
        info['status'] = 'no_header'; return [], info
    labels, start, top, sub = build_columns(rows, hi)
    pre = [' '.join(r) for r in rows[:hi]] + [heading] + labels
    mult, unit_name = detect_unit(pre)
    if unit_name is None:   # v4 R2: 본문 합계·소액 줄(번호 아닌 첫 칸)의 단위 표기
        ft = [' '.join(c for c in r[:3] if c) for r in rows[hi + 1:] if r and not re.fullmatch(r'\d+', (r[0] or '').strip() or 'x')]
        mult, unit_name = detect_unit([t for t in ft if len(t) < 60])
    flags_t = ['housing_lease_sheet'] if re.search(r'사택', heading or '') else []
    roles = assign_roles(labels, flags_t)
    if unit_name == '원': flags_t.append('unit_declared_won')   # v2 F5b
    cl = [clean(x) for x in labels]
    if 'housing_lease_sheet' not in flags_t and any(x.startswith('용도') for x in cl) and any('종류' in x for x in cl):
        flags_t.append('housing_lease_sheet')   # 사택(임차) 시트: 머리글에 «용도/종류» 열
    if 'name' not in roles:   # 계약명 열 없음: 머리글이 비었거나 기호뿐인 첫 열을 계약명으로, 없으면 계약종류/구분 열 사용
        for j, lab in enumerate(labels):
            if roles[j] in (None, 'other') and (not clean(lab) or not re.search(r'[가-힣A-Za-z]', lab)):
                roles[j] = 'name'; flags_t.append('name_col_from_blank_header'); break
        else:
            for j, lab in enumerate(labels):
                if roles[j] == 'other' and '종류' in clean(lab): roles[j] = 'name'; flags_t.append('name_col_from_kind'); break
            else: flags_t.append('no_name_col')
    if 'cp' not in roles and 'cp_rep' not in roles:
        for j, lab in enumerate(labels):   # 상대자 열이 '(대표자…)' 로만 읽힌 표: 그 열을 cp_rep 로
            if roles[j] == 'rep' and re.search(r'상대자|대상자', clean(lab)):
                roles[j] = 'cp_rep'; flags_t.append('cp_col_from_rep_label'); break
    body = rows[start:]
    roles, notes = decide_cp_columns(body, roles, labels)
    flags_t += notes
    if any('통화' in clean(l) for l in labels):   # v2 F3
        ai = [j for j, r in enumerate(roles) if r == 'amount']
        won = [j for j in ai if re.search(r'원\)\s*$|환산', clean(labels[j]))]   # v4 R1
        if len(ai) >= 2 and won:
            roles = [('amount' if j == won[0] else ('dup_amount' if r == 'amount' else r)) for j, r in enumerate(roles)]
            flags_t.append('amount_col_won_preferred_v2')
    # 같은 role 이 중복된 열(병합 셀 반복): 첫 열 우선, 나머지는 raw 에만
    seen = set(); roles2 = []
    for r in roles:
        if r in ('period', 'period_start', 'period_end', 'period_cont', 'change_period', 'other', None, 'cp_follow'):
            roles2.append(r); continue
        if r in seen: roles2.append('dup_' + r)
        else: roles2.append(r); seen.add(r)
    roles = roles2
    if 'amount' in seen and 'first_amount' not in seen and 'final_amount' not in seen: pass
    info.update({'status': 'ok', 'header_row': hi, 'subheader': bool(sub), 'labels': labels, 'roles': roles,
                 'unit': unit_name or 'won_assumed', 'mult': mult, 'flags': flags_t})
    out = []
    cur_hdr_cells = None
    prev_key = None
    for k, cells in enumerate(body):
        cells = list(cells) + [''] * (len(roles) - len(cells))
        if not any(c.strip() for c in cells): continue
        flags = list(flags_t)
        # 중간 머리글 반복 → 건너뜀(기록)
        rl = [role_of(c) for c in cells]
        if 'name' in rl and not looks_data(cells):
            continue
        d = row_to_dict(cells, roles)
        name = first(d, 'name')
        # 합계·소계 행
        joined = ''.join(cells[:3])
        is_total = bool(re.match(r'^\s*(합\s*계|소\s*계|총\s*계|계)\s*$', cells[0].strip())) or \
                   bool(re.match(r'^\s*(합\s*계|소\s*계|총\s*계)\s*$', name.strip()))
        name_tot = bool(TOT_NAME.search(name or '')) and len((name or '').strip()) <= 45 and not (first(d, 'cp') or '').strip()   # v2 F1
        if name_tot and not is_total: flags.append('total_row'); flags.append('total_by_name_v2')
        if is_total: flags.append('total_row')
        c0 = cells[0].strip()
        agg_n = None
        am = re.search(r'(이하|미만).{0,12}?(\d[\d,]*)\s*건|(\d[\d,]*)\s*건.{0,6}(이하|미만)', ' '.join(cells[:4]))
        if am and re.search(r'만원|백만원|천원|이하|미만', ' '.join(cells[:4])):
            agg_n = int((am.group(2) or am.group(3)).replace(',', ''))
        if agg_n is not None and any(re.search(r'\d', c) for _, c in d.get('amount', []) + d.get('first_amount', []) + d.get('final_amount', [])) and not re.match(r'(총\s*건수|총\s*금액)', c0):
            flags.append('aggregated_row')   # «500만원 이하 N건» 한 줄 합산: 계약 1건이 아니라 N건의 합. 업체별 집계 제외
        elif re.match(r'(총\s*건수|총\s*금액|합\s*계|소\s*계|총\s*계|건수|금액)', c0) or (not name.strip() and not re.fullmatch(r'\d+', c0)) \
           or re.search(r'(만원|원)\s*(이하|미만|이상).*\d+\s*건', c0):
            flags.append('summary_row'); flags = [f for f in flags if f not in ('no_amount',)]
            nums = [x for x in cells[1:] if re.search(r'\d', x)]
            m1 = re.match(r'총\s*건수', c0); m2 = re.match(r'총\s*금액', c0)
            if (m1 or m2) and nums:
                info['footer_count' if m1 else 'footer_amount'] = to_int(nums[0], mult if m2 else 1, [], 'f')
        # 기간
        pcells = [c for (_, c) in d.get('period', [])] + [c for (_, c) in d.get('period_start', [])] + \
                 [c for (_, c) in d.get('period_end', [])] + [c for (_, c) in d.get('period_cont', [])]
        pj = ' '.join(p for p in pcells if p)
        pds = find_dates(pj)
        ps = pe = None
        if len(pds) >= 2: ps, pe = pds[0], pds[1]
        elif len(pds) == 1:
            pl = ' '.join(clean(labels[j]) for k in ('period', 'period_start', 'period_end', 'period_cont') for (j, _) in d.get(k, []))   # v2: 단일 날짜는 머리글 의미로 시작/종료 판정
            if re.search(r'종료|만료|완료|말일|납기|까지|To', pl) and not re.search(r'시작|개시|착수|착공|초일|부터|From', pl):
                pe = pds[0]; flags.append('period_single_end_v2')
            else: ps = pds[0]
        period = None
        if pj:
            period = (ps + '~' + pe) if ps and pe else re.sub(r'\s+', ' ', pj).strip()
            if not ps and not pe: flags.append('period_unparsed')
        cperiod = ' '.join(c for (_, c) in d.get('change_period', []) if c) or None
        amt = to_int(first(d, 'amount'), mult, flags, 'amount')
        if amt is None and 'amount_col_won_preferred_v2' in flags_t and d.get('dup_amount'):   # v4 R1b: 환산 칸이 빈 KRW 행
            cur = next((cells[j].strip().upper() for j in range(min(len(labels), len(cells))) if '통화' in clean(labels[j])), '')
            if cur in ('KRW', 'WON', '원'): amt = to_int(first(d, 'dup_amount'), mult, flags, 'amount')
        fa = to_int(first(d, 'first_amount'), mult, flags, 'first')
        la = to_int(first(d, 'final_amount'), mult, flags, 'final')
        if fa is None and amt is not None: fa = amt  # 단일 금액 열 = 최초(공시 기준) 금액으로 취급
        cp = first(d, 'cp') or first(d, 'cp_rep')
        rep = first(d, 'rep')
        if not rep and first(d, 'cp_rep') and not first(d, 'cp'): flags.append('cp_rep_combined')
        if 'cp_follow' in roles and not rep:
            rep = first(d, 'cp_follow')
        if not cp and not rep and 'cp' not in seen and 'cp_rep' not in seen: flags.append('no_cp_column')
        if cp and 'rep' not in seen and re.search(r'[,、]', cp):
            cp, rep2, fl = split_cp_rep(cp, 'cp_rep' in seen)
            if fl: flags.append(fl)
            if rep2 and not rep: rep = rep2
        if re.search(r'[,、]|\s외\s*\d+|/', cp): flags.append('cp_multi_or_slash')
        if cp and re.search(r'\(.*[가-힣]{2,4}\)\s*$', cp) and 'cp_rep' in roles: flags.append('cp_maybe_with_rep')
        if 'summary_row' not in flags:
            if name and fa is None and la is None: flags.append('no_amount')
            if not name: flags.append('no_name')
        ctype = cmeth = None   # v2: 계약 종류·방법 (구분/종류/방법/방식/유형 열의 값을 내용으로 분류)
        for j, lab in enumerate(labels):
            if j >= len(cells) or roles[j] in ('amount', 'first_amount', 'final_amount', 'est_price', 'cp', 'cp_rep', 'rep', 'name', 'content', 'reason', 'remark', 'year', 'first_date', 'change_date') or not TYPE_LAB.search(clean(lab)): continue
            v = cells[j].strip()
            if not v or len(v) > 30: continue
            if ctype is None and TYPE_VAL.match(v): ctype = v
            elif cmeth is None and METHOD_VAL.search(v): cmeth = v
        item = next((cells[j].strip() for j, r in enumerate(roles) if r == 'dup_name' and j < len(cells) and re.search(r'품목|품명', clean(labels[j])) and cells[j].strip()), None)
        rn = first(d, 'no').strip()
        if 'summary_row' not in flags and 'aggregated_row' not in flags:
            key = (rn, name.strip(), fa, la, first(d, 'first_date'))
            if rn and key == prev_key: flags.append('joint_dup_row_no')   # 병합셀 전개: 같은 번호·계약명·금액이 공동수급자 수만큼 반복 → 합계에서 1건으로
            prev_key = key
        yr = None
        ycell = first(d, 'year')
        m = re.search(r'(20\d\d|19\d\d)', ycell)
        if m: yr = int(m.group(1))
        fd = to_date(first(d, 'first_date'), flags, 'first') if first(d, 'first_date') else None
        cd = to_date(first(d, 'change_date'), flags, 'change') if first(d, 'change_date') else None
        if not fd and ps: pass
        reason = ' / '.join(c for (_, c) in d.get('reason', []) if c) or None
        est = first(d, 'est_price')
        est_v = to_int(est, mult, flags, 'est') if est else None
        out.append({
            'table_row': k, 'row_no': first(d, 'no') or None, 'contract_year': yr,
            'contract_name': name or None, 'first_date': fd, 'change_date': cd,
            'first_period': period, 'period_start': ps, 'period_end': pe, 'change_period': cperiod,
            'first_amount': fa, 'final_amount': la, 'amount_won': la if la is not None else fa, 'rep_name': rep or None,
            'counterparty_raw': cp or None, 'counterparty_norm': norm_cp(cp) if cp else None,
            'contract_type': ctype, 'contract_method': cmeth, 'item_name': item,
            'content': first(d, 'content') or None, 'reason': reason, 'est_price': est_v,
            'agg_count': agg_n if 'aggregated_row' in flags else None, 'unit_mult': mult, 'raw_cells': cells, 'parse_flags': flags,
        })
    if mult > 1:   # v2 F2
        nat = sorted((x['final_amount'] if x['final_amount'] is not None else x['first_amount']) // mult
                     for x in out if 'summary_row' not in x['parse_flags'] and 'total_row' not in x['parse_flags']
                     and (x['final_amount'] if x['final_amount'] is not None else x['first_amount']) and (x['final_amount'] if x['final_amount'] is not None else x['first_amount']) > 0)
        if len(nat) >= 5 and nat[len(nat) // 2] * mult > 1e9 and nat[len(nat) // 2] >= 100000:
            for x in out:
                for k in ('first_amount', 'final_amount', 'amount_won', 'est_price'):
                    if x[k] is not None: x[k] = x[k] // mult
                x['unit_mult'] = 1; x['parse_flags'].append('unit_label_mismatch_v2')
            info['mult'] = 1; info['unit'] = 'label_mismatch_won'
    if info['mult'] > 1:   # v4 R4: 표 내부 행별 혼재(천원 라벨 아래 일부 행이 원 단위)
        m0 = info['mult']
        ev = lambda x: x['final_amount'] if x['final_amount'] is not None else x['first_amount']
        nat4 = sorted(ev(x) // m0 for x in out if 'summary_row' not in x['parse_flags'] and 'total_row' not in x['parse_flags'] and ev(x) and ev(x) > 0)
        if len(nat4) >= 5:
            med4 = nat4[len(nat4) // 2]
            for x in out:
                v = ev(x)
                if v and 'summary_row' not in x['parse_flags'] and 'total_row' not in x['parse_flags'] and v // m0 > 300 * med4 and v // m0 >= 10000000 and x['unit_mult'] == m0:
                    for k in ('first_amount', 'final_amount', 'amount_won', 'est_price'):
                        if x[k] is not None: x[k] = x[k] // m0
                    x['unit_mult'] = 1; x['parse_flags'].append('unit_row_won_v4')
    info['n_rows'] = len(out)
    info['n_contract_rows'] = sum(1 for x in out if 'summary_row' not in x['parse_flags'] and 'total_row' not in x['parse_flags'])
    return out, info

YEAR_RE = re.compile(r'(20[12]\d)\s*년|(?<!\d)(20[12]\d)(?!\d)')

def inst_of(folder):
    m = re.match(r'^\[(.*?)\](.*)_(C\d+)$', folder)
    if m: return m.group(3), m.group(2), m.group(1)
    m = re.match(r'^(.*)_(C\d+)$', folder)
    return (m.group(2), m.group(1), '') if m else ('', folder, '')

def round_label_of(rd):
    return rd.split('__')[0]

def parse_file(path, docmap=None):
    rel = path[len(MD_ROOT):]
    folder = rel.split('/')[0]
    inst_code, inst_name, ministry = inst_of(folder)
    rd = rel.split('/')[2] if rel.count('/') >= 3 else ''
    meta, sections = read_md(path)
    dm = (docmap or {}).get(rel, {})
    fname = os.path.basename(path)
    fy = YEAR_RE.search(fname)
    file_year = int(fy.group(1) or fy.group(2)) if fy else None
    base = {'inst_code': inst_code, 'inst_name': inst_name, 'source_md_path': rel, 'source_file': meta.get('original_file'),
            'round_label': dm.get('period_label') or round_label_of(rd), 'round_dir': rd,
            'submitted_at': dm.get('submitted_at') or None, 'doc_id': dm.get('doc_id'), 'dup_group': dm.get('dup_group'), 'body_group': dm.get('body_group'), 'size_bucket': dm.get('size_bucket'), 'file_year': file_year}
    rows = []; tinfo = []
    for ti, (heading, trs) in enumerate(sections):
        r, info = parse_table(trs, heading, base)
        info['table_idx'] = ti
        tinfo.append(info)
        for x in r:
            rec = dict(base); rec['table_idx'] = ti; rec['sheet'] = heading
            rec.update(x); rows.append(rec)
    docrec = dict(base)
    docrec.update({'n_tables': len(sections), 'n_contract_tables': sum(1 for t in tinfo if t['status'] == 'ok'),
                   'n_rows': len(rows),
                   'tables': [{k: t.get(k) for k in ('table_idx', 'heading', 'status', 'labels', 'roles', 'unit', 'n_rows', 'n_contract_rows', 'n_raw_rows', 'header_row', 'subheader', 'footer_count', 'footer_amount', 'flags')} for t in tinfo]})
    return rows, docrec

def iter_files(insts=None):
    for folder in sorted(x for x in os.listdir(MD_ROOT) if os.path.isdir(MD_ROOT + x)):
        if insts and not any(i in folder for i in insts): continue
        for a in sorted(os.listdir(MD_ROOT + folder)):
            if not a.startswith('70301_'): continue
            for root, dirs, files in os.walk(MD_ROOT + folder + '/' + a):   # zip 해제 하위 폴더까지(실측: DB 문서 172건이 하위 폴더)
                dirs.sort()
                for f in sorted(files):
                    if f.endswith('.md') and f != 'content.md': yield root + '/' + f

def load_docmap(path):
    m = {}
    if path and os.path.exists(path):
        rd = csv.reader(open(path, encoding='utf-8')); next(rd)
        for r in rd:  # doc_id,inst,rel_path,period_label,submitted_at,dup_group,body_group,disclosure_no,doc_date,period_quarter,size_bucket,...
            m[r[2]] = {'doc_id': r[0], 'period_label': r[3], 'submitted_at': r[4], 'dup_group': r[5], 'body_group': r[6], 'size_bucket': r[10]}
    return m

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True); ap.add_argument('--docs-out')
    ap.add_argument('--docs-csv', default='./out/docs70301.csv')
    ap.add_argument('--inst', nargs='*'); ap.add_argument('--files', nargs='*'); ap.add_argument('--files-from'); ap.add_argument('--limit', type=int)
    a = ap.parse_args()
    dm = load_docmap(a.docs_csv)
    files = a.files or ([l.rstrip('\n') for l in open(a.files_from) if l.strip()] if a.files_from else iter_files(a.inst))
    fo = open(a.out, 'w'); fd = open(a.docs_out, 'w') if a.docs_out else None
    n = 0
    for p in files:
        try:
            rows, doc = parse_file(p, dm)
        except Exception as e:
            rel = p[len(MD_ROOT):]
            doc = {'source_md_path': rel, 'error': repr(e), 'n_rows': 0, 'n_tables': 0, 'n_contract_tables': 0}; rows = []
        for r in rows: fo.write(json.dumps(r, ensure_ascii=False) + '\n')
        if fd: fd.write(json.dumps(doc, ensure_ascii=False) + '\n')
        n += 1
        if a.limit and n >= a.limit: break
    print('files', n)
