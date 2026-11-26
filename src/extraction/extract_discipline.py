#!/usr/bin/env python3
"""rag_ext.discipline_case 추출기 (코드 21211 징계처분 결과 표 → 행 단위). 읽기 전용, 멱등, 증분.
입력  --docs  docs_21211.tsv  (doc_id, rel_path, inst_code, dup_group, body_md5, period_label, submitted_at, doc_title, doc_date, period_quarter, disclosure_no)
      --done  이전_extract_log.tsv (선택: doc_id \t body_md5 \t extract_ver) — 같으면 건너뜀(신규·변경 문서만 재처리)
출력  --out   디렉터리: discipline_case.jsonl (문서×행), extract_log.jsonl (문서 단위 상태)
개인정보: 대상자 실명은 원 표에 없음(열: 징계처분일·종류·사유·고발여부). 표 아래 «기관 공시 담당자» 표(성명·전화)는 읽지 않는다.
          사유 문장 안의 이름·전화·이메일·주민번호 꼴은 마스킹하고 pii_masked 에 건수만 남긴다.
사용: python3 extract_discipline.py --docs docs.tsv --out outdir [--done prev.tsv] [--base <MD_ROOT>/]
"""
import re, json, sys, os, hashlib, unicodedata, argparse

VER = 'disc_v1'
DATE = re.compile(r'(20\d\d)\s*[년.\-/]\s*(\d{1,2})\s*[월.\-/]\s*(\d{1,2})')
# 심한 순. 사전은 실데이터(1,694문서·28k행)에서 귀납(보고서 참조).
ORDER = ['파면', '해임', '해고', '면직', '계약해지', '강등', '강급', '정직', '감봉', '견책', '근신', '계고', '불문경고', '경고', '훈계', '주의']
PAT = {'불문경고': r'불문(?:경고)?', '파면': '파면', '해임': '해임', '해고': '해고', '면직': '면직', '계약해지': '(?:근로)?계약해지', '강등': '강등', '강급': '강급', '정직': '정직',
       '감봉': '감[봉급]', '견책': '견[책잭]|겸책', '근신': '근신', '계고': '계고', '경고': '경고', '훈계': '훈계', '주의': '주의'}
PII = [(re.compile(r'\b\d{6}-?[1-4]\d{6}\b'), '[주민번호]'), (re.compile(r'\b0\d{1,2}-\d{3,4}-\d{4}\b'), '[전화]'),
       (re.compile(r'[\w.+-]+@[\w-]+\.[\w.]+'), '[이메일]'),
       # 실측: 이름 직접 기재 0건(직원·부하직원 앞 단어는 전부 오탐이어서 «씨» 꼴만 남김)
       (re.compile(r'(?<![가-힣])[가-힣]{2,3}\s*씨(?![가-힣])'), '[성명]')]


def norm_type(raw):
    s = unicodedata.normalize('NFKC', raw or '')
    z = re.sub(r'\s+', '', s)
    found = [k for k in ORDER if re.search(PAT[k], z)]
    if '불문경고' in found and '경고' in found: found.remove('경고')
    out = {'type_all': found, 'type_base': found[0] if found else None, 'period_months': None, 'period_days': None}
    m = re.search(r'(\d+)\s*(?:개월|월)', z)
    if m: out['period_months'] = int(m.group(1))
    m = re.search(r'(\d+)\s*(?:근무일|일)', z)
    if m: out['period_days'] = int(m.group(1))
    return out


def mask(txt):
    n = 0
    for rx, rep in PII:
        txt, k = rx.subn(rep, txt); n += k
    return txt, n


def iso(m): return '%s-%02d-%02d' % (m.group(1), int(m.group(2)), int(m.group(3)))


PLACEHOLDER = re.compile(r'^(?:-|해당\s*(?:사항)?\s*없음)$')


