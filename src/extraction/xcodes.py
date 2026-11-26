# -*- coding: utf-8 -*-
"""DextA: A·D 표 코드 확대용 값 추출 모듈(코드별 규칙). field_extractor.extract_doc 끝에서 호출된다.

  F = xcodes.apply(d, tbs, items, F)   # d['item_code'] 가 CODES 에 없으면 F 를 그대로 돌려준다(기존 10코드 동작 불변)

추출 대상 코드의 표는 이 모듈이 «머리글 서명 → 키 사전» 으로 직접 읽는다. 기존 추출기가 만든 kind in (cell,list,kv,headless,text,note)
레코드는 버리고(수정공시 correction 행·«해당사항 없음» group_na 행은 유지) 아래 레코드로 바꾼다.
키 규칙: field_key = '<코드>:<영문키>' · col_key = 연도(YYYY)/연도+결산·예산/월/분기, 행 라벨(사업명·직급 등)은 field_label.
단위: 금액은 표 머리 «(단위: …)» 의 금전 단위를 따르고 value_std 는 원 환산. 없으면 코드 기본값+unit_assumed.
빈 값(- · 해당없음 등)은 0 이 아니라 value_num NULL + na_token. 개인 성명(20905 성명)은 저장하지 않는다.
"""
import re
from mdparse import col_key, parse_num, find_unit, std_value, MONEY, RE_DATE, RE_Q

MONEY_WORDS = set(MONEY)
COUNT_WORDS = ('명', '대', '건', '개사', '회', '개', '곳')
TOTAL_LABELS = {'계', '합계', '총계', '소계', '총합계', '총사업비', '합 계'}


def nsp(s):
    return re.sub(r'[\s·]', '', s or '')


def year_of(label):
    m = re.match(r'^\(?\s*(\d{4}|\d{2})\s*년(?:도)?\s*\)?$', (label or '').strip())
    if not m:
        return None
    y = int(m.group(1))
    return y + 2000 if y < 100 else y


def pick_unit(unit_s, ukind, default=None, count_default=None):
    us = [u.strip() for u in re.split(r'[,，/·]', unit_s or '') if u.strip()]
    if ukind == 'money':
        for u in us:
            if u in MONEY_WORDS:
                return u, []
        return default, ['unit_assumed']
    if ukind == 'pct':
        return '%', []
    if ukind.startswith('fixed:'):
        return ukind[6:], []
    if ukind == 'count':
        for u in us:
            if u in COUNT_WORDS:
                return u, []
        return count_default, ['unit_assumed'] if count_default else []
    return None, []


def date_iso(v):
    m = RE_DATE.search(v or '')
    return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}' if m else None


# ---------------------------------------------------------------- 연도 행 표(행=연도, 열=지표)
# (머리글 정규식, 키, 단위종류[, 기본단위]) — 앞에서부터 처음 맞는 규칙
YEAR_ROWS = {
    '70322': dict(first=('구분',), title='중증장애인 생산품 구매실적', cols=[
        (r'^총구매액', 'total_purchase', 'money', '백만원'), (r'구매액', 'severe_disabled_purchase', 'money', '백만원'), (r'비율', 'severe_disabled_ratio', 'pct')]),
    '80332': dict(first=('구분',), title='중소기업 생산품 구매실적', cols=[
        (r'^총구매액', 'total_purchase', 'money', '백만원'), (r'구매액', 'sme_purchase', 'money', '백만원'), (r'^비율', 'sme_ratio', 'pct'), (r'달성', 'mandatory_ratio_met', 'text')]),
    '70312': dict(first=('구분',), title='혁신조달 구매실적', cols=[
        (r'^총구매액', 'total_purchase', 'money', '백만원'), (r'구매액', 'innovation_purchase', 'money', '백만원'), (r'비율', 'innovation_ratio', 'pct')]),
    '70413': dict(first=('구분',), title=None, cols=[
        (r'^총구매액', 'total_purchase', 'money', '백만원'), (r'구매이행계획', 'green_plan', 'money', '백만원'), (r'구매액', 'green_purchase', 'money', '백만원'),
        (r'^비율', 'green_ratio', 'pct'), (r'증감', 'green_diff', 'money', '백만원')]),
    '32211': dict(first=('연도',), title='법인세 납부내역', cols=[
        (r'과세표준', 'taxable_income', 'money', '천원'), (r'산출세액', 'tax_calculated', 'money', '천원'), (r'세액공제', 'tax_credit', 'money', '천원'),
        (r'가산세', 'penalty_tax', 'money', '천원'), (r'결정세액', 'tax_final', 'money', '천원')]),
}

