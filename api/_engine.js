/* Shared server-side engine for the BTC regime monitor.
   NOTE: the browser page carries its own inline copy of this logic so it keeps
   working when opened straight off disk. Thresholds are read from the same
   config.json by both, so parameters cannot drift; the code paths can. Any
   change to a rule must be made in both places. */

const SPOT = "https://api.binance.com";
const FAPI = "https://fapi.binance.com";

async function j(url, key, opts){
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(key + " HTTP " + r.status);
  return r.json();
}
const closes = k => k.map(r => +r[4]);
const highs  = k => k.map(r => +r[2]);
const lows   = k => k.map(r => +r[3]);

function sma(a, n){
  const o = new Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++){ s += a[i]; if (i >= n) s -= a[i-n]; if (i >= n-1) o[i] = s/n; }
  return o;
}
const rollingMean = sma;
function pctRank(w, v){ if (!w.length) return null; let c = 0; for (const x of w) if (x < v) c++; return 100*c/w.length; }
function stdev(a){
  if (a.length < 2) return null;
  const m = a.reduce((x,y)=>x+y,0)/a.length;
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1));
}
function pivots(hi, lo, n){
  const ph = [], pl = [];
  for (let i = n; i < hi.length - n; i++){
    let isH = true, isL = true;
    for (let j = i-n; j <= i+n; j++){
      if (j === i) continue;
      if (hi[j] >= hi[i]) isH = false;
      if (lo[j] <= lo[i]) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) ph.push({ i, v: hi[i] });
    if (isL) pl.push({ i, v: lo[i] });
  }
  return { highs: ph, lows: pl };
}
function structureState(p){
  const H = p.highs, L = p.lows;
  if (H.length < 2 || L.length < 2) return "TRANSITION";
  const h1 = H[H.length-1].v, h0 = H[H.length-2].v;
  const l1 = L[L.length-1].v, l0 = L[L.length-2].v;
  if (h1 > h0 && l1 > l0) return "HH_HL";
  if (h1 < h0 && l1 < l0) return "LH_LL";
  return "TRANSITION";
}

async function gather(){
  const now = Date.now();
  const [daily, weekly, perp, oiHist, oiNow, prem, tick, lsr, taker] = await Promise.all([
    j(SPOT + "/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=1000", "spot1d"),
    j(SPOT + "/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=1000", "spot1w"),
    j(FAPI + "/fapi/v1/klines?symbol=BTCUSDT&interval=1d&limit=500", "perp1d"),
    j(FAPI + "/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=500", "oiHist"),
    j(FAPI + "/fapi/v1/openInterest?symbol=BTCUSDT", "oiNow"),
    j(FAPI + "/fapi/v1/premiumIndex?symbol=BTCUSDT", "premium"),
    j(SPOT + "/api/v3/ticker/24hr?symbol=BTCUSDT", "ticker"),
    j(FAPI + "/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1d&limit=30", "lsr"),
    j(FAPI + "/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=1d&limit=30", "taker"),
  ]);
  let funding = [], cursor = now - 760*86400000;
  for (let i = 0; i < 6; i++){
    const page = await j(FAPI + "/fapi/v1/fundingRate?symbol=BTCUSDT&startTime=" + cursor + "&limit=1000", "funding");
    if (!page.length) break;
    funding = funding.concat(page);
    if (page.length < 1000) break;
    cursor = page[page.length-1].fundingTime + 1;
  }
  return { daily, weekly, perp, oiHist, oiNow, prem, tick, lsr, taker, funding };
}