def parse(text):
    """returns (rows, meta). rows: list of dict (row_no 1..n)."""
    rows, meta = [], {}
    meta['has_table'] = bool(re.search(r'\|\s*징계\s*처분일', text))
    lines = text.split('\n'); i = 0; intable = False
    cur = None
    def flush():
        nonlocal cur
        if cur is None: return
        c = [x.strip() for x in cur.strip().strip('|').split('|')]
        cur = None
        if len(c) < 3: return
        m = DATE.search(c[0])
        if not m: return
        rows.append((iso(m), c[1], ' '.join(c[2:-1]) if len(c) > 4 else c[2], c[-1] if len(c) >= 4 else '', cur_raw[0]))
    cur_raw = ['']
    for ln in lines:
        s = ln.strip()
        if re.match(r'\|\s*징계\s*처분일', s): intable = True; continue
        if re.match(r'\|\s*기준일\s*\|', s):
            flush()
            ds = DATE.findall(s)
            if len(ds) >= 1: meta['base_date'] = '%s-%02d-%02d' % (ds[0][0], int(ds[0][1]), int(ds[0][2]))
            if len(ds) >= 2: meta['submitted_date'] = '%s-%02d-%02d' % (ds[1][0], int(ds[1][1]), int(ds[1][2]))
            intable = False; continue
        if re.match(r'\|\s*기관\s*공시\s*담당자', s): flush(); intable = False; continue   # 담당자 표(실명·전화): 읽지 않는다
        if not intable: continue
        if cur is not None:                        # 셀 안 줄바꿈으로 끊긴 행 이어붙이기
            cur += ' ' + s; cur_raw[0] += ' ' + s
            if s.endswith('|'): flush()
            continue
        if re.match(r'\|\s*20\d\d', s):
            cur = s; cur_raw[0] = s
            if s.endswith('|'): flush()
    flush()
    return rows, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--docs'); ap.add_argument('--out'); ap.add_argument('--done')
    ap.add_argument('--base', default='<MD_ROOT>/')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    done = {}
    if a.done and os.path.exists(a.done):
        for ln in open(a.done, encoding='utf8'):
            p = ln.rstrip('\n').split('\t')
            if len(p) >= 3: done[p[0]] = (p[1], p[2])
    fr = open(os.path.join(a.out, 'discipline_case.jsonl'), 'w', encoding='utf8')
    fl = open(os.path.join(a.out, 'extract_log.jsonl'), 'w', encoding='utf8')
    st = dict(docs=0, skipped_done=0, dup_skipped=0, no_file=0, rows=0, zero_docs=0, unclassified=0, pii_rows=0)
    seen_md5 = {}
    for ln in open(a.docs, encoding='utf8'):
        p = ln.rstrip('\n').split('\t')
        if len(p) < 11: continue
        doc_id, rel, inst, dup, md5, plabel, subm, title, ddate, pq, dno = p[:11]
        st['docs'] += 1
        if done.get(doc_id) == (md5, VER): st['skipped_done'] += 1; continue
        if md5 and (inst, md5) in seen_md5 and os.environ.get('NO_MD5_SKIP') != '1':
            # 본문 해시가 같은 문서는 같은 행을 낳는다 — 대표 1건만 파싱, 나머지는 로그만(건수 부풀림 방지는 case_key 뷰에서도 보장)
            st['dup_skipped'] += 1
            fl.write(json.dumps(dict(doc_id=doc_id, tbl='discipline_case', body_md5=md5, ver=VER, status='dup_of', dup_of=seen_md5[(inst, md5)], n_rows=0), ensure_ascii=False) + '\n'); continue
        seen_md5[(inst, md5)] = doc_id
        try: text = open(a.base + rel, encoding='utf8').read()
        except OSError:
            st['no_file'] += 1
            fl.write(json.dumps(dict(doc_id=doc_id, tbl='discipline_case', body_md5=md5, ver=VER, status='no_file', n_rows=0)) + '\n'); continue
        rows, meta = parse(text)
        seq = {}
        for k, (d, typ, reason, acc, raw) in enumerate(rows, 1):
            r, n = mask(re.sub(r'\s+', ' ', reason).strip())
            t = norm_type(typ)
            ph = bool(PLACEHOLDER.match(typ.strip()))
            key0 = '|'.join([inst, d, unicodedata.normalize('NFKC', re.sub(r'\s', '', typ)), re.sub(r'\s', '', r)])
            seq[key0] = seq.get(key0, 0) + 1                      # 같은 날 같은 처분·사유 행이 여럿이면 순번(사람 수 보존)
            case_key = hashlib.sha1((key0 + '|%d' % seq[key0]).encode()).hexdigest()[:20]
            acc_n = re.sub(r'\s', '', acc)
            row = dict(doc_id=doc_id, row_no=k, case_key=case_key, inst_code=inst, period_label=plabel, base_date=meta.get('base_date'),
                       submitted_date=meta.get('submitted_date') or (subm or None), action_date=d, type_raw=typ[:60], type_base=t['type_base'],
                       type_all=t['type_all'], period_months=t['period_months'], period_days=t['period_days'], reason=r[:400],
                       prosecuted=True if acc_n == '고발' else (False if acc_n == '미고발' else None), prosecuted_raw=acc[:20] or None,
                       has_surcharge='징계부가금' in typ, is_placeholder=ph, person_name_masked=n > 0, pii_masked=n, raw_row=mask(re.sub(r'\s+', ' ', raw))[0][:600], src_rel_path=rel)
            fr.write(json.dumps(row, ensure_ascii=False) + '\n')
            st['rows'] += 1
            if not t['type_base'] and not ph: st['unclassified'] += 1
            if ph: st['placeholder'] = st.get('placeholder', 0) + 1
            if n: st['pii_rows'] += 1
        zero = not rows
        if zero: st['zero_docs'] += 1
        fl.write(json.dumps(dict(doc_id=doc_id, tbl='discipline_case', body_md5=md5, ver=VER, status=('no_table' if not meta['has_table'] else 'zero_rows') if zero else 'ok', n_rows=len(rows),
                                 base_date=meta.get('base_date'), submitted_date=meta.get('submitted_date')), ensure_ascii=False) + '\n')
    fr.close(); fl.close()
    print(json.dumps(st))


if __name__ == '__main__':
    main()