# ---------------------------------------------------------------- 연도 열 표(행=지표 고정 어휘, 열=연도)
YEAR_COLS = {
    '80202': dict(title='장애인 고용현황', rows=[
        (r'^상시근로자', 'workers_total', 'count', '명'), (r'의무고용인원', 'disabled_required', 'count', '명'), (r'고용인원', 'disabled_employed', 'count', '명'),
        (r'고용률', 'disabled_rate', 'pct'), (r'이행여부', 'compliance', 'text')]),
    '80402': dict(title='AI 활용 현황', rows=[
        (r'AI인력', 'ai_staff', 'count', '명'), (r'AI전담조직', 'ai_org', 'text'), (r'AI예산', 'ai_budget', 'money', '천원'), (r'AI활용사례', 'ai_cases', 'fixed:건')]),
}

CODES = set(YEAR_ROWS) | set(YEAR_COLS) | {'31501', '70451', '31601', '32135', '20905'}


class _Ctx(dict):
    pass


def _rec(d, ti, ri, ln, kind, key, label, raw, title, flags, extra=None, cell=None):
    from field_extractor import rec
    return rec(d, ti, ri, ln, kind, key, label, raw, {'section': None, 'title': title}, flags, extra=extra, cell=cell)


def _val(d, ti, ri, ln, kind, key, label, raw, title, flags, unit_s=None, ukind='raw', udef=None, cdef=None,
         col=None, extra=None, cell=None):
    """값 1칸 레코드. col = (col_label, col_key, col_kind, year, basis, quarter)"""
    num, nf = parse_num(raw)
    ex = dict(extra or {})
    unit = None
    uf = []
    if ukind != 'text':
        unit, uf = pick_unit(unit_s, ukind, udef, cdef)
    if num is not None:
        vs, us = std_value(num, unit)
        ex.update(value_num=num, value_std=vs, unit=unit, unit_std=us)
    if col:
        ex.update(col_label=col[0], col_key=col[1], col_kind=col[2], col_year=col[3], col_basis=col[4], col_quarter=col[5])
    ex['row_labels'] = [label]
    return _rec(d, ti, ri, ln, kind, key, label, raw, title, list(flags) + nf + (uf if num is not None else []), ex, cell)


def _year_col(y):
    return (f'{y}년', str(y), 'year', y, None, None)


RE_CORR = re.compile(r'^(\d+\.\s*수정\s*(대상|사항)|수\s*정\s*공\s*시)')


def corr_ranges(items):
    """수정공시 블록(«1. 수정대상 공시서류…»가 든 연속 행 덩어리)의 줄 범위. 그 안의 중첩 표(수정 전·후 값)는 데이터가 아니다."""
    out, run = [], []
    for it in items + [('text', 0, '')]:
        if it[0] == 'row':
            run.append(it)
            continue
        if run and any(RE_CORR.match(x[2][0] if x[2] else '') for x in run):
            out.append((run[0][1], run[-1][1]))
        run = []
    return out


def in_corr(ln, rng):
    return any(a <= ln <= b for a, b in rng)


def _tables_scan(tbs, want, rng=()):
    """머리 있는 표만 순서대로 (ti, t, unit_ctx) — 머리만 있는 단위 표의 «(단위: …)» 를 다음 데이터 표에 넘긴다."""
    unit = None
    for ti, t in enumerate(tbs):
        h = t['header']
        if h is None or in_corr(t['start'], rng):
            continue
        u = next((find_unit(c) for c in h if find_unit(c)), None)
        if not t['rows'] and u:
            unit = u
            continue
        yield ti, t, (u or unit)
        if t['rows']:
            unit = None


