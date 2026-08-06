/* ============================================================
   금시세 트래커
   - 국제 현물 시세(XAU/XAG) + USD/KRW 환율로 원화 시세 산출
   - 매수 기록은 localStorage에만 저장 (서버 전송 없음)
   ============================================================ */
(function () {
  'use strict';

  // ── 상수 ───────────────────────────────────────────────────
  var OZ_G  = 31.1034768;   // 1 트로이온스 = 31.1034768 g
  var DON_G = 3.75;         // 1 돈 = 3.75 g

  var UNIT_G = { g: 1, don: DON_G, oz: OZ_G, kg: 1000 };
  var UNIT_LABEL = { g: 'g', don: '돈', oz: 'oz', kg: 'kg' };
  var METAL_LABEL = { gold: '금', silver: '은' };

  var LS = {
    holdings:  'gold2.holdings',
    snapshots: 'gold2.snapshots',
    prices:    'gold2.prices',
    goldHist:  'gold2.goldHistory',
    domestic:  'gold2.domestic',
    domHist:   'gold2.domesticHistory',
    theme:     'gold2.theme'
  };

  var HIST_DAYS = 365;

  var SNAP_MERGE_MS = 5 * 60 * 1000;  // 5분 내 재조회는 마지막 점을 갱신
  var SNAP_MAX      = 2000;
  var REFRESH_MS    = 60 * 1000;

  // ── 상태 ───────────────────────────────────────────────────
  var holdings  = load(LS.holdings, []);
  var snapshots = load(LS.snapshots, []);
  var prices    = load(LS.prices, null);
  var goldHist  = load(LS.goldHist, null);
  var domestic  = load(LS.domestic, null);
  var domHist   = load(LS.domHist, null);
  var goldRange = 365;
  var editingId = null;
  var refreshTimer = null;

  var $ = function (id) { return document.getElementById(id); };

  // ── 유틸 ───────────────────────────────────────────────────
  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  // 기록을 고치기 직전에는 항상 저장소를 먼저 읽는다.
  // 다른 탭이 그 사이 추가·삭제한 내용을 통째로 덮어쓰지 않기 위한 안전장치.
  function syncHoldings() {
    var stored = load(LS.holdings, null);
    if (Array.isArray(stored)) holdings = stored;
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { banner('저장 공간이 가득 찼습니다. 오래된 기록을 정리해 주세요.'); }
  }

  function won(n) {
    if (!isFinite(n)) return '—';
    return '₩' + Math.round(n).toLocaleString('ko-KR');
  }

  function signedWon(n) {
    if (!isFinite(n)) return '—';
    var s = n > 0 ? '+' : n < 0 ? '−' : '';
    return s + '₩' + Math.abs(Math.round(n)).toLocaleString('ko-KR');
  }

  function signedPct(n) {
    if (!isFinite(n)) return '—';
    var s = n > 0 ? '+' : n < 0 ? '−' : '';
    return s + Math.abs(n).toFixed(2) + '%';
  }

  function num(n, digits) {
    if (!isFinite(n)) return '—';
    return n.toLocaleString('ko-KR', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits || 0
    });
  }

  // 축 눈금용 압축 표기 (1.2억 / 340만)
  function compactWon(v) {
    var a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(a >= 1e9 ? 0 : 1).replace(/\.0$/, '') + '억';
    if (a >= 1e4) return Math.round(v / 1e4).toLocaleString('ko-KR') + '만';
    return Math.round(v).toLocaleString('ko-KR');
  }

  function clsFor(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : ''; }

  function uid() {
    return 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function todayISO() {
    var d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 10);
  }

  function isoDaysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 10);
  }

  // 매수일을 '그 날의 끝'으로 본다 — 그날 찍힌 스냅샷에도 반영되도록
  function dateEnd(iso) {
    var t = new Date(iso + 'T23:59:59').getTime();
    return isNaN(t) ? 0 : t;
  }

  function banner(msg) {
    var el = $('banner');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.hidden = false;
  }

  // ── 파생값 ─────────────────────────────────────────────────
  // 순금(순은) 환산 그램: 수량 × 단위계수 × 순도
  function pureGrams(h) {
    return h.qty * (UNIT_G[h.unit] || 1) * h.purity;
  }

  function krwPerGram(usdPerOz, fx) { return usdPerOz * fx / OZ_G; }

  function currentRates() {
    if (!prices || !prices.fx) return null;
    return {
      gold:   prices.goldUsdOz   ? krwPerGram(prices.goldUsdOz, prices.fx)   : null,
      silver: prices.silverUsdOz ? krwPerGram(prices.silverUsdOz, prices.fx) : null
    };
  }

  function rateFor(rates, metal) {
    if (!rates) return null;
    return metal === 'silver' ? rates.silver : rates.gold;
  }

  function valueOf(h, rates) {
    var r = rateFor(rates, h.metal);
    return r == null ? null : pureGrams(h) * r;
  }

  // ── 시세 조회 ──────────────────────────────────────────────
  function getJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
      return r.json();
    });
  }

  function fetchFx() {
    return getJSON('https://api.frankfurter.app/latest?from=USD&to=KRW')
      .then(function (d) {
        if (!d || !d.rates || !d.rates.KRW) throw new Error('환율 응답 형식 오류');
        return { fx: d.rates.KRW, fxDate: d.date, fxSource: 'ECB 기준' };
      })
      .catch(function () {
        return getJSON('https://open.er-api.com/v6/latest/USD').then(function (d) {
          if (!d || !d.rates || !d.rates.KRW) throw new Error('환율 응답 형식 오류');
          return { fx: d.rates.KRW, fxDate: (d.time_last_update_utc || '').slice(5, 16), fxSource: '실시간' };
        });
      });
  }

  function refreshPrices(manual) {
    var btn = $('refreshBtn');
    btn.classList.add('is-spinning');
    btn.disabled = true;

    return Promise.all([
      Promise.allSettled([
        getJSON('https://api.gold-api.com/price/XAU'),
        getJSON('https://api.gold-api.com/price/XAG')
      ]),
      fetchFx()
    ]).then(function (res) {
      var metals = res[0], fx = res[1];
      var gold   = metals[0].status === 'fulfilled' ? metals[0].value : null;
      var silver = metals[1].status === 'fulfilled' ? metals[1].value : null;

      if (!gold || !gold.price) throw new Error('금 시세를 가져오지 못했습니다');

      prices = {
        goldUsdOz:   gold.price,
        silverUsdOz: silver && silver.price ? silver.price : (prices ? prices.silverUsdOz : null),
        fx:          fx.fx,
        fxDate:      fx.fxDate,
        fxSource:    fx.fxSource,
        at:          Date.now(),
        quoteAt:     gold.updatedAt || null
      };
      save(LS.prices, prices);
      recordSnapshot();
      banner('');
      renderAll();
      fetchDomestic()
        .then(function () { renderDomestic(); renderGoldTrend(); })
        .catch(function () {});
    }).catch(function (err) {
      banner('시세를 불러오지 못했습니다 (' + err.message + '). ' +
             (prices ? '마지막으로 받은 시세로 표시합니다.' : '네트워크 연결을 확인해 주세요.'));
      renderAll();
      if (manual) console.error(err);
    }).then(function () {
      btn.classList.remove('is-spinning');
      btn.disabled = false;
    });
  }

  /* ── 과거 금시세 ─────────────────────────────────────────────
     폴란드 중앙은행(NBP)이 LBMA 고시가를 매일 PLN/g(순도 1000)으로
     공개한다. 여기에 같은 날짜의 PLN→KRW 환율을 곱해 원화 시세를 만든다.
     환율도 NBP에서 받는다 — 금 시세와 같은 호스트라 한쪽만 막히는 일이 없고,
     frankfurter는 예비로만 둔다(일부 망에서 차단되는 사례 확인).
     둘 다 키가 필요 없고 CORS가 열려 있다.
     하루 한 번만 받아 localStorage에 캐시한다.
     ────────────────────────────────────────────────────────── */

  // 어느 쪽이 실패했는지 메시지에 남긴다 — 안 그러면 'Failed to fetch'만 보인다
  function tagged(label, promise) {
    return promise.catch(function (e) {
      throw new Error(label + ' — ' + (e && e.message ? e.message : e));
    });
  }

  function fetchNbpGold(start, end) {
    return tagged('NBP 금 고시가',
      getJSON('https://api.nbp.pl/api/cenyzlota/' + start + '/' + end + '?format=json')
    ).then(function (d) {
      if (!Array.isArray(d) || !d.length) throw new Error('NBP 금 고시가 — 응답이 비어 있습니다');
      return d;
    });
  }

  // PLN 1당 KRW의 일별 시세를 { 'YYYY-MM-DD': rate } 로 돌려준다
  function fetchPlnKrw(start, end) {
    return getJSON('https://api.nbp.pl/api/exchangerates/rates/a/krw/' + start + '/' + end + '/?format=json')
      .then(function (d) {
        var map = {};
        (d && d.rates || []).forEach(function (r) {
          // NBP table A의 mid는 'KRW 1당 PLN'이므로 뒤집는다
          if (r.mid > 0) map[r.effectiveDate] = 1 / r.mid;
        });
        if (!Object.keys(map).length) throw new Error('빈 응답');
        return map;
      })
      .catch(function () {
        return tagged('PLN→KRW 환율',
          getJSON('https://api.frankfurter.app/' + start + '..' + end + '?base=PLN&symbols=KRW')
        ).then(function (d) {
          var map = {};
          Object.keys(d && d.rates || {}).forEach(function (k) { map[k] = d.rates[k].KRW; });
          if (!Object.keys(map).length) throw new Error('PLN→KRW 환율 — 빈 응답');
          return map;
        });
      });
  }

  function fetchGoldHistory() {
    if (goldHist && goldHist.fetchedOn === todayISO() &&
        goldHist.points && goldHist.points.length > 1) {
      return Promise.resolve();
    }

    var start = isoDaysAgo(HIST_DAYS), end = todayISO();

    return Promise.all([
      fetchNbpGold(start, end),
      fetchPlnKrw(start, end)
    ]).then(function (res) {
      var gold = res[0], fxMap = res[1];
      var fxDates = Object.keys(fxMap).sort();

      // 환율은 영업일에만 고시되므로, 각 날짜 이하의 가장 최근 값을 이어 쓴다
      var rate = fxMap[fxDates[0]];
      var i = 0;
      var points = [];

      gold.forEach(function (row) {
        while (i < fxDates.length && fxDates[i] <= row.data) {
          rate = fxMap[fxDates[i]];
          i++;
        }
        var v = row.cena * rate;
        if (isFinite(v) && v > 0) points.push({ d: row.data, v: v });
      });

      if (points.length < 2) throw new Error('시세 기록이 부족합니다');

      goldHist = { fetchedOn: todayISO(), points: points };
      save(LS.goldHist, goldHist);
    });
  }

  // ── 스냅샷 (추이 차트의 데이터 원천) ────────────────────────
  function recordSnapshot() {
    var rates = currentRates();
    if (!rates || rates.gold == null) return;

    // 다른 탭이 그 사이 쌓아둔 스냅샷을 덮어쓰지 않도록 저장소에서 다시 읽는다
    var stored = load(LS.snapshots, null);
    if (Array.isArray(stored) && stored.length >= snapshots.length) snapshots = stored;

    var snap = {
      t:  prices.at,
      g:  rates.gold,
      s:  rates.silver,
      fx: prices.fx
    };
    var last = snapshots[snapshots.length - 1];

    if (last && snap.t - last.t < SNAP_MERGE_MS) snapshots[snapshots.length - 1] = snap;
    else snapshots.push(snap);

    if (snapshots.length > SNAP_MAX) snapshots = snapshots.slice(-SNAP_MAX);
    save(LS.snapshots, snapshots);
  }

  // 각 스냅샷 시점의 보유분으로 평가액·원금을 되짚는다
  function trendSeries() {
    if (!holdings.length) return [];
    return snapshots.map(function (s) {
      var value = 0, cost = 0;
      for (var i = 0; i < holdings.length; i++) {
        var h = holdings[i];
        if (dateEnd(h.date) > s.t) continue;          // 아직 사기 전
        var r = h.metal === 'silver' ? s.s : s.g;
        if (r == null) continue;
        value += pureGrams(h) * r;
        cost  += h.cost;
      }
      return { t: s.t, value: value, cost: cost };
    }).filter(function (p) { return p.cost > 0; });
  }

  // ── 집계 ───────────────────────────────────────────────────
  function summarize() {
    var rates = currentRates();
    var out = {
      rates: rates,
      cost: 0, value: 0, priced: true,
      goldGrams: 0, goldCost: 0,
      silverGrams: 0, silverCost: 0,
      rows: []
    };

    holdings.forEach(function (h) {
      var g = pureGrams(h);
      var v = valueOf(h, rates);
      if (v == null) out.priced = false;

      out.cost  += h.cost;
      out.value += v || 0;

      if (h.metal === 'silver') { out.silverGrams += g; out.silverCost += h.cost; }
      else                      { out.goldGrams   += g; out.goldCost   += h.cost; }

      out.rows.push({ h: h, grams: g, value: v, pl: v == null ? null : v - h.cost });
    });

    out.pl  = out.value - out.cost;
    out.roi = out.cost > 0 ? (out.pl / out.cost) * 100 : NaN;
    return out;
  }

  // 전일 종가(NBP 고시가 기준) — goldHist엔 오늘 이전 날짜 중 가장 최근 값만 쓴다
  function yesterdayGoldClose() {
    if (!goldHist || !goldHist.points) return null;
    var today = todayISO();
    var pts = goldHist.points;
    for (var i = pts.length - 1; i >= 0; i--) {
      if (pts[i].d < today) return pts[i].v;
    }
    return null;
  }

  // 은·환율은 전일 고시가가 없어 로컬 스냅샷 중 하루 전과 가장 가까운 것으로 대신한다
  function snapshotAround(msAgo, tolMs) {
    if (!snapshots.length) return null;
    var target = Date.now() - msAgo;
    var best = null, bestDiff = Infinity;
    for (var i = 0; i < snapshots.length; i++) {
      var dd = Math.abs(snapshots[i].t - target);
      if (dd < bestDiff) { bestDiff = dd; best = snapshots[i]; }
    }
    return (best && bestDiff <= tolMs) ? best : null;
  }

  // 시세 아래에 "전일 대비" 문구를 덧붙인다 (기준값이 없으면 원래 텍스트만 남긴다)
  function appendDayDiff(el, baseText, curr, prev, unit) {
    el.textContent = '';
    el.appendChild(document.createTextNode(baseText));
    if (prev == null || !isFinite(prev) || prev === 0 || curr == null || !isFinite(curr)) {
      // 기준값이 없으면 칸이 접히지 않게 공백이라도 남긴다
      if (!baseText) el.textContent = ' ';
      return;
    }
    var diff = curr - prev;
    var pct = (diff / prev) * 100;
    if (baseText) el.appendChild(document.createTextNode(' · '));
    var span = document.createElement('span');
    span.className = clsFor(diff);
    var s = diff > 0 ? '+' : diff < 0 ? '−' : '';
    var amount = unit === 'won2' ? (num(Math.abs(diff), 2) + '원') : ('₩' + num(Math.abs(diff), 0));
    span.textContent = '전일 대비 ' + s + amount + ' (' + signedPct(pct) + ')';
    el.appendChild(span);
  }

  // ── 렌더: 시세 패널 ────────────────────────────────────────
  function renderPrices() {
    var rates = currentRates();

    if (!prices) {
      $('updatedAt').textContent = '시세 없음';
      return;
    }

    var yGold = yesterdayGoldClose();
    var ySnap = snapshotAround(24 * 3600 * 1000, 8 * 3600 * 1000);

    if (rates && rates.gold != null) {
      $('pxGoldG').textContent = won(rates.gold);
      appendDayDiff($('pxGoldGSub'), '$' + num(prices.goldUsdOz, 2) + ' / oz', rates.gold, yGold);
      $('pxGoldDon').textContent = won(rates.gold * DON_G);
      appendDayDiff($('pxGoldDonSub'), '1돈 = 3.75g 환산', rates.gold * DON_G, yGold == null ? null : yGold * DON_G);
    }
    if (rates && rates.silver != null) {
      $('pxSilverG').textContent = won(rates.silver);
      appendDayDiff($('pxSilverGSub'), '$' + num(prices.silverUsdOz, 2) + ' / oz',
        rates.silver, ySnap ? ySnap.s : null);
    }

    $('pxFx').textContent = num(prices.fx, 2) + '원';
    appendDayDiff($('pxFxSub'), (prices.fxSource || '') + (prices.fxDate ? ' · ' + prices.fxDate : ''),
      prices.fx, ySnap ? ySnap.fx : null, 'won2');

    var d = new Date(prices.at);
    var hhmmStr = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    $('updatedAt').textContent = hhmmStr + ' 기준';
  }

  /* ── 국내 시세 (한국금거래소) ────────────────────────────────
     원본 API가 CORS를 막아 같은 출처의 /api/domestic-gold 프록시를 거친다.
     고시가라 하루 몇 차례만 바뀌므로 10분 간격으로만 새로 받는다.
     ────────────────────────────────────────────────────────── */
  var DOMESTIC_TTL = 10 * 60 * 1000;

  // 고시가는 1돈(3.75g) 기준으로 내려온다 — 화면 기본 단위는 1g이라 나눠 쓴다
  function perGram(don) { return don == null ? null : don / DON_G; }

  function fetchDomestic() {
    if (domestic && domestic.fetchedAt && Date.now() - domestic.fetchedAt < DOMESTIC_TTL) {
      return Promise.resolve();
    }
    return getJSON('/api/domestic-gold').then(function (d) {
      if (!d || d.error || !d.sell) throw new Error(d && d.error ? d.error : '고시가 응답 형식 오류');
      d.fetchedAt = Date.now();
      domestic = d;
      save(LS.domestic, domestic);
    });
  }

  // 차트용 일별 이력 — 하루 한 번만 받는다
  function fetchDomesticHistory() {
    if (domHist && domHist.fetchedOn === todayISO() &&
        domHist.points && domHist.points.length > 1) {
      return Promise.resolve();
    }
    return getJSON('/api/domestic-gold?range=year').then(function (d) {
      var pts = (d && d.history) || [];
      if (pts.length < 2) throw new Error('국내 시세 기록이 부족합니다');
      domHist = { fetchedOn: todayISO(), points: pts };
      save(LS.domHist, domHist);
    });
  }

  function renderDomestic() {
    if (!domestic || !domestic.sell) return;

    var buy = domestic.buy || {};
    var sell = domestic.sell;
    var prev = domestic.prevSell;

    $('dxAt').textContent = domestic.at ? domestic.at.slice(5, 16) + ' 고시' : '';

    // 1g을 크게, 1돈은 아래에 따로
    $('dxBuyPure').textContent = won(perGram(buy.pure));
    $('dxBuyPureDon').textContent = buy.pure ? '1돈(3.75g) ' + won(buy.pure) : ' ';
    $('dxBuyPureDiff').textContent = ' ';

    $('dxSellPure').textContent = won(perGram(sell.pure));
    $('dxSellPureDon').textContent = '1돈(3.75g) ' + won(sell.pure);
    appendDayDiff($('dxSellPureDiff'), '', perGram(sell.pure), perGram(prev ? prev.pure : null));

    $('dxSellSilver').textContent = won(perGram(sell.silver));
    $('dxSellSilverDon').textContent = '1돈(3.75g) ' + won(sell.silver);
    appendDayDiff($('dxSellSilverDiff'), '', perGram(sell.silver), perGram(prev ? prev.silver : null));

    // 국제 현물가와의 괴리 — 세공비가 안 붙은 '팔 때'로 비교해야 의미가 있다
    var rates = currentRates();
    var gapEl = $('dxGap');
    if (rates && rates.gold != null) {
      var intlG = rates.gold;
      var sellG = perGram(sell.pure);
      var gap = ((sellG - intlG) / intlG) * 100;
      gapEl.textContent = signedPct(gap);
      gapEl.className = 'price-value ' + clsFor(gap);
      $('dxGapSub').textContent = '국제 1g ' + won(intlG);
      $('dxGapSub2').textContent = '차액 ' + signedWon(sellG - intlG) + '/g';
    } else {
      gapEl.textContent = '—';
      gapEl.className = 'price-value';
      $('dxGapSub').textContent = ' ';
      $('dxGapSub2').textContent = ' ';
    }
  }

  // ── 렌더: 대시보드 ─────────────────────────────────────────
  function renderDashboard(s) {
    var rates = s.rates;

    $('heroValue').textContent = holdings.length ? won(s.value) : '₩0';

    var delta = $('heroDelta');
    delta.className = 'hero-delta';
    if (!holdings.length) {
      delta.textContent = '매수 기록을 추가하면 손익이 계산됩니다';
    } else if (!rates) {
      delta.textContent = '시세를 불러오면 평가액이 계산됩니다';
    } else {
      delta.textContent = signedWon(s.pl) + ' (' + signedPct(s.roi) + ')';
      delta.className = 'hero-delta ' + clsFor(s.pl);
    }

    $('statCost').textContent = won(s.cost);

    var plEl = $('statPl');
    plEl.textContent = holdings.length && rates ? signedWon(s.pl) : '—';
    plEl.className = 'stat-value ' + (rates ? clsFor(s.pl) : '');

    var roiEl = $('statRoi');
    roiEl.textContent = holdings.length && rates ? signedPct(s.roi) : '—';
    roiEl.className = 'stat-value ' + (rates ? clsFor(s.pl) : '');

    // 보유 중량
    if (s.goldGrams || s.silverGrams) {
      $('statWeight').textContent = s.goldGrams ? num(s.goldGrams, 2) + 'g' : '—';
      var sub = [];
      if (s.goldGrams)   sub.push('금 ' + num(s.goldGrams / DON_G, 2) + '돈');
      if (s.silverGrams) sub.push('은 ' + num(s.silverGrams, 1) + 'g');
      $('statWeightSub').textContent = sub.join(' · ');
    } else {
      $('statWeight').textContent = '0g';
      $('statWeightSub').textContent = ' ';
    }

    // 평균 매입가 / 본전 시세 — 금 보유분 기준
    if (s.goldGrams > 0) {
      var avgPerG = s.goldCost / s.goldGrams;
      $('statAvg').textContent = won(avgPerG);
      if (rates && rates.gold != null) {
        var gap = ((rates.gold - avgPerG) / avgPerG) * 100;
        $('statAvgSub').textContent = '현재 ' + won(rates.gold) + ' (' + signedPct(gap) + ')';
      } else {
        $('statAvgSub').textContent = ' ';
      }

      $('statBreakeven').textContent = won(avgPerG * DON_G);
      $('statBreakevenSub').textContent = rates && rates.gold != null
        ? '현재 ' + won(rates.gold * DON_G)
        : ' ';
    } else {
      $('statAvg').textContent = '—';
      $('statAvgSub').textContent = holdings.length ? '금 보유분 없음' : ' ';
      $('statBreakeven').textContent = '—';
      $('statBreakevenSub').textContent = ' ';
    }
  }

  // ── 렌더: 표 ───────────────────────────────────────────────
  function renderTable(s) {
    var body = $('tblBody');
    body.textContent = '';

    $('rowCount').textContent = holdings.length + '건';
    $('tableEmpty').hidden = holdings.length > 0;
    $('tblFoot').hidden = holdings.length === 0;

    var rows = s.rows.slice().sort(function (a, b) {
      return a.h.date < b.h.date ? 1 : a.h.date > b.h.date ? -1 : 0;
    });

    rows.forEach(function (r) {
      var h = r.h;
      var tr = document.createElement('tr');

      tr.appendChild(td(h.date));

      // 품목 + 순도 + 메모
      var metalCell = document.createElement('td');
      var tag = document.createElement('span');
      tag.className = 'tag';
      var dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.setProperty('--c', h.metal === 'silver' ? 'var(--series-1)' : 'var(--series-gold)');
      tag.appendChild(dot);
      tag.appendChild(document.createTextNode(
        METAL_LABEL[h.metal] + ' · ' + purityLabel(h.purity)
      ));
      metalCell.appendChild(tag);
      if (h.memo) {
        var memo = document.createElement('span');
        memo.className = 'memo';
        memo.textContent = h.memo;
        metalCell.appendChild(memo);
      }
      tr.appendChild(metalCell);

      tr.appendChild(td(num(h.qty, h.qty % 1 ? 2 : 0) + UNIT_LABEL[h.unit], 'num'));
      tr.appendChild(td(num(r.grams, 2) + 'g', 'num'));
      tr.appendChild(td(won(h.cost), 'num'));
      tr.appendChild(td(r.value == null ? '—' : won(r.value), 'num'));

      var plCell = td(r.pl == null ? '—' : signedWon(r.pl), 'num ' + (r.pl == null ? '' : clsFor(r.pl)));
      tr.appendChild(plCell);

      var roi = r.pl == null || h.cost <= 0 ? null : (r.pl / h.cost) * 100;
      tr.appendChild(td(roi == null ? '—' : signedPct(roi), 'num ' + (roi == null ? '' : clsFor(roi))));

      // 작업 버튼
      var actions = document.createElement('td');
      var box = document.createElement('div');
      box.className = 'rowbtns';
      box.appendChild(rowBtn('수정', 'iconbtn', function () { startEdit(h.id); }));
      box.appendChild(rowBtn('삭제', 'iconbtn del', function () { removeHolding(h.id); }));
      actions.appendChild(box);
      tr.appendChild(actions);

      body.appendChild(tr);
    });

    if (holdings.length) {
      $('sumCost').textContent  = won(s.cost);
      $('sumValue').textContent = s.rates ? won(s.value) : '—';
      $('sumPl').textContent    = s.rates ? signedWon(s.pl) : '—';
      $('sumPl').className      = 'num ' + (s.rates ? clsFor(s.pl) : '');
      $('sumRoi').textContent   = s.rates ? signedPct(s.roi) : '—';
      $('sumRoi').className     = 'num ' + (s.rates ? clsFor(s.pl) : '');
    }
  }

  function td(text, cls) {
    var el = document.createElement('td');
    el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }

  function rowBtn(label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function purityLabel(p) {
    var map = { 0.999: '24K', 0.9167: '22K', 0.925: '925', 0.75: '18K', 0.585: '14K', 1: '순도 100%' };
    return map[p] || (Math.round(p * 1000) / 10) + '%';
  }

  /* ============================================================
     차트 — 순수 SVG. 축·격자는 hairline solid, 마크는 얇게.
     ============================================================ */
  var SVGNS = 'http://www.w3.org/2000/svg';

  function svgEl(name, attrs) {
    var el = document.createElementNS(SVGNS, name);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]);
    return el;
  }

  function niceTicks(min, max, count) {
    if (!isFinite(min) || !isFinite(max)) return [];
    if (min === max) { min -= Math.abs(min) * 0.05 || 1; max += Math.abs(max) * 0.05 || 1; }
    var raw = (max - min) / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    var ticks = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(v);
    return ticks;
  }

  function fmtTime(t, spanMs) {
    var d = new Date(t);
    var p = function (n) { return String(n).padStart(2, '0'); };
    if (spanMs > 3 * 24 * 3600 * 1000) return p(d.getMonth() + 1) + '/' + p(d.getDate());
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var RANGE_LABEL = { day: '오늘', 30: '최근 1개월', 90: '최근 3개월', 365: '최근 1년' };

  function hhmm(t) {
    var d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // 오늘 고시된 국내 시세를 시간대별 포인트로 바꾼다 (원본이 시각까지 준다)
  function todayDomesticPoints() {
    if (!domestic || !domestic.today) return [];
    return domestic.today.map(function (x) {
      return {
        t: new Date(String(x.t).replace(' ', 'T')).getTime(),
        v: perGram(x.p),
        d: String(x.t).slice(0, 10)
      };
    }).filter(function (p) { return isFinite(p.t) && isFinite(p.v); });
  }

  // ── 금시세 추이 (단일 계열 + 면 워시) ───────────────────────
  function renderGoldTrend() {
    var host = $('goldTrendHost');
    var empty = $('goldTrendEmpty');
    var sub = $('goldTrendSub');
    host.textContent = '';

    var isDay = goldRange === 'day';
    var pts = [];
    var curG = domestic && domestic.sell ? perGram(domestic.sell.pure) : null;

    if (isDay) {
      pts = todayDomesticPoints();
    } else {
      if (domHist && domHist.points) {
        var cutoff = isoDaysAgo(goldRange);
        pts = domHist.points
          .filter(function (p) { return p.d >= cutoff; })
          .map(function (p) {
            return { t: new Date(p.d + 'T00:00:00').getTime(), v: perGram(p.p), d: p.d };
          });
      }

      // 이력 캐시가 오늘 것보다 오래됐을 수 있으니 현재 고시가를 마지막 점으로 얹는다
      if (pts.length && curG != null) {
        var today = todayISO();
        var live = { t: Date.now(), v: curG, d: today, live: true };
        if (pts[pts.length - 1].d >= today) pts[pts.length - 1] = live;
        else pts.push(live);
      }
    }

    if (pts.length < 2) {
      host.hidden = true;
      empty.hidden = false;
      empty.textContent = isDay
        ? '오늘 고시된 시세가 아직 한 번뿐입니다. 하루에 몇 차례만 고시되므로 오후에 다시 확인해 주세요.'
        : '국내 시세 기록을 불러오는 중…';
      return;
    }
    host.hidden = false;
    empty.hidden = true;

    // 기간 등락률
    var first = pts[0].v, last = pts[pts.length - 1].v;
    var chg = ((last - first) / first) * 100;
    sub.textContent = '';
    sub.appendChild(document.createTextNode(RANGE_LABEL[goldRange] + ' · '));
    var chgEl = document.createElement('span');
    chgEl.className = clsFor(chg);
    chgEl.textContent = signedPct(chg);
    sub.appendChild(chgEl);
    sub.appendChild(document.createTextNode(isDay ? (' · ' + hhmm(pts[0].t) + ' 이후') : (' · ' + pts[0].d + ' 이후')));

    var W = host.clientWidth || 640;
    var H = host.clientHeight || 220;
    // 시세는 만 단위로 뭉치면 흐름이 안 보인다 — 원화 전액을 그대로 쓴다
    var m = { t: 12, r: 72, b: 26, l: 66 };
    var iw = Math.max(40, W - m.l - m.r);
    var ih = Math.max(40, H - m.t - m.b);

    var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    if (t1 === t0) t1 = t0 + 1;

    var lo = Infinity, hi = -Infinity;
    pts.forEach(function (p) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); });
    var pad = (hi - lo) * 0.12 || hi * 0.02;
    lo -= pad; hi += pad;

    var X = function (t) { return m.l + ((t - t0) / (t1 - t0)) * iw; };
    var Y = function (v) { return m.t + ih - ((v - lo) / (hi - lo)) * ih; };

    var svg = svgEl('svg', {
      width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
      role: 'img', 'aria-label': RANGE_LABEL[goldRange] + ' 국내 순금 1g 시세 추이 (팔 때 기준)'
    });

    niceTicks(lo, hi, 4).forEach(function (v) {
      var y = Y(v);
      svg.appendChild(svgEl('line', {
        x1: m.l, x2: m.l + iw, y1: y, y2: y,
        stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges'
      }));
      var lb = svgEl('text', {
        x: m.l - 9, y: y + 4, 'text-anchor': 'end',
        fill: 'var(--text-muted)', 'font-size': 11
      });
      lb.textContent = num(v, 0);
      svg.appendChild(lb);
    });

    svg.appendChild(svgEl('line', {
      x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih,
      stroke: 'var(--axis)', 'stroke-width': 1, 'shape-rendering': 'crispEdges'
    }));

    var spanDays = (t1 - t0) / 864e5;
    var xTicks = Math.max(2, Math.min(6, Math.floor(iw / 82)));
    for (var i = 0; i <= xTicks; i++) {
      var tt = t0 + ((t1 - t0) * i) / xTicks;
      var lbx = svgEl('text', {
        x: X(tt), y: m.t + ih + 16,
        'text-anchor': i === 0 ? 'start' : i === xTicks ? 'end' : 'middle',
        fill: 'var(--text-muted)', 'font-size': 11
      });
      lbx.textContent = isDay ? hhmm(tt) : fmtDay(tt, spanDays);
      svg.appendChild(lbx);
    }

    var line = pts.map(function (p, k) {
      return (k ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.v).toFixed(1);
    }).join(' ');

    // 면은 워시로만 — 채도 높은 블록이 되지 않게
    svg.appendChild(svgEl('path', {
      d: line + ' L' + X(t1).toFixed(1) + ' ' + (m.t + ih) + ' L' + X(t0).toFixed(1) + ' ' + (m.t + ih) + ' Z',
      fill: 'var(--series-gold)', opacity: 0.10, stroke: 'none'
    }));
    svg.appendChild(svgEl('path', {
      d: line, fill: 'none', stroke: 'var(--series-gold)', 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }));

    var end = pts[pts.length - 1];
    svg.appendChild(svgEl('circle', {
      cx: X(end.t), cy: Y(end.v), r: 4,
      fill: 'var(--series-gold)', stroke: 'var(--surface-1)', 'stroke-width': 2
    }));
    var endLb = svgEl('text', {
      x: Math.min(W - 4, X(end.t) + 9), y: Y(end.v) + 4,
      fill: 'var(--text-primary)', 'font-size': 11.5, 'font-weight': 600
    });
    endLb.textContent = won(end.v);
    svg.appendChild(endLb);

    var cross = svgEl('line', {
      y1: m.t, y2: m.t + ih, stroke: 'var(--axis)', 'stroke-width': 1,
      'shape-rendering': 'crispEdges', opacity: 0
    });
    svg.appendChild(cross);
    var dot = svgEl('circle', {
      r: 4.5, fill: 'var(--series-gold)', stroke: 'var(--surface-1)', 'stroke-width': 2, opacity: 0
    });
    svg.appendChild(dot);

    var hit = svgEl('rect', {
      x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent', style: 'cursor:crosshair'
    });
    svg.appendChild(hit);

    function showAt(clientX, clientY) {
      var box = svg.getBoundingClientRect();
      var target = t0 + ((clientX - box.left - m.l) / iw) * (t1 - t0);
      var best = 0, bestD = Infinity;
      for (var k = 0; k < pts.length; k++) {
        var dd = Math.abs(pts[k].t - target);
        if (dd < bestD) { bestD = dd; best = k; }
      }
      var p = pts[best];
      var x = X(p.t);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('opacity', 1);
      dot.setAttribute('cx', x); dot.setAttribute('cy', Y(p.v)); dot.setAttribute('opacity', 1);

      showTooltip(clientX, clientY, isDay ? (p.d + ' ' + hhmm(p.t)) : (p.d + (p.live ? ' (현재 고시)' : '')), [
        { color: 'var(--series-gold)', key: '1g 팔 때', val: won(p.v) },
        { color: null, key: '1돈', val: won(p.v * DON_G) }
      ]);
    }

    hit.addEventListener('mousemove', function (e) { showAt(e.clientX, e.clientY); });
    hit.addEventListener('mouseleave', function () {
      cross.setAttribute('opacity', 0);
      dot.setAttribute('opacity', 0);
      hideTooltip();
    });
    hit.addEventListener('touchmove', function (e) {
      showAt(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    hit.addEventListener('touchend', hideTooltip);

    host.appendChild(svg);
  }

  function fmtDay(t, spanDays) {
    var d = new Date(t);
    var p = function (n) { return String(n).padStart(2, '0'); };
    if (spanDays > 120) return String(d.getFullYear()).slice(2) + '.' + p(d.getMonth() + 1);
    return p(d.getMonth() + 1) + '/' + p(d.getDate());
  }

  // ── 자산 추이 (라인 2계열 + 크로스헤어 툴팁) ────────────────
  function renderTrend() {
    var host = $('trendHost');
    var empty = $('trendEmpty');
    var pts = trendSeries();

    host.textContent = '';

    if (pts.length < 2) {
      host.hidden = true;
      empty.hidden = false;
      empty.textContent = holdings.length
        ? '시세 스냅샷이 ' + pts.length + '개 기록됐습니다. 두 개부터 추이가 그려집니다 — 새로고침할 때마다(자동 1분) 한 점씩 쌓입니다.'
        : '매수 기록을 추가하면 자산 추이가 그려집니다.';
      $('trendLegend').hidden = true;
      return;
    }

    host.hidden = false;
    empty.hidden = true;
    $('trendLegend').hidden = false;

    var W = host.clientWidth || 640;
    var H = host.clientHeight || 260;
    var m = { t: 12, r: 54, b: 26, l: 58 };
    var iw = Math.max(40, W - m.l - m.r);
    var ih = Math.max(40, H - m.t - m.b);

    var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    if (t1 === t0) t1 = t0 + 1;

    var lo = Infinity, hi = -Infinity;
    pts.forEach(function (p) {
      lo = Math.min(lo, p.value, p.cost);
      hi = Math.max(hi, p.value, p.cost);
    });
    var pad = (hi - lo) * 0.12 || Math.max(hi * 0.02, 1);
    lo -= pad; hi += pad;

    var X = function (t) { return m.l + ((t - t0) / (t1 - t0)) * iw; };
    var Y = function (v) { return m.t + ih - ((v - lo) / (hi - lo)) * ih; };

    var svg = svgEl('svg', {
      width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
      role: 'img', 'aria-label': '보유 자산의 평가액과 투자 원금 추이'
    });

    // 가로 격자 + y축 눈금
    niceTicks(lo, hi, 4).forEach(function (v) {
      var y = Y(v);
      svg.appendChild(svgEl('line', {
        x1: m.l, x2: m.l + iw, y1: y, y2: y,
        stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges'
      }));
      var lb = svgEl('text', {
        x: m.l - 9, y: y + 4, 'text-anchor': 'end',
        fill: 'var(--text-muted)', 'font-size': 11
      });
      lb.textContent = compactWon(v);
      svg.appendChild(lb);
    });

    // x축
    svg.appendChild(svgEl('line', {
      x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih,
      stroke: 'var(--axis)', 'stroke-width': 1, 'shape-rendering': 'crispEdges'
    }));

    var span = t1 - t0;
    var xTickCount = Math.max(2, Math.min(5, Math.floor(iw / 90)));
    for (var i = 0; i <= xTickCount; i++) {
      var tt = t0 + (span * i) / xTickCount;
      var lbx = svgEl('text', {
        x: X(tt), y: m.t + ih + 16,
        'text-anchor': i === 0 ? 'start' : i === xTickCount ? 'end' : 'middle',
        fill: 'var(--text-muted)', 'font-size': 11
      });
      lbx.textContent = fmtTime(tt, span);
      svg.appendChild(lbx);
    }

    var series = [
      { key: 'value', color: 'var(--series-1)', label: '평가액' },
      { key: 'cost',  color: 'var(--series-2)', label: '투자 원금' }
    ];

    series.forEach(function (se) {
      var d = pts.map(function (p, i) {
        return (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p[se.key]).toFixed(1);
      }).join(' ');
      svg.appendChild(svgEl('path', {
        d: d, fill: 'none', stroke: se.color, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }));
    });

    // 끝점 마커 — 2px 서피스 링
    var last = pts[pts.length - 1];
    series.forEach(function (se) {
      svg.appendChild(svgEl('circle', {
        cx: X(last.t), cy: Y(last[se.key]), r: 4,
        fill: se.color, stroke: 'var(--surface-1)', 'stroke-width': 2
      }));
    });

    // 직접 라벨은 '평가액' 끝점 하나만
    var endLb = svgEl('text', {
      x: Math.min(W - 4, X(last.t) + 9), y: Y(last.value) + 4,
      fill: 'var(--text-primary)', 'font-size': 11.5, 'font-weight': 600
    });
    endLb.textContent = compactWon(last.value);
    svg.appendChild(endLb);

    // 크로스헤어 (호버 시에만 표시)
    var cross = svgEl('line', {
      y1: m.t, y2: m.t + ih, stroke: 'var(--axis)', 'stroke-width': 1,
      'shape-rendering': 'crispEdges', opacity: 0
    });
    svg.appendChild(cross);

    var hoverDots = series.map(function (se) {
      var c = svgEl('circle', {
        r: 4.5, fill: se.color, stroke: 'var(--surface-1)', 'stroke-width': 2, opacity: 0
      });
      svg.appendChild(c);
      return c;
    });

    var hit = svgEl('rect', {
      x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent', style: 'cursor:crosshair'
    });
    svg.appendChild(hit);

    function nearest(clientX) {
      var box = svg.getBoundingClientRect();
      var px = clientX - box.left;
      var target = t0 + ((px - m.l) / iw) * (t1 - t0);
      var best = 0, bestD = Infinity;
      for (var i = 0; i < pts.length; i++) {
        var d = Math.abs(pts[i].t - target);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    function showAt(i, clientX, clientY) {
      var p = pts[i];
      var x = X(p.t);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('opacity', 1);
      hoverDots[0].setAttribute('cx', x); hoverDots[0].setAttribute('cy', Y(p.value)); hoverDots[0].setAttribute('opacity', 1);
      hoverDots[1].setAttribute('cx', x); hoverDots[1].setAttribute('cy', Y(p.cost));  hoverDots[1].setAttribute('opacity', 1);

      var pl = p.value - p.cost;
      var roi = p.cost > 0 ? (pl / p.cost) * 100 : NaN;
      var when = new Date(p.t);
      showTooltip(clientX, clientY,
        when.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        [
          { color: 'var(--series-1)', key: '평가액', val: won(p.value) },
          { color: 'var(--series-2)', key: '원금',   val: won(p.cost) },
          { color: null,              key: '손익',   val: signedWon(pl) + ' (' + signedPct(roi) + ')' }
        ]);
    }

    function hide() {
      cross.setAttribute('opacity', 0);
      hoverDots.forEach(function (c) { c.setAttribute('opacity', 0); });
      hideTooltip();
    }

    hit.addEventListener('mousemove', function (e) { showAt(nearest(e.clientX), e.clientX, e.clientY); });
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('touchmove', function (e) {
      var t = e.touches[0];
      showAt(nearest(t.clientX), t.clientX, t.clientY);
    }, { passive: true });
    hit.addEventListener('touchend', hide);

    host.appendChild(svg);
  }

  // ── 건별 수익률 (0 기준 발산형 가로 막대) ──────────────────
  function renderLots(s) {
    var host = $('lotsHost');
    var empty = $('lotsEmpty');
    var card = $('lotsCard');
    host.textContent = '';

    var rows = s.rows.filter(function (r) { return r.pl != null && r.h.cost > 0; })
      .map(function (r) {
        return {
          label: r.h.date.slice(5) + ' ' + METAL_LABEL[r.h.metal],
          roi: (r.pl / r.h.cost) * 100,
          pl: r.pl,
          cost: r.h.cost,
          value: r.value,
          memo: r.h.memo || ''
        };
      })
      .sort(function (a, b) { return b.roi - a.roi; });

    // 막대 1개짜리 차트는 만들지 않는다 — 숫자가 이미 표에 있다
    if (rows.length < 2) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    empty.hidden = true;

    var W = host.clientWidth || 640;
    var band = 32;
    var barH = 20;

    // 값 라벨은 늘 막대 바깥에 붙으므로, 부호가 실제로 존재하는 쪽에만 여백을 준다
    var CAT_W = 78, VAL_W = 60;
    var hasNeg = rows.some(function (r) { return r.roi < 0; });
    var hasPos = rows.some(function (r) { return r.roi > 0; });
    var m = {
      t: 10, b: 18,
      l: CAT_W + 12 + (hasNeg ? VAL_W : 6),
      r: (hasPos ? VAL_W : 6) + 8
    };
    var H = m.t + m.b + band * rows.length;
    host.style.height = H + 'px';

    var iw = Math.max(60, W - m.l - m.r);

    // 0을 반드시 포함하되, 한쪽만 있으면 그쪽으로만 눈금을 편다
    var lo = Math.min(0, rows[rows.length - 1].roi);
    var hi = Math.max(0, rows[0].roi);
    var pad = (hi - lo) * 0.04 || 1;
    lo -= hasNeg ? pad : 0;
    hi += hasPos ? pad : 0;
    var X = function (v) { return m.l + ((v - lo) / (hi - lo)) * iw; };

    var svg = svgEl('svg', {
      width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
      role: 'img', 'aria-label': '매수 건별 수익률'
    });

    // 0 기준선
    svg.appendChild(svgEl('line', {
      x1: X(0), x2: X(0), y1: m.t, y2: H - m.b,
      stroke: 'var(--axis)', 'stroke-width': 1, 'shape-rendering': 'crispEdges'
    }));

    rows.forEach(function (r, i) {
      var y = m.t + i * band + (band - barH) / 2;
      var x0 = X(0), x1 = X(r.roi);
      var isPos = r.roi >= 0;
      var color = r.roi > 0.0001 ? 'var(--up)' : r.roi < -0.0001 ? 'var(--down)' : 'var(--axis)';

      // 0에 가까운 값도 행이 비어 보이지 않게 최소 2px는 그린다
      if (Math.abs(x1 - x0) < 2) x1 = x0 + (isPos ? 2 : -2);

      svg.appendChild(svgEl('path', {
        d: hBarPath(x0, x1, y, barH, 4), fill: color
      }));

      // 카테고리 라벨 (텍스트는 잉크 토큰만)
      var lb = svgEl('text', {
        x: CAT_W, y: y + barH / 2 + 4, 'text-anchor': 'end',
        fill: 'var(--text-secondary)', 'font-size': 11.5
      });
      lb.textContent = r.label;
      svg.appendChild(lb);

      // 값 라벨 — 막대 바깥 끝에
      var vl = svgEl('text', {
        x: isPos ? x1 + 8 : x1 - 8, y: y + barH / 2 + 4,
        'text-anchor': isPos ? 'start' : 'end',
        fill: 'var(--text-primary)', 'font-size': 11.5, 'font-weight': 600
      });
      vl.textContent = signedPct(r.roi);
      svg.appendChild(vl);

      // 호버 히트 영역 — 밴드 전체 (24px 이상 확보)
      var hit = svgEl('rect', {
        x: 0, y: m.t + i * band, width: W, height: band,
        fill: 'transparent', style: 'cursor:default'
      });
      hit.addEventListener('mousemove', function (e) {
        showTooltip(e.clientX, e.clientY, r.label + (r.memo ? ' · ' + r.memo : ''), [
          { color: null, key: '매수금액', val: won(r.cost) },
          { color: null, key: '평가액',   val: won(r.value) },
          { color: color, key: '손익',    val: signedWon(r.pl) }
        ]);
      });
      hit.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(hit);
    });

    host.appendChild(svg);
  }

  // 기준선에서 자라는 가로 막대: 데이터 끝만 4px 라운드
  function hBarPath(xZero, xEnd, y, h, r) {
    var right = xEnd >= xZero;
    var w = Math.abs(xEnd - xZero);
    var rr = Math.min(r, w, h / 2);
    var x = Math.min(xZero, xEnd);
    if (right) {
      return 'M' + x + ' ' + y +
             'H' + (x + w - rr) + 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + rr) +
             'V' + (y + h - rr) + 'Q' + (x + w) + ' ' + (y + h) + ' ' + (x + w - rr) + ' ' + (y + h) +
             'H' + x + 'Z';
    }
    return 'M' + (x + w) + ' ' + y +
           'H' + (x + rr) + 'Q' + x + ' ' + y + ' ' + x + ' ' + (y + rr) +
           'V' + (y + h - rr) + 'Q' + x + ' ' + (y + h) + ' ' + (x + rr) + ' ' + (y + h) +
           'H' + (x + w) + 'Z';
  }

  // ── 툴팁 ───────────────────────────────────────────────────
  function showTooltip(clientX, clientY, title, rows) {
    var tip = $('tooltip');
    tip.textContent = '';

    var t = document.createElement('div');
    t.className = 'tt-title';
    t.textContent = title;
    tip.appendChild(t);

    rows.forEach(function (r) {
      var line = document.createElement('div');
      line.className = 'tt-row';

      var key = document.createElement('span');
      key.className = 'tt-key';
      if (r.color) {
        var sw = document.createElement('span');
        sw.className = 'swatch swatch-box';
        sw.style.setProperty('--c', r.color);
        key.appendChild(sw);
      }
      key.appendChild(document.createTextNode(r.key));

      var val = document.createElement('span');
      val.className = 'tt-val';
      val.textContent = r.val;

      line.appendChild(key);
      line.appendChild(val);
      tip.appendChild(line);
    });

    tip.hidden = false;
    var box = tip.getBoundingClientRect();
    var x = clientX + 14;
    var y = clientY - box.height - 12;
    if (x + box.width > window.innerWidth - 8) x = clientX - box.width - 14;
    if (y < 8) y = clientY + 18;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = y + 'px';
  }

  function hideTooltip() { $('tooltip').hidden = true; }

  // ── 폼 ─────────────────────────────────────────────────────
  function readForm() {
    var qty = parseFloat($('fQty').value);
    var cost = parseFloat($('fCost').value);
    return {
      date:   $('fDate').value,
      metal:  $('fMetal').value,
      purity: parseFloat($('fPurity').value),
      qty:    qty,
      unit:   $('fUnit').value,
      cost:   cost,
      memo:   $('fMemo').value.trim().slice(0, 60)
    };
  }

  function updateFormHint() {
    var f = readForm();
    var hint = $('formHint');
    if (!(f.qty > 0)) { hint.textContent = ' '; return; }

    var grams = f.qty * (UNIT_G[f.unit] || 1) * f.purity;
    var parts = ['순' + METAL_LABEL[f.metal] + ' ' + num(grams, 2) + 'g 환산'];
    if (f.metal === 'gold') parts.push(num(grams / DON_G, 3) + '돈');
    if (f.cost > 0) parts.push('1g당 ' + won(f.cost / grams));

    var rates = currentRates();
    var r = rateFor(rates, f.metal);
    if (r != null && f.cost > 0) {
      var v = grams * r;
      parts.push('현 시세 평가 ' + won(v) + ' (' + signedPct(((v - f.cost) / f.cost) * 100) + ')');
    }
    hint.textContent = parts.join(' · ');
  }

  function resetForm() {
    editingId = null;
    $('editId').value = '';
    $('buyForm').reset();
    $('fDate').value = todayISO();
    $('submitBtn').textContent = '기록 추가';
    $('cancelEdit').hidden = true;
    updateFormHint();
  }

  function startEdit(id) {
    var h = holdings.filter(function (x) { return x.id === id; })[0];
    if (!h) return;
    editingId = id;
    $('editId').value = id;
    $('fDate').value = h.date;
    $('fMetal').value = h.metal;
    $('fPurity').value = String(h.purity);
    $('fQty').value = h.qty;
    $('fUnit').value = h.unit;
    $('fCost').value = h.cost;
    $('fMemo').value = h.memo || '';
    $('submitBtn').textContent = '수정 저장';
    $('cancelEdit').hidden = false;
    updateFormHint();
    $('buyForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('fQty').focus();
  }

  function removeHolding(id) {
    syncHoldings();
    var h = holdings.filter(function (x) { return x.id === id; })[0];
    if (!h) return;
    if (!confirm(h.date + ' ' + METAL_LABEL[h.metal] + ' ' + h.qty + UNIT_LABEL[h.unit] +
                 ' 기록을 삭제할까요?')) return;
    holdings = holdings.filter(function (x) { return x.id !== id; });
    save(LS.holdings, holdings);
    if (editingId === id) resetForm();
    renderAll();
  }

  function submitForm(e) {
    e.preventDefault();
    var f = readForm();

    if (!f.date) { alert('매수일을 입력해 주세요.'); return; }
    if (!(f.qty > 0)) { alert('수량은 0보다 커야 합니다.'); return; }
    if (!(f.cost >= 0)) { alert('매수 금액을 확인해 주세요.'); return; }

    syncHoldings();
    if (editingId) {
      holdings = holdings.map(function (h) {
        return h.id === editingId ? Object.assign({}, h, f, { id: editingId }) : h;
      });
    } else {
      f.id = uid();
      holdings.push(f);
    }
    save(LS.holdings, holdings);
    resetForm();
    renderAll();
  }

  // ── 가져오기 / 내보내기 ────────────────────────────────────
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function stamp() { return todayISO().replace(/-/g, ''); }

  function exportJson() {
    download('gold-holdings-' + stamp() + '.json',
      JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), holdings: holdings }, null, 2),
      'application/json');
  }

  function exportCsv() {
    var s = summarize();
    var head = ['매수일', '품목', '순도', '수량', '단위', '순물질(g)', '매수금액', '평가액', '손익', '수익률(%)', '메모'];
    var lines = [head.join(',')];

    s.rows.forEach(function (r) {
      var roi = r.pl == null || r.h.cost <= 0 ? '' : (r.pl / r.h.cost * 100).toFixed(2);
      lines.push([
        r.h.date, METAL_LABEL[r.h.metal], purityLabel(r.h.purity), r.h.qty, UNIT_LABEL[r.h.unit],
        r.grams.toFixed(3), Math.round(r.h.cost),
        r.value == null ? '' : Math.round(r.value),
        r.pl == null ? '' : Math.round(r.pl),
        roi, csvCell(r.h.memo || '')
      ].join(','));
    });

    download('gold-holdings-' + stamp() + '.csv', '﻿' + lines.join('\r\n'), 'text/csv');
  }

  function csvCell(v) {
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result));
        var list = Array.isArray(data) ? data : data.holdings;
        if (!Array.isArray(list)) throw new Error('holdings 배열을 찾을 수 없습니다');

        var clean = list.map(function (h) {
          return {
            id:     typeof h.id === 'string' ? h.id : uid(),
            date:   String(h.date || todayISO()).slice(0, 10),
            metal:  h.metal === 'silver' ? 'silver' : 'gold',
            purity: Number(h.purity) > 0 ? Number(h.purity) : 0.999,
            qty:    Number(h.qty) || 0,
            unit:   UNIT_G[h.unit] ? h.unit : 'g',
            cost:   Number(h.cost) || 0,
            memo:   String(h.memo || '').slice(0, 60)
          };
        }).filter(function (h) { return h.qty > 0; });

        if (!clean.length) throw new Error('가져올 수 있는 기록이 없습니다');

        syncHoldings();
        var mode = holdings.length
          ? confirm('기존 ' + holdings.length + '건에 ' + clean.length + '건을 추가할까요?\n' +
                    '[취소]를 누르면 기존 기록을 모두 대체합니다.')
          : true;

        holdings = mode ? holdings.concat(clean) : clean;
        save(LS.holdings, holdings);
        renderAll();
        banner('');
      } catch (err) {
        alert('가져오기에 실패했습니다: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ── 테마 ───────────────────────────────────────────────────
  function applyTheme(mode) {
    if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
    else document.documentElement.removeAttribute('data-theme');
  }

  function toggleTheme() {
    var cur = localStorage.getItem(LS.theme);
    var dark = cur ? cur === 'dark'
                   : window.matchMedia('(prefers-color-scheme: dark)').matches;
    var next = dark ? 'light' : 'dark';
    localStorage.setItem(LS.theme, next);
    applyTheme(next);
    renderCharts();
  }

  // ── 렌더 오케스트레이션 ────────────────────────────────────
  var lastSummary = null;

  function renderAll() {
    renderPrices();
    renderDomestic();
    lastSummary = summarize();
    renderDashboard(lastSummary);
    renderTable(lastSummary);
    renderCharts();
  }

  function renderCharts() {
    if (!lastSummary) lastSummary = summarize();
    renderGoldTrend();
    renderTrend();
    renderLots(lastSummary);
  }

  // ── 초기화 ─────────────────────────────────────────────────
  function init() {
    applyTheme(localStorage.getItem(LS.theme));
    $('fDate').value = todayISO();

    $('buyForm').addEventListener('submit', submitForm);
    $('cancelEdit').addEventListener('click', resetForm);
    ['fQty', 'fUnit', 'fPurity', 'fCost', 'fMetal'].forEach(function (id) {
      $(id).addEventListener('input', updateFormHint);
      $(id).addEventListener('change', updateFormHint);
    });

    $('refreshBtn').addEventListener('click', function () { refreshPrices(true); });
    $('themeBtn').addEventListener('click', toggleTheme);

    Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var r = btn.getAttribute('data-range');
        goldRange = r === 'day' ? 'day' : parseInt(r, 10);
        Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (b) {
          b.classList.toggle('is-on', b === btn);
        });
        renderGoldTrend();
      });
    });

    $('exportJson').addEventListener('click', exportJson);
    $('exportCsv').addEventListener('click', exportCsv);
    $('importBtn').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importJson(e.target.files[0]);
      e.target.value = '';
    });

    $('resetAll').addEventListener('click', function () {
      if (!confirm('매수 기록과 시세 스냅샷을 모두 삭제합니다. 되돌릴 수 없습니다.\n계속할까요?')) return;
      holdings = []; snapshots = [];
      save(LS.holdings, holdings);
      save(LS.snapshots, snapshots);
      resetForm();
      renderAll();
    });

    // 폭이 바뀌면 차트만 다시 그린다
    var rerender = debounce(renderCharts, 140);
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(rerender);
      ro.observe($('goldTrendHost'));
      ro.observe($('trendHost'));
      ro.observe($('lotsHost'));
    } else {
      window.addEventListener('resize', rerender);
    }

    // 다크/라이트 시스템 설정 변경 → 차트 색 재적용
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', renderCharts);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshPrices(false);
    });

    // 다른 탭에서 기록이 바뀌면 따라간다
    window.addEventListener('storage', function (e) {
      if (e.key === LS.holdings)  { holdings  = load(LS.holdings, holdings); renderAll(); }
      if (e.key === LS.snapshots) { snapshots = load(LS.snapshots, snapshots); renderCharts(); }
    });

    renderAll();
    refreshPrices(false);

    fetchDomestic()
      .then(function () { renderDomestic(); renderGoldTrend(); })
      .catch(function (err) {
        $('dxAt').textContent = '불러오지 못함';
        console.warn('국내 시세', err);
      });

    fetchDomesticHistory()
      .then(renderGoldTrend)
      .catch(function (err) {
        $('goldTrendHost').hidden = true;
        $('goldTrendEmpty').hidden = false;
        $('goldTrendEmpty').textContent =
          '국내 과거 시세를 불러오지 못했습니다 (' + err.message + '). 아래 현재 시세는 정상입니다.';
        $('goldTrendSub').textContent = '—';
      });

    // NBP 이력은 이제 차트가 아니라 '국제 시세 전일 대비'에만 쓰인다.
    // 실패해도 국내 차트를 건드리면 안 된다.
    fetchGoldHistory()
      .then(renderPrices)
      .catch(function (err) { console.warn('국제 과거 시세', err); });

    refreshTimer = setInterval(function () {
      if (!document.hidden) refreshPrices(false);
    }, REFRESH_MS);
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
