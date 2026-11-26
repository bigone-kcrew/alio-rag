'use strict';
/**
 * 조문 경계 신뢰도 — 변환 산출 md에서 조문을 자를 때 "이 경계를 믿어도 되는가"를 판정한다.
 *
 * 왜 필요한가(실측 2026-08-03):
 *   원본이 PDF인 내규는 텍스트 읽기 순서가 무너져 **같은 줄의 다른 단 텍스트가 탭으로 이어붙는다**.
 *   예: 육아정책연구소 노사협의회 규칙(2017) — 제1조 본문이 줄 끝으로 밀려
 *       「제1조(명칭) 한다)라 칭한다.」만 남고, 제1조의 실제 본문은 제2조 뒤에 붙었다.
 *   이 상태로 조문을 자르면 **값을 엉뚱한 조문에 귀속**시키고(조건 비교), **실제 개정이 아닌 것을
 *   개정으로 판정**한다(신구대조표). 둘 다 조용히 틀린다.
 *
 * 문서 단위 임계값으로는 못 잡는다 — 위 파일은 인라인 헤딩이 14%뿐이라 어떤 문서 임계값을 잡아도
 * 정상으로 분류되거나, 정상 문서를 대량 오탐한다. 그래서 **조문 단위**로 판정한다.
 *
 * 전수 측정(내규 md 34,094문서 · 조문 1,036,561개):
 *   경계 불확실 조문 37,636개(3.6%) · 그런 조문을 가진 문서 9,705개(28.5%, PDF 4,315 / HWP 5,367)
 */

const ART_RE = /제\s?(\d+)\s?조(?:의\s?(\d+))?\s?\(([^)]{2,30})\)/g;

/** 본문에 다른 조문 헤딩이 섞였는지 볼 때 앞부분만 본다 — 뒤쪽은 다음 조문과의 정상 경계일 수 있다. */
const LOOKAHEAD = 600;
/** 이보다 짧은 본문은 조문이 잘렸다는 신호다(제목만 남고 내용이 다른 곳으로 밀린 경우). */
const MIN_BODY = 20;

/**
 * 조문 단위로 자르고 경계 신뢰도를 함께 돌려준다.
 * @returns {Array<{key,no,title,body,at,boundaryOk,reason}>}
 */
function parseArticles(text) {
  const src = String(text || '');
  const i = src.indexOf('---', 4);
  const body = i > 0 && i < 1200 ? src.slice(i + 3) : src;   // 프론트매터 제거(있을 때만)
  const hits = [...body.matchAll(ART_RE)];
  const out = [];
  for (let k = 0; k < hits.length; k++) {
    const h = hits[k];
    const s = h.index + h[0].length;
    const e = k + 1 < hits.length ? hits[k + 1].index : body.length;
    const seg = body.slice(s, e);
    const trimmed = seg.trim();
    let boundaryOk = true, reason = '';
    if (trimmed.length < MIN_BODY) { boundaryOk = false; reason = '본문이 ' + MIN_BODY + '자 미만 — 내용이 다른 조문으로 밀렸을 수 있다'; }
    else if (/제\s?\d+\s?조\s?\(/.test(seg.slice(0, LOOKAHEAD))) { boundaryOk = false; reason = '본문 안에 다른 조문 헤딩이 있다 — 조문 경계가 밀렸다'; }
    out.push({
      key: '제' + h[1] + '조' + (h[2] ? '의' + h[2] : ''),
      no: +h[1], title: h[3].trim(), body: trimmed, at: h.index,
      // raw = 헤딩까지 포함한 **원문 그대로의 조각**. 인용을 원문과 대조하는 소비자는 이걸 써야 한다
      // (본문을 재구성하면 띄어쓰기가 달라져 대조가 깨진다 — 실제로 한 번 깨졌다).
      raw: body.slice(h.index, e),
      boundaryOk, reason,
    });
  }
  return out;
}

/** 문서 요약 — 화면·로그에 "이 문서를 얼마나 믿을 수 있나"를 적을 때 쓴다. */
function docQuality(text) {
  const arts = parseArticles(text);
  const bad = arts.filter(a => !a.boundaryOk).length;
  return {
    articles: arts.length,
    unreliable: bad,
    ratio: arts.length ? bad / arts.length : 0,
    // 전량 신뢰 / 일부 조문만 제외 / 조문 단위 사용 불가
    level: !arts.length ? 'none' : bad === 0 ? 'ok' : (bad / arts.length) >= 0.5 ? 'low' : 'partial',
  };
}

/**
 * 조문 1건만 놓고 경계를 판정한다 — **이미 잘려 있는 조문**(예: RAG DB articles 행)용.
 * parseArticles 는 원문 전체를 자를 때 쓰고, 이건 잘린 결과를 받아 쓸 때 쓴다.
 * 두 경로가 같은 규칙을 쓰도록 여기 한 곳에 둔다(규칙이 갈리면 화면마다 판정이 달라진다).
 */
function judgeArticle(body) {
  const b = String(body || '').trim();
  if (b.length < MIN_BODY) return { boundaryOk: false, reason: '본문이 ' + MIN_BODY + '자 미만 — 내용이 다른 조문으로 밀렸을 수 있다' };
  if (/제\s?\d+\s?조\s?\(/.test(b.slice(0, LOOKAHEAD))) return { boundaryOk: false, reason: '본문 안에 다른 조문 헤딩이 있다 — 조문 경계가 밀렸다' };
  return { boundaryOk: true, reason: '' };
}

module.exports = { parseArticles, docQuality, judgeArticle, ART_RE, MIN_BODY, LOOKAHEAD };