def year_rows(code, d, tbs, rng=()):
    sp, F = YEAR_ROWS[code], []
    for ti, t, unit in _tables_scan(tbs, None, rng):
        h = t['header']
        if not h or h[0] not in sp['first'] or len(h) < 3 or not t['rows']:
            continue
        cm = []
        for c in h[1:]:
            cm.append(next((r for r in sp['cols'] if re.search(r[0], nsp(c))), None))
        if not any(cm):
            continue
        title = sp['title'] or ('녹색제품 구매이행계획' if any(c and c[1] == 'green_plan' for c in cm) else '녹색제품 구매실적')
        for ri, (ln, r, rn, ind) in enumerate(t['rows']):
            y = year_of(r[0]) if r else None
            if y is None or len(r) != len(h):
                if r and any(r):
                    F.append(_rec(d, ti, ri, ln, 'note', None, r[0], ' | '.join(r[1:]), title, ['row_skipped']))
                continue
            for j, c in enumerate(cm, 1):
                if c is None:
                    continue
                F.append(_val(d, ti, ri, ln, 'cell', f'{code}:{c[1]}', h[j], r[j], title, [], unit, c[2], c[3] if len(c) > 3 else None,
                              col=_year_col(y), cell=j))
    return F


def year_cols(code, d, tbs, rng=()):
    sp, F = YEAR_COLS[code], []
    for ti, t, unit in _tables_scan(tbs, None, rng):
        h = t['header']
        if not h or h[0] != '구분' or not t['rows']:
            continue
        cols = [col_key(c) for c in h[1:]]
        if not cols or any(k[1] != 'year' for k in cols):
            continue
        nv = len(cols)
        for ri, (ln, r, rn, ind) in enumerate(t['rows']):
            lab = r[0] if r else ''
            rule = next((x for x in sp['rows'] if re.search(x[0], nsp(lab))), None)
            if rule is None or len(r) not in (nv + 1, nv + 2):
                if lab.strip('-') and any(r[1:]):
                    F.append(_rec(d, ti, ri, ln, 'note', None, lab, ' | '.join(r[1:]), sp['title'], ['row_skipped']))
                continue
            vals = r[1:1 + nv]
            fl = ['trailing_unit_cell'] if len(r) == nv + 2 else []
            for j, v in enumerate(vals):
                k = cols[j]
                F.append(_val(d, ti, ri, ln, 'cell', f'{code}:{rule[1]}', lab, v, sp['title'], fl, unit, rule[2], rule[3] if len(rule) > 3 else None,
                              col=(h[1 + j], k[0], 'year', k[2], None, None), cell=j + 1))
    return F


def project_wide(d, tbs, rng=()):
    """31501 주요사업: 사업구분 | YYYY년 결산… | YYYY년 예산 | 비고"""
    F = []
    for ti, t, unit in _tables_scan(tbs, None, rng):
        h = t['header']
        if not h or h[0] != '사업구분' or not t['rows']:
            continue
        cols = [col_key(c) for c in h[1:]]
        pj = [j for j, k in enumerate(cols) if k[1] == 'year']
        if not pj:
            continue
        nc = len(h)
        for ri, (ln, r, rn, ind) in enumerate(t['rows']):
            lab = r[0] if r else ''
            if len(r) != nc or not lab or lab == '-':
                if r and any(x not in ('', '-') for x in r[1:]):
                    F.append(_rec(d, ti, ri, ln, 'note', None, lab, ' | '.join(r[1:]), '주요사업', ['row_skipped']))
                continue
            key = '31501:total' if nsp(lab) in TOTAL_LABELS else '31501:project_amount'
            for j in pj:
                k = cols[j]
                F.append(_val(d, ti, ri, ln, 'list', key, lab, r[1 + j], '주요사업', ['total_row'] if key.endswith('total') else [], unit, 'money', '백만원',
                              col=(h[1 + j], k[0], 'year', k[2], k[3], None), cell=j + 1))
    return F


