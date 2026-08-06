/* 한국금거래소 고시가 프록시.
   원본 API가 CORS를 막아 브라우저에서 직접 못 부르므로 서버를 거친다.

   ⚠️ 반드시 서울(icn1) 리전에서 돌아야 한다 — 미국 리전 IP는 403으로 막힌다.
      vercel.json의 regions 설정을 지우지 말 것.

   GET /api/domestic-gold              최근 고시가 + 전일 종가 + 오늘 시각별
   GET /api/domestic-gold?range=year   최근 1년 일별 이력 (차트용) */

const SRC = 'https://www.koreagoldx.co.kr/api/price/chart/list';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function dot(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
}

function dayOf(s) { return String(s || '').slice(0, 10); }

// 한국 기준 오늘 (서버가 UTC라도 KST로 맞춘다)
function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function fetchRange(startDate, endDate) {
  const r = await fetch(SRC, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Referer': 'https://www.koreagoldx.co.kr/price/gold',
      'User-Agent': UA
    },
    body: JSON.stringify({
      srchDt: '1',
      type: 'Au',
      dataDateStart: dot(startDate),
      dataDateEnd: dot(endDate)
    })
  });
  if (!r.ok) throw new Error('한국금거래소 응답 HTTP ' + r.status);
  const data = await r.json();
  const list = Array.isArray(data && data.list) ? data.list : [];
  if (!list.length) throw new Error('고시가가 비어 있습니다');
  return list; // 최신순
}

module.exports = async (req, res) => {
  /* 공개된 시세 데이터라 출처를 가리지 않고 열어 둔다.
     로컬에서 index.html을 직접 열었을 때도 국내 시세가 보이게 하려는 것.
     (인증·개인정보가 없는 응답이라 * 로 열어도 노출될 게 없다) */
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const now = new Date();
    const year = String(req.query && req.query.range) === 'year';

    if (year) {
      const list = await fetchRange(new Date(now.getTime() - 365 * 864e5), now);

      // 하루에 여러 번 고시되므로 날짜별 마지막(=최신) 값만 남긴다.
      // 응답이 최신순이라 처음 만난 날짜가 그 날의 최종 고시가다.
      const seen = new Set();
      const history = [];
      for (const row of list) {
        const d = dayOf(row.date);
        if (seen.has(d)) continue;
        seen.add(d);
        history.push({ d: d, s: row.s_pure, p: row.p_pure });
      }
      history.reverse(); // 오래된 순

      res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
      return res.status(200).json({ history: history, source: '한국금거래소' });
    }

    const list = await fetchRange(new Date(now.getTime() - 10 * 864e5), now);
    const cur = list[0];
    const curDay = dayOf(cur.date);
    const prev = list.find((x) => dayOf(x.date) < curDay) || null;

    // 오늘 고시된 것들 (오래된 순) — 시간대별 차트용
    const t = todayKST();
    const today = list
      .filter((x) => dayOf(x.date) === t)
      .map((x) => ({ t: x.date, s: x.s_pure, p: x.p_pure }))
      .reverse();

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({
      at: cur.date,
      buy:  { pure: cur.s_pure, silver: cur.s_silver },
      sell: { pure: cur.p_pure, silver: cur.p_silver, k18: cur.p_18k, k14: cur.p_14k },
      prevSell: prev ? { pure: prev.p_pure, silver: prev.p_silver, at: prev.date } : null,
      today: today,
      source: '한국금거래소'
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: e.message || String(e) });
  }
};