function compute(D, CFG){
  const cl = closes(D.daily), t = D.daily.map(r => r[0]);
  const last = cl.length - 1;
  const ma = sma(cl, CFG.maLen), ma50 = sma(cl, 50);

  const lr = [];
  for (let i = 1; i < cl.length; i++) lr.push(Math.log(cl[i]/cl[i-1]));
  const rvSeries = new Array(cl.length).fill(null);
  for (let i = CFG.rvLen; i < cl.length; i++){
    const sd = stdev(lr.slice(i-CFG.rvLen, i));
    rvSeries[i] = sd === null ? null : sd*Math.sqrt(365)*100;
  }
  const rv = rvSeries[last];
  const rvWin = rvSeries.slice(Math.max(0,last-CFG.pctWindowDays), last).filter(x => x !== null);

  const rates = D.funding.map(x => +x.fundingRate);
  const perDay = 3;
  const mS = rollingMean(rates, CFG.fundShort*perDay);
  const mL = rollingMean(rates, CFG.fundLong*perDay);
  const fl = rates.length - 1, winN = CFG.pctWindowDays*perDay;
  const f7Pct  = pctRank(mS.slice(Math.max(0,fl-winN), fl).filter(x=>x!==null), mS[fl]);
  const f30Pct = pctRank(mL.slice(Math.max(0,fl-winN), fl).filter(x=>x!==null), mL[fl]);

  const oi = D.oiHist.map(x => +x.sumOpenInterest);
  const ol = oi.length - 1;
  const oi20 = oi.length > CFG.oiLookback ? (oi[ol]/oi[ol-CFG.oiLookback]-1)*100 : null;

  const struct = structureState(pivots(highs(D.weekly), lows(D.weekly), CFG.pivotN));
  const px = cl[last];
  const ret20 = (px/cl[last-CFG.retLookback]-1)*100;
  const aboveMA = px > ma[last];
  const maSlopeUp = ma[last] - ma[last-CFG.maSlopeLookback] > 0;
  const spotLed = ret20 > 0 && f30Pct < CFG.fundCoolPct && oi20 <= 0;

  const rules = {
    EARLY_UPTREND: aboveMA && spotLed && f30Pct < CFG.fundCoolPct && struct !== "LH_LL",
    CONFIRMED_UPTREND: aboveMA && maSlopeUp && struct === "HH_HL"
      && f30Pct < CFG.fundConfirmMaxPct && f7Pct < CFG.fundHotPct && oi20 > 0,
    LATE_UPTREND: aboveMA && ret20 > 0
      && (f7Pct >= CFG.fundHotPct || f30Pct >= CFG.fundHotPct) && oi20 > CFG.oiHotPct,
    DOWNTREND: !aboveMA && (!maSlopeUp || struct === "LH_LL"),
  };
  let state = "CONFLICTED";
  for (const k of ["EARLY_UPTREND","CONFIRMED_UPTREND","LATE_UPTREND","DOWNTREND"]) if (rules[k]) { state = k; break; }

  const ls = D.lsr.length ? +D.lsr[D.lsr.length-1].longShortRatio : null;
  const tk = D.taker.length ? +D.taker[D.taker.length-1].buySellRatio : null;

  const L1 = { fundingHot: f7Pct >= CFG.fundHotPct || f30Pct >= CFG.fundHotPct,
               oiSurge: oi20 > CFG.oiHotPct,
               lsOneSided: ls != null ? ls > CFG.lsRatioHot : null };
  const L2 = { takerSellSide: tk != null ? tk < 1 : null };
  const L3 = { belowMA200: !aboveMA, maSlopeNeg: !maSlopeUp,
               weeklyLHLL: struct === "LH_LL",
               below50: ma50[last] != null ? px < ma50[last] : null };

  const n = o => Object.values(o).filter(v => v === true).length;
  const supporting = L3.maSlopeNeg || L3.weeklyLHLL || L3.below50;
  let level = 0;
  if (L3.belowMA200 && supporting) level = 3;
  else if (n(L2) >= CFG.tierL2Arm || n(L3) >= 1) level = 2;
  else if (n(L1) >= CFG.tierL1Arm || n(L2) >= 1) level = 1;

  return {
    asOf: new Date().toISOString(),
    lastDailyClose: new Date(t[last]).toISOString(),
    state,
    rules,
    tier: { level, name: ["none","early_warning","confirming","confirmed_break"][level],
            L1, L2, L3, votes: { L1: n(L1), L2: n(L2), L3: n(L3) } },
    indicators: {
      price: px, ma200: ma[last], ma50: ma50[last],
      priceToMa200Pct: (px/ma[last]-1)*100,
      ma200Slope20Pct: (ma[last]/ma[last-CFG.maSlopeLookback]-1)*100,
      return20Pct: ret20,
      weeklyStructure: struct,
      funding7Pct: f7Pct, funding30Pct: f30Pct,
      funding7AnnPct: mS[fl]*perDay*365*100, funding30AnnPct: mL[fl]*perDay*365*100,
      openInterestBTC: +D.oiNow.openInterest, oiChange20Pct: oi20,
      realizedVol30: rv, realizedVolPct: pctRank(rvWin, rv),
      longShortRatio: ls, takerBuySellRatio: tk,
      spotLed,
    },
    caveats: [
      "Single-venue Binance data. Not the aggregate market.",
      "Open interest history is capped at 30 days by the public endpoint.",
      "Thresholds are choices, not validated parameters.",
      "State description only — not a forecast, target or recommendation.",
    ],
  };
}

module.exports = { gather, compute };
// test seam: tests/run.js asserts these agree with the page's own copies
module.exports.__internals = { sma, pctRank, stdev, pivots, structureState, closes };