def safety_deaths(d, tbs, rng=()):
    """70451 안전관리: 구분 | 3월 | 6월 | 9월 | 12월 | 계. 행은 rowspan 으로 라벨 칸 수가 달라 고정 어휘로 판정."""
    F = []
    for ti, t, unit in _tables_scan(tbs, None, rng):
        h = t['header']
        if not h or h[0] != '구분' or [nsp(c) for c in h[1:]] != ['3월', '6월', '9월', '12월', '계']:
            continue
        for ri, (ln, r, rn, ind) in enumerate(t['rows']):
            if len(r) < 6:
                continue
            vals, labs = r[-5:], [nsp(x) for x in r[:-5]]
            if labs and labs[-1] == '소계':
                key, lab = '70451:industrial_death.total', '산업재해 사고사망자수 소계'
            elif labs == ['직영']:
                key, lab = '70451:industrial_death.direct', '직영'
            elif labs == ['도급']:
                key, lab = '70451:industrial_death.contract', '도급'
            elif labs == ['건설발주']:
                key, lab = '70451:industrial_death.construction_ordered', '건설발주'
            elif labs and labs[-1].startswith('안전사고사망자수'):
                key, lab = '70451:safety_death', '안전사고 사망자수'
            else:
                F.append(_rec(d, ti, ri, ln, 'note', None, ' / '.join(r[:-5]), ' | '.join(vals), '사고사망자수', ['row_skipped']))
                continue
            for j, v in enumerate(vals):
                ck = ['3월', '6월', '9월', '12월', '계'][j]
                F.append(_val(d, ti, ri, ln, 'cell', key, lab, v, '사고사망자수', [], unit, 'count', '명',
                              col=(ck, 'M%02d' % int(ck[:-1]) if ck != '계' else 'TOTAL', 'month' if ck != '계' else 'total', None, None, None), cell=j + 1))
    return F


def invest_exec(d, items):
    """31601 투자집행: «1월…12월 계» 행 + 다음 값 행, «YYYY년…(5개)» 행 + 다음 값 행 (머리·구분선이 없는 표라 행 순서로 읽는다)"""
    F = []
    rng = corr_ranges(items)
    items = [it for it in items if not (it[0] == 'row' and in_corr(it[1], rng))]
    rows = [it for it in items if it[0] == 'row' and not it[3]]
    unit = None
    year = None
    for it in items:
        if it[0] == 'row':
            if not unit:
                unit = next((find_unit(c) for c in it[2] if find_unit(c)), None)
            if year is None:
                for c in it[2]:
                    m = RE_Q.search(c or '')
                    if m:
                        year = int(m.group(1)); break
    if year is None and d.get('base_date'):
        year = int(d['base_date'][:4])
    for i, it in enumerate(rows[:-1]):
        c = it[2]
        nxt = rows[i + 1][2]
        if len(c) == 13 and c[0] == '1월' and c[12] == '계' and len(nxt) == 13:
            for j in range(13):
                mm = c[j]
                ck = (f'{year}-{j + 1:02d}' if year else f'M{j + 1:02d}') if j < 12 else (str(year) if year else 'TOTAL')
                F.append(_val(d, 0, 0, it[1], 'cell', '31601:invest_exec_monthly', '투자집행 월별(누계는 계)', nxt[j], '공공기관 투자(예산)집행 현황', [], unit, 'money', '백만원',
                              col=(mm, ck, 'month' if j < 12 else 'ytd_total', year, None, None), cell=j))
        elif len(c) == 5 and all(year_of(x) for x in c) and len(nxt) == 5:
            for j in range(5):
                y = year_of(c[j])
                F.append(_val(d, 1, 0, it[1], 'cell', '31601:invest_exec_annual', '투자집행 과거 5년 총계', nxt[j], '공공기관 투자집행 현황 (과거 5년 총계)', [], unit, 'money', '백만원',
                              col=_year_col(y), cell=j))
    return F


BURDEN_KEYS = [(r'^주요내용', 'main_content'), (r'^추정소요예산', 'est_budget'), (r'^예상기간', 'est_period'), (r'^확정일', 'decided_date'), (r'^재원조달', 'funding')]


