# -*- coding: utf-8 -*-
"""D유형(재무표) 계정 키 사전. 키 형식은 시범 A 와 같다: `코드:토큰.토큰` (필드 키는 표 구분(고유/연결/기금)과 무관 — 표 구분은 table_title 접두).
라벨은 공백·괄호 속 영문/기호를 제거한 한글로 정규화해서 조회한다. 미매핑이면 None (parse_flags 에 key_unmapped)."""
import re


def norm(s):
    s = (s or '').replace('*', '')
    s = re.sub(r'\s+', '', s)
    return s


# ---- 31201 요약 재무상태표 -------------------------------------------------
K31201 = {
    '유동자산': 'asset.current', '비유동자산': 'asset.noncurrent', '자산총계': 'asset.total',
    '투자자산': 'asset.invest', '일반유형자산': 'asset.tangible', '사회기반시설': 'asset.infra', '무형자산': 'asset.intangible',
    '기타비유동자산': 'asset.other_noncurrent', '금융자산': 'asset.financial', '기타자산': 'asset.other', '유·무형자산': 'asset.tangible_intangible',
    '유동부채': 'liab.current', '비유동부채': 'liab.noncurrent', '부채총계': 'liab.total',
    '장기차입부채': 'liab.lt_borrowing', '장기충당부채': 'liab.lt_provision', '기타비유동부채': 'liab.other_noncurrent',
    '차입부채': 'liab.borrowing', '충당부채': 'liab.provision', '기타부채': 'liab.other', '보험부채': 'liab.insurance', '금융부채': 'liab.financial',
    '자본금': 'equity.capital', '자본금(A)': 'equity.capital', '기타(B)': 'equity.other', '지배기업의소유주지분(A+B)': 'equity.parent',
    '비지배지분': 'equity.nci', '자본총계': 'equity.total',
    '기본순자산': 'equity.net_base', '적립금및잉여금': 'equity.reserve', '순자산조정': 'equity.net_adj',
    '순자산총계': 'equity.total',   # 기금(국가회계) 서식의 자본총계 대응 항목 — field_label 에 원문 «순자산총계» 유지
    '부채비율': 'debt_ratio',
}
GRP_OTHER = {'자본': 'equity.other', '순자산': 'equity.other', '자산': 'asset.other', '부채': 'liab.other'}  # 라벨 «기타» 는 상위 묶음으로 결정

# ---- 31301 요약 손익계산서 -------------------------------------------------
K31301 = {
    '수익(매출액)': 'rev.total', '매출': 'rev.gross', '매출액': 'rev.gross', '순매출': 'rev.net', '매출원가': 'cogs', '판관비': 'sga', '영업이익': 'op_income',
    '기타수익': 'other_income', '기타비용': 'other_expense', '기타이익': 'other_gain', '금융수익': 'fin_income', '금융원가': 'fin_cost',
    '지분법대상기업관련이익등': 'equity_method', '법인세비용차감전순이익': 'pretax_income', '법인세비용': 'tax', '당기순이익': 'net_income',
    '계속영업당기순이익': 'net_income.continuing', '중단영업당기순이익': 'net_income.discontinued', '이자비용': 'interest_expense',
    '기타포괄손익': 'oci', '총포괄손익': 'comprehensive_income',
    '지배기업의소유주에게귀속되는당기순이익': 'net_income.parent', '비지배지분에귀속되는당기순이익': 'net_income.nci',
    '영업이익외수익': 'nonop_income', '영업외수익': 'nonop_income', '영업외비용': 'nonop_expense', '총수익': 'income.total', '총비용': 'expense.total',
    '매출액순이익률': 'net_margin', '자기자본회전율': 'equity_turnover',
    # 국가회계(재정운영표)
    '프로그램총원가': 'prog.gross_cost', '프로그램수익': 'prog.revenue', '프로그램순원가': 'prog.net_cost', '관리운영비': 'admin_cost',
    '비배분비용': 'unalloc.cost', '비배분수익': 'unalloc.revenue', '재정운영순원가': 'fiscal.net_op_cost', '비교환수익등': 'nonexch_revenue',
    '재정운영결과': 'fiscal.result', '재정운영결과(비용-수익)': 'fiscal.result',
    '국가운영수익': 'state.op_revenue', '수익총계': 'state.rev_total', '국가운영비용': 'state.op_cost', '비용총계': 'state.cost_total',
    '이전수익': 'transfer.revenue', '이전비용': 'transfer.cost',
}
# 31301 «수익 / 이전수익», «비용 / 이전비용» 처럼 2단 라벨은 마지막 토큰만 사용

