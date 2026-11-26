#!/usr/bin/env python3
"""rag_ext.finding_meta 추출기 (B1210 국회지적사항·B1220 감사원등지적사항 «페이지형» 문서 = 파일명 내용.md, 1지적=1문서). 읽기 전용·멱등·증분.
입력  --docs docs_B12.tsv  (doc_id, rel_path, inst_code, dup_group, body_md5, period_label, submitted_at, doc_title, doc_date, period_quarter, disclosure_no, body_group)
      --done prev_log.tsv  (doc_id \t body_md5 \t ver) — 같으면 건너뜀
출력  --out 디렉터리: finding_meta.jsonl, extract_log.jsonl, stats.json (첨부형 «미구조화» 통계 포함)
첨부형(내용.md 가 아닌 첨부 변환본)은 구조화하지 않고 건수만 센다.
"""
import re, json, os, argparse, collections

VER = 'find_v1'
COMMITTEES = ['국회운영위원회', '법제사법위원회', '정무위원회', '기획재정위원회', '교육위원회', '과학기술정보방송통신위원회', '과학기술정보통신위원회', '외교통일위원회', '국방위원회',
              '행정안전위원회', '문화체육관광위원회', '농림축산식품해양수산위원회', '농림축산식품위원회', '해양수산위원회', '산업통상자원중소벤처기업위원회', '산업통상자원위원회',
              '보건복지위원회', '환경노동위원회', '기후에너지환경노동위원회', '국토교통위원회', '정보위원회', '여성가족위원회', '예산결산특별위원회', '운영위원회', '교육문화체육관광위원회',
              '미래창조과학방송통신위원회', '안전행정위원회', '지식경제위원회', '국토해양위원회', '농림수산식품위원회', '교육과학기술위원회', '보건복지가족위원회']
COM_RX = re.compile('|'.join(sorted(COMMITTEES, key=len, reverse=True)))
SANC = ['기관주의', '주의', '경고', '시정', '개선', '통보', '권고', '징계', '문책', '변상', '회수', '고발', '현지시정', '현지조치', '감봉', '견책', '정직', '해임', '파면', '인사자료통보']
SANC_RX = re.compile(r'[\(<\[‘\'“"]\s*(' + '|'.join(sorted(SANC, key=len, reverse=True)) + r')\s*(?:조치)?[\)>\]’\'”"]')
# 상태 사전: 실제 조치결과 문장에서 귀납(보고서 표 참조)
ST = [('완료', r'조치\s*완료|이행\s*완료|시정\s*완료|처리\s*완료|완료'), ('진행', r'추진\s*중|진행\s*중|검토\s*중|지속\s*추진|계속\s*추진|장기\s*추진'),
      ('예정', r'추진\s*예정|조치\s*예정|반영\s*예정|예정'), ('미이행', r'미이행|불수용|수용\s*곤란'), ('해당없음', r'해당\s*없음')]


def sections(t):
    out = []
    for m in re.finditer(r'^### ?(.*?)[ \t]*\n(.*?)(?=^### |\Z)', t, re.S | re.M):
        out.append((m.group(1).strip(), m.group(2).strip()))
    return out


def body_of(secs, name):
    c = [b for n, b in secs if n == name and not b.startswith('첨부파일') and not b.startswith('시행기관') and len(b) > 6 and not b.startswith('.')]
    return max(c, key=len) if c else ''


def has_attach(secs, name):
    return any(n == name and b.startswith('첨부파일') for n, b in secs)