def burden(d, items):
    """32135 경영부담 비용추계: 제목 / 주요내용 / 추정 소요예산 / 예상기간 / 확정일 / 재원조달방법 카드(문서에 여러 건 가능 → row_idx=건 순번)"""
    F, n, title = [], -1, None
    rng = corr_ranges(items)
    for ii, it in enumerate(items):
        if it[0] == 'row' and in_corr(it[1], rng):
            continue
        if it[0] != 'row' or it[3]:
            continue
        c, cn = it[2], it[4]
        if not c:
            continue
        lab = nsp(c[0])
        if lab == '제목' and len(c) >= 2:
            n += 1
            title = c[1]
            F.append(_rec(d, 0, n, it[1], 'list', '32135:title', '제목', c[1], title, [], {'row_labels': ['제목']}))
            continue
        if n < 0:
            continue
        if len(c) < 2 and lab not in ('주요내용', '재원조달방법'):   # «기관 세부 작성기준» 줄글이 라벨처럼 시작하는 경우 제외
            continue
        for rx, key in BURDEN_KEYS:
            if re.search(rx, lab):
                break
        else:
            continue
        raw = (cn[1] if len(cn) > 1 else '').strip()
        if not raw and key in ('main_content', 'funding'):
            raw = trail(items, ii)
        ex = {'row_labels': [c[0]]}
        fl = []
        if key == 'est_budget':
            unit_s = c[2] if len(c) > 2 else None
            num, nf = parse_num(raw)
            u = (unit_s or '').split('/')[0].strip() or None
            if u not in MONEY_WORDS:
                u = None if num is None else u
                fl.append('unit_unknown')
            if num is not None:
                vs, us = std_value(num, u)
                ex.update(value_num=num, value_std=vs, unit=u, unit_std=us)
            if unit_s:
                ex['col_label'] = unit_s
            F.append(_rec(d, 0, n, it[1], 'list', '32135:est_budget', c[0], raw, title, nf + fl, ex))
        elif key == 'est_period':
            ds = RE_DATE.findall(raw)
            F.append(_rec(d, 0, n, it[1], 'list', '32135:est_period', c[0], raw, title, [], dict(ex, value_date=(f'{ds[0][0]}-{int(ds[0][1]):02d}-{int(ds[0][2]):02d}' if ds else None))))
        elif key == 'decided_date':
            F.append(_rec(d, 0, n, it[1], 'list', '32135:decided_date', c[0], raw, title, [], dict(ex, value_date=date_iso(raw))))
        else:
            F.append(_rec(d, 0, n, it[1], 'list', '32135:' + key, c[0], raw[:2000], title, [], ex))
    # 같은 해에 서로 다른 부담 사건을 따로 공시하므로(제목 목록이 다름) 교체 단위 = 연도 + 제목 목록 해시: 같은 내용의 재공시만 서로 교체
    ts = [r['value_raw'] for r in F if r['field_key'] == '32135:title']
    if ts:
        d['gp_override'] = f"{d.get('period_label_adj') or d.get('period_label') or d.get('round_dir')}#{_h6(*ts)}"
    return F


def trail(items, i):
    """값 칸이 «| 라벨 |» 뒤 줄바꿈으로 시작하면 파서가 행을 거기서 닫아 버린다 → 바로 뒤따르는 text 줄들을 값으로 모은다."""
    out = []
    for it in items[i + 1:]:
        if it[0] != 'text':
            break
        out.append(it[2].rstrip('| '))   # 마지막 줄 끝의 셀 닫는 '|' 제거
    return '\n'.join(x for x in out if x)


def _h6(*parts):
    import hashlib
    return hashlib.md5('|'.join(parts).encode('utf-8')).hexdigest()[:6]


