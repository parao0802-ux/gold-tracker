/* 한국금거래소 고시가 프록시.
   원본 API가 CORS를 막아 브라우저에서 직접 못 부르므로 서버를 거친다.
   원본에 부담을 주지 않도록 엣지에서 5분간 캐시한다. */

const SRC = 'https://www.koreagoldx.co.kr/api/price/chart/list';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function dot(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
}

function dayOf(s) { return String(s || '').slice(0, 10); }

module.exports = async (req, res) => {
  try {
    const now = new Date();
    const body = {
      srchDt: '1',
      type: 'Au',
      dataDateStart: dot(new Date(now.getTime() - 10 * 864e5)),
      dataDateEnd: dot(now)
    };

    const r = await fetch(SRC, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Referer': 'https://www.koreagoldx.co.kr/price/gold',
        'User-Agent': UA
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) throw new Error('한국금거래소 응답 HTTP ' + r.status);

    const data = await r.json();
    const list = Array.isArray(data && data.list) ? data.list : [];
    if (!list.length) throw new Error('고시가가 비어 있습니다');

    // 응답은 최신순. 첫 항목이 현재 고시가.
    const cur = list[0];
    const curDay = dayOf(cur.date);
    const prev = list.find((x) => dayOf(x.date) < curDay) || null;

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({
      at: cur.date,
      buy:  { pure: cur.s_pure, silver: cur.s_silver },
      sell: { pure: cur.p_pure, silver: cur.p_silver, k18: cur.p_18k, k14: cur.p_14k },
      prevSell: prev ? { pure: prev.p_pure, silver: prev.p_silver, at: prev.date } : null,
      source: '한국금거래소'
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: e.message || String(e) });
  }
};