def extract(t, rel, code):
    o = {}
    secs = sections(t)
    m = re.search(r'^#\s*(.+)$', t, re.M)
    o['post_title'] = m.group(1).strip()[:200] if m else None
    # 시행기관(국회/감사원/주무부처 …)
    m = re.search(r'시행기관\s*([가-힣A-Za-z()·]{2,15})', t[:600])
    a = m.group(1) if m else None
    if not a:
        m = re.search(r'^#.*\n+\s*([^\n#]{1,20}?)\s*\n###', t[:600])
        a = m.group(1).strip() if m else None
    KNOWN = ('국회', '감사원', '주무부처')
    o['authority'] = a if a in KNOWN else None   # 그 밖의 값은 6+4건 오탐/빈값 — 미상으로 둔다
    pm = re.search(r'시행기간\s*\n\s*(20\d\d)\.(\d\d)\.(\d\d)\s*~\s*(20\d\d)\.(\d\d)\.(\d\d)', t)
    o['period_start'] = '%s-%s-%s' % pm.group(1, 2, 3) if pm else None
    o['period_end'] = '%s-%s-%s' % pm.group(4, 5, 6) if pm else None
    fy = re.search(r'(20\d\d)년', o['post_title'] or '')
    if fy: o['year'], o['year_src'] = int(fy.group(1)), 'title'
    elif pm: o['year'], o['year_src'] = int(pm.group(1)), 'period'
    else:
        fm = re.search(r'/(20\d\d)/', rel)
        o['year'], o['year_src'] = (int(fm.group(1)), 'folder') if fm else (None, None)
    find = body_of(secs, '지적사항'); plan = body_of(secs, '시정조치 계획'); res = body_of(secs, '시정조치 결과')
    res = re.sub(r'\s*닫기\s*$', '', res)
    cm = COM_RX.search((o['post_title'] or '') + ' ' + find + ' ' + t[:2500])
    o['committee'] = cm.group(0) if cm and code == 'B1210' else None
    mm = re.search(r'지적\s*건수\s*:\s*(\d+)\s*건\s*조치\s*완료\s*:\s*(\d+)\s*건', t)
    o['n_findings'], o['n_done'] = (int(mm.group(1)), int(mm.group(2))) if mm else (None, None)
    o['n_items_listed'] = len(re.findall(r'^\s*\d+\s*[.)]\s', find, re.M)) or None
    sc = collections.Counter(re.sub(r'\s', '', x) for x in SANC_RX.findall(t))
    o['sanction_kinds'] = dict(sc) if sc else None
    o['sanction_main'] = sc.most_common(1)[0][0] if sc else None
    o['plan_written'] = bool(re.sub(r'\W', '', plan))
    o['result_written'] = bool(re.sub(r'\W', '', res))
    o['result_attach_only'] = (not o['result_written']) and has_attach(secs, '시정조치 결과')
    # 조치 상태: 건수 우선, 없으면 결과문 키워드
    st_all = []
    head = res[:600]
    for k, rx in ST:
        if re.search(rx, head): st_all.append(k)
    o['status_all'] = st_all or None
    ma = re.search(r'조치\s*실적\s*[:：]\s*(완료|추진|진행|예정|미이행|해당\s*없음)', res[:600])
    if ma and o['n_findings'] is None:
        k = re.sub(r'\s', '', ma.group(1)); o['status_class'] = {'추진': '진행'}.get(k, k); o['status_src'] = 'actual'
    elif o['n_findings'] is not None and o['n_findings'] > 0:
        o['status_class'] = '완료' if o['n_done'] >= o['n_findings'] else ('일부완료' if o['n_done'] > 0 else '미완료')
        o['status_src'] = 'count'
    elif st_all:
        s = set(st_all)
        o['status_class'] = ('혼합' if ('완료' in s and (s & {'진행', '예정'})) else st_all[0])
        o['status_src'] = 'keyword'
    else:
        o['status_class'], o['status_src'] = (None, None)
    # 신뢰도: 건수(지적건수/조치완료)·«조치실적:» 표기는 high, 결과문 키워드 추정은 low(육안 표본 정밀도 ≈65%, 보고서 참조)
    o['status_conf'] = {'count': 'high', 'actual': 'high', 'keyword': 'low'}.get(o['status_src'])
    o['finding_head'] = re.sub(r'\s+', ' ', re.sub(r'지적건수.*$', '', find, flags=re.S))[:300] or None
    return o


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
    fo = open(os.path.join(a.out, 'finding_meta.jsonl'), 'w', encoding='utf8')
    fl = open(os.path.join(a.out, 'extract_log.jsonl'), 'w', encoding='utf8')
    st = collections.Counter(); posts = collections.defaultdict(lambda: [0, 0])  # folder -> [page, attach]
    for ln in open(a.docs, encoding='utf8'):
        p = ln.rstrip('\n').split('\t')
        if len(p) < 12: continue
        doc_id, rel, inst, dup, md5, plabel = p[:6]
        code = re.search(r'/(B12[12]0)_', rel).group(1)
        fn = rel.rsplit('/', 1)[-1]; folder = rel.rsplit('/', 1)[0]
        if fn != '내용.md':
            st[code + '_attachment_docs'] += 1; posts[folder][1] += 1; continue
        posts[folder][0] += 1; st[code + '_page_docs'] += 1
        if done.get(doc_id) == (md5, VER): st['skipped_done'] += 1; continue
        try: t = open(a.base + rel, encoding='utf8').read()
        except OSError:
            st['no_file'] += 1; continue
        o = extract(t, rel, code)
        o.update(doc_id=doc_id, code=code, inst_code=inst, dup_group=dup or None, body_md5=md5 or None, period_label=plabel or None, src_rel_path=rel)
        fo.write(json.dumps(o, ensure_ascii=False) + '\n'); st[code + '_extracted'] += 1
        fl.write(json.dumps(dict(doc_id=doc_id, tbl='finding_meta', body_md5=md5, ver=VER, status='ok', n_rows=1)) + '\n')
    fo.close(); fl.close()
    for f, (pg, at) in posts.items():
        c = re.search(r'/(B12[12]0)_', f + '/').group(1)
        st[c + ('_posts_page' if pg else '_posts_attachment_only')] += 1
    json.dump(dict(st), open(os.path.join(a.out, 'stats.json'), 'w'), ensure_ascii=False)
    print(json.dumps(dict(st), ensure_ascii=False))


if __name__ == '__main__':
    main()