def trips(d, items):
    """20905 임원 국외출장: 연도 / 임원 직급 / 성명(저장 안 함) / 출장 장소 / 기간 / 내용 카드. 연도 행이 새 출장의 시작."""
    F, n, name = [], -1, ''
    rng = corr_ranges(items)
    for ii, it in enumerate(items):
        if it[0] == 'row' and in_corr(it[1], rng):
            continue
        if it[0] != 'row' or it[3]:
            continue
        c, cn = it[2], it[4]
        if len(c) == 1 and nsp(c[0]) == '내용' and n >= 0:   # 값 칸이 줄바꿈으로 시작: 행이 «| 내용 |» 에서 닫힘
            tx = trail(items, ii)
            if tx:
                F.append(_rec(d, 0, n, it[1], 'list', '20905:purpose', '내용', tx[:2000], None, [], {'row_labels': ['내용']}))
            continue
        if len(c) < 2:
            continue
        lab = nsp(c[-2]) if len(c) >= 2 else ''
        raw, rawn = c[-1], cn[-1]
        if lab == '연도' and year_of(raw):
            n += 1
            F.append(_rec(d, 0, n, it[1], 'list', '20905:trip_year', '연도', raw, None, [], {'row_labels': ['연도'], 'value_num': year_of(raw), 'col_key': str(year_of(raw)), 'col_kind': 'year', 'col_year': year_of(raw)}))
            continue
        if lab == '성명' and n <= 0 and not name:
            name = raw   # 성명은 저장하지 않고 «같은 출장 판정»용 해시에만 쓴다
            continue
        if lab not in ('직급', '장소', '기간', '내용'):
            continue
        if n < 0:
            n = 0
        if lab == '직급':
            F.append(_rec(d, 0, n, it[1], 'list', '20905:rank', '직급', raw, None, [], {'row_labels': ['직급']}))
        elif lab == '장소':
            F.append(_rec(d, 0, n, it[1], 'list', '20905:place', '장소', raw, None, [], {'row_labels': ['장소']}))
        elif lab == '기간':
            ds = RE_DATE.findall(raw)
            for k, nm in enumerate(('period_start', 'period_end')):
                if k < len(ds):
                    iso = f'{ds[k][0]}-{int(ds[k][1]):02d}-{int(ds[k][2]):02d}'
                    F.append(_rec(d, 0, n, it[1], 'list', f'20905:{nm}', '기간', raw, None, [], {'row_labels': ['기간'], 'value_date': iso}))
            if not ds:
                F.append(_rec(d, 0, n, it[1], 'list', '20905:period_start', '기간', raw, None, ['date_unparsed'], {'row_labels': ['기간']}))
        else:
            rawn = rawn or trail(items, ii)
            F.append(_rec(d, 0, n, it[1], 'list', '20905:purpose', '내용', rawn[:2000], None, [], {'row_labels': ['내용']}))
    # 출장 1건 = 문서 1건(같은 기관·해에 여러 건) → 같은 출장의 재공시만 서로 교체되도록 교체 단위(group_period)를 출장 식별자로 둔다
    st = next((r.get('value_date') for r in F if r['field_key'] == '20905:period_start' and r.get('value_date')), None)
    rk = next((r['value_raw'] for r in F if r['field_key'] == '20905:rank'), '')
    pl = next((r['value_raw'] for r in F if r['field_key'] == '20905:place'), '')
    if st:
        d['gp_override'] = f'{st}#{_h6(rk, name, pl)}'
    return F


KEEP_KINDS = {'correction', 'note_kept'}


def apply(d, tbs, items, F):
    code = d['item_code']
    if code not in CODES:
        return F
    rng = corr_ranges(items)
    if code in YEAR_ROWS:
        M = year_rows(code, d, tbs, rng)
    elif code in YEAR_COLS:
        M = year_cols(code, d, tbs, rng)
    elif code == '31501':
        M = project_wide(d, tbs, rng)
    elif code == '70451':
        M = safety_deaths(d, tbs, rng)
    elif code == '31601':
        M = invest_exec(d, items)
    elif code == '32135':
        M = burden(d, items)
    else:
        M = trips(d, items)
    keep = [r for r in F if r['kind'] == 'correction' or 'group_na' in (r.get('parse_flags') or [])]
    return keep + M