# ---- 31401 수입·지출 현황 --------------------------------------------------
K_GOVNET = {'출연금': 'govnet.grant', '출자금': 'govnet.equity', '보조금': 'govnet.subsidy', '부담금': 'govnet.charge', '이전수입': 'govnet.transfer',
            '위탁수입': 'govnet.consign', '기타수입': 'govnet.other', '합계': 'govnet.total'}
K_INC = {  # (그룹, 라벨) -> 키. 그룹은 행 순서 상태기계(직접지원/간접지원/소계 이후)로 정해진다
    ('direct', '출연금'): 'income.gov.direct.grant', ('direct', '보조금'): 'income.gov.direct.subsidy', ('direct', '부담금'): 'income.gov.direct.charge',
    ('direct', '이전수입'): 'income.gov.direct.transfer', ('direct', '부대수입'): 'income.gov.direct.ancillary',
    ('indirect', '사업수입'): 'income.gov.indirect.biz', ('indirect', '위탁수입'): 'income.gov.indirect.consign',
    ('indirect', '독점수입'): 'income.gov.indirect.monopoly', ('indirect', '부대수입'): 'income.gov.indirect.ancillary',
}
K_INC_FLAT = {'소계': 'income.subtotal', '기타사업수입': 'income.other_biz', '출자금': 'income.equity', '차입금': 'income.borrowing', '기타': 'income.other',
              '수입합계': 'income.total'}
K_EXP = {'인건비': 'expense.personnel', '경상운영비': 'expense.operating', '사업비': 'expense.project', '차입상환금': 'expense.repay', '기타': 'expense.other',
         '지출합계': 'expense.total'}

# ---- 31801 차입금 ------------------------------------------------------------
K31801 = {'기초잔액': 'begin', '기말잔액': 'end', '변동금액': 'change', '변동사유(차입목적)': 'reason', '주요차입형태': 'form',
          '자기자본대비비율': 'equity_ratio', '차입금의존도': 'dependency'}

# ---- 31901 투·출자 -----------------------------------------------------------
K31901_SUM = {'자회사': 'count.subsidiary', '출자회사': 'count.affiliate', '재출자회사': 'count.reinvested', '합계': 'count.total'}

RATIO_KEYS = {'31201:debt_ratio', '31301:net_margin', '31301:equity_turnover', '31801:lt.equity_ratio', '31801:lt.dependency', '31801:st.equity_ratio',
              '31801:st.dependency'}
TEXT_KEYS = {'31801:lt.reason', '31801:lt.form', '31801:st.reason', '31801:st.form'}


def key31201(own, grp):
    leaf = norm(own[-1]) if own else ''
    if leaf in ('기타',):
        t = GRP_OTHER.get(grp)
        return f'31201:{t}' if t else None
    t = K31201.get(leaf)
    return f'31201:{t}' if t else None


def key31301(own):
    leaf = norm(own[-1]) if own else ''
    t = K31301.get(leaf)
    return f'31301:{t}' if t else None


def key31401_govnet(own):
    t = K_GOVNET.get(norm(own[-1]) if own else '')
    return f'31401:{t}' if t else None


def key31401_income(own, st):
    """st: dict(grp). own 에 '직접지원'/'간접지원'/'지출' 이 있으면 그룹 전환. -> key|None"""
    ns = [norm(x) for x in own]
    leaf = ns[-1] if ns else ''
    if '직접지원' in ns:
        st['grp'] = 'direct'
    if '간접지원' in ns:
        st['grp'] = 'indirect'
    if ns and ns[0] == '지출':
        st['grp'] = 'exp'
    g = st.get('grp')
    if g == 'exp':
        t = K_EXP.get(leaf)
        return f'31401:{t}' if t else None
    if g in ('direct', 'indirect') and (g, leaf) in K_INC:
        return f'31401:{K_INC[(g, leaf)]}'
    if leaf == '소계':
        st['grp'] = 'post'
    if leaf == '기타사업수입':
        st['grp'] = 'other_biz'
    if g == 'other_biz' and leaf == '부대수입':
        return '31401:income.other_biz.ancillary'
    t = K_INC_FLAT.get(leaf)
    return f'31401:{t}' if t else None


def key31801(kind, label):
    t = K31801.get(norm(label))
    return f'31801:{kind}.{t}' if t else None
