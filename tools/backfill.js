/* Stage 3 historical validation.
   Replays the classifier over every day for which all inputs exist, then
   reports forward-return distributions, INDEPENDENT episode counts, and a
   transition matrix. Thresholds are read from config.json and never adjusted
   in response to what comes out — if a state shows no separation from
   baseline, that is the finding.

   Run:  node tools/backfill.js     (writes validation.json) */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SPOT = "https://api.binance.com", FAPI = "https://fapi.binance.com";
const VISION = "https://data.binance.vision";
const CACHE = path.join(__dirname, "cache");
const DAY = 86400000;

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));

const log = (...a) => process.stderr.write(a.join(" ") + "\n");
const iso = ms => new Date(ms).toISOString().slice(0,10);

async function j(url, tries){
  tries = tries || 3;
  for (let i = 0; i < tries; i++){
    try {
      const r = await fetch(url);
      if (r.status === 429 || r.status >= 500){ await new Promise(s=>setTimeout(s, 1500*(i+1))); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
      return r.json();
    } catch (e){ if (i === tries-1) throw e; await new Promise(s=>setTimeout(s, 1000*(i+1))); }
  }
}

/* ---------- klines, paginated forward ---------- */
async function klines(base, sym, interval, startMs){
  const out = [];
  let cursor = startMs;
  for (;;){
    const rows = await j(base + "/api/v3/klines?symbol=" + sym + "&interval=" + interval
                        + "&startTime=" + cursor + "&limit=1000");
    if (!rows || !rows.length) break;
    out.push(...rows);
    if (rows.length < 1000) break;
    cursor = rows[rows.length-1][0] + 1;
  }
  return out;
}
async function fklines(sym, interval, startMs){
  const out = [];
  let cursor = startMs;
  for (;;){
    const rows = await j(FAPI + "/fapi/v1/klines?symbol=" + sym + "&interval=" + interval
                        + "&startTime=" + cursor + "&limit=1500");
    if (!rows || !rows.length) break;
    out.push(...rows);
    if (rows.length < 1500) break;
    cursor = rows[rows.length-1][0] + 1;
  }
  return out;
}
async function fundingAll(startMs){
  const out = [];
  let cursor = startMs;
  for (;;){
    const rows = await j(FAPI + "/fapi/v1/fundingRate?symbol=BTCUSDT&startTime=" + cursor + "&limit=1000");
    if (!rows || !rows.length) break;
    out.push(...rows);
    if (rows.length < 1000) break;
    cursor = rows[rows.length-1].fundingTime + 1;
  }
  return out;
}

/* ---------- OI archive ---------- */
function unzipFirst(buf){
  const sig = buf.readUInt32LE(0);
  if (sig !== 0x04034b50) throw new Error("not a zip");
  const method = buf.readUInt16LE(8);
  const compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26), extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  const body = buf.subarray(start, start + compSize);
  return method === 0 ? body.toString("utf8") : zlib.inflateRawSync(body).toString("utf8");
}
async function oiDay(dateStr){
  const url = VISION + "/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-" + dateStr + ".zip";
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("archive HTTP " + r.status);
  const csv = unzipFirst(Buffer.from(await r.arrayBuffer()));
  const lines = csv.trim().split("\n");
  if (lines.length < 3) return null;
  const head = lines[0].split(",");
  const iOI = head.indexOf("sum_open_interest");
  if (iOI < 0) return null;
  let s = 0, n = 0;
  for (let i = 1; i < lines.length; i++){
    const v = parseFloat(lines[i].split(",")[iOI]);
    if (isFinite(v)) { s += v; n++; }
  }
  return n ? s/n : null;
}
async function oiArchive(fromMs, toMs){
  const file = path.join(CACHE, "oi.json");
  let cache = {};
  if (fs.existsSync(file)) cache = JSON.parse(fs.readFileSync(file, "utf8"));
  const want = [];
  for (let t = fromMs; t <= toMs; t += DAY) want.push(iso(t));
  const todo = want.filter(k => cache[k] === undefined);
  log("OI archive: " + want.length + " days, " + todo.length + " to fetch");
  let done = 0;
  const CONC = 12;
  for (let i = 0; i < todo.length; i += CONC){
    const batch = todo.slice(i, i + CONC);
    const res = await Promise.all(batch.map(async k => {
      try { return [k, await oiDay(k)]; } catch (e) { return [k, undefined]; }
    }));
    for (const [k, v] of res) if (v !== undefined) cache[k] = v;
    done += batch.length;
    if (done % 240 < CONC) { log("  " + done + "/" + todo.length); fs.writeFileSync(file, JSON.stringify(cache)); }
  }
  fs.writeFileSync(file, JSON.stringify(cache));
  return cache;
}

/* ---------- indicator helpers (mirrors the page) ---------- */
const closes = k => k.map(r => +r[4]);
const highs  = k => k.map(r => +r[2]);
const lows   = k => k.map(r => +r[3]);
function sma(a,n){ const o=new Array(a.length).fill(null); let s=0;
  for(let i=0;i<a.length;i++){s+=a[i];if(i>=n)s-=a[i-n];if(i>=n-1)o[i]=s/n;} return o; }
function pctRank(w,v){ if(!w.length)return null; let c=0; for(const x of w) if(x<v)c++; return 100*c/w.length; }
function stdev(a){ if(a.length<2)return null; const m=a.reduce((x,y)=>x+y,0)/a.length;
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); }
function pivots(hi,lo,n){ const ph=[],pl=[];
  for(let i=n;i<hi.length-n;i++){ let H=true,L=true;
    for(let j=i-n;j<=i+n;j++){ if(j===i)continue; if(hi[j]>=hi[i])H=false; if(lo[j]<=lo[i])L=false; if(!H&&!L)break; }
    if(H)ph.push({i,v:hi[i]}); if(L)pl.push({i,v:lo[i]}); }
  return {highs:ph,lows:pl}; }
function structState(p){ const H=p.highs,L=p.lows;
  if(H.length<2||L.length<2)return "TRANSITION";
  const h1=H[H.length-1].v,h0=H[H.length-2].v,l1=L[L.length-1].v,l0=L[L.length-2].v;
  if(h1>h0&&l1>l0)return "HH_HL"; if(h1<h0&&l1<l0)return "LH_LL"; return "TRANSITION"; }

function classify(x){
  const st = x.struct;
  const rules = {
    EARLY_UPTREND: x.aboveMA && x.spotLed && x.f30 < CFG.fundCoolPct && st !== "LH_LL",
    CONFIRMED_UPTREND: x.aboveMA && x.maSlopeUp && st === "HH_HL"
      && x.f30 < CFG.fundConfirmMaxPct && x.f7 < CFG.fundHotPct && x.oi20 > 0,
    LATE_UPTREND: x.aboveMA && x.ret20 > 0
      && (x.f7 >= CFG.fundHotPct || x.f30 >= CFG.fundHotPct) && x.oi20 > CFG.oiHotPct,
    DOWNTREND: !x.aboveMA && (!x.maSlopeUp || st === "LH_LL"),
  };
  for (const k of ["EARLY_UPTREND","CONFIRMED_UPTREND","LATE_UPTREND","DOWNTREND"]) if (rules[k]) return k;
  return "CONFLICTED";
}

/* ---------- stats ---------- */
function quantile(sorted, q){
  if (!sorted.length) return null;
  const pos = (sorted.length-1)*q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi]-sorted[lo])*(pos-lo);
}
function describe(arr){
  if (!arr.length) return null;
  const s = arr.slice().sort((a,b)=>a-b);
  return {
    n: s.length,
    median: quantile(s,0.5), q1: quantile(s,0.25), q3: quantile(s,0.75),
    worstDecile: quantile(s,0.10), bestDecile: quantile(s,0.90),
    mean: s.reduce((a,b)=>a+b,0)/s.length,
    positiveRate: 100*s.filter(x=>x>0).length/s.length,
  };
}

/* ---------- main ---------- */
(async () => {
  const t0 = Date.now();
  const START = Date.UTC(2019,0,1);

  log("fetching klines and funding…");
  const [daily, weekly, perp, funding] = await Promise.all([
    klines(SPOT,"BTCUSDT","1d",START),
    klines(SPOT,"BTCUSDT","1w",START),
    fklines("BTCUSDT","1d",START),
    fundingAll(Date.UTC(2019,8,1)),
  ]);
  log("  daily " + daily.length + ", weekly " + weekly.length + ", perp " + perp.length + ", funding " + funding.length);

  const oiCache = await oiArchive(Date.UTC(2020,8,1), Date.now() - DAY);
  const oiDays = Object.keys(oiCache).filter(k => typeof oiCache[k] === "number").sort();
  log("  OI usable days: " + oiDays.length + " (" + oiDays[0] + " → " + oiDays[oiDays.length-1] + ")");
  const oiMap = new Map(oiDays.map(k => [k, oiCache[k]]));

  const cl = closes(daily), dt = daily.map(r => r[0]);
  const ma = sma(cl, CFG.maLen), ma50 = sma(cl, 50);

  const lr = [];
  for (let i=1;i<cl.length;i++) lr.push(Math.log(cl[i]/cl[i-1]));
  const rv = new Array(cl.length).fill(null);
  for (let i=CFG.rvLen;i<cl.length;i++){ const sd = stdev(lr.slice(i-CFG.rvLen,i)); rv[i] = sd===null?null:sd*Math.sqrt(365)*100; }

  const fRates = funding.map(x => +x.fundingRate), fTimes = funding.map(x => x.fundingTime);
  const perDay = 3, winN = CFG.pctWindowDays*perDay;
  const mS = sma(fRates, CFG.fundShort*perDay), mL = sma(fRates, CFG.fundLong*perDay);

  // weekly structure as of each weekly bar close
  const wHi = highs(weekly), wLo = lows(weekly), wT = weekly.map(r => r[0]);
  const structByWeek = [];
  for (let k = 1; k <= weekly.length; k++){
    structByWeek.push({ t: wT[k-1], s: structState(pivots(wHi.slice(0,k), wLo.slice(0,k), CFG.pivotN)) });
  }
  const structAsOf = ms => {
    let s = "TRANSITION";
    for (let i = structByWeek.length-1; i >= 0; i--) if (structByWeek[i].t <= ms) { s = structByWeek[i].s; break; }
    return s;
  };

  let fIdx = 0;
  const series = [];
  for (let i = CFG.maLen + CFG.maSlopeLookback; i < cl.length; i++){
    const ts = dt[i], key = iso(ts);
    const oiNow = oiMap.get(key);
    const prevKey = iso(ts - CFG.oiLookback*DAY);
    const oiPrev = oiMap.get(prevKey);
    if (oiNow === undefined || oiPrev === undefined) continue;

    while (fIdx < fTimes.length-1 && fTimes[fIdx+1] <= ts) fIdx++;
    if (mS[fIdx] == null || mL[fIdx] == null) continue;
    const lo = Math.max(0, fIdx - winN);
    const f7  = pctRank(mS.slice(lo,fIdx).filter(x=>x!==null), mS[fIdx]);
    const f30 = pctRank(mL.slice(lo,fIdx).filter(x=>x!==null), mL[fIdx]);
    if (f7 == null || f30 == null) continue;

    const ret20 = (cl[i]/cl[i-CFG.retLookback]-1)*100;
    const oi20  = (oiNow/oiPrev-1)*100;
    const x = {
      aboveMA: cl[i] > ma[i],
      maSlopeUp: ma[i] - ma[i-CFG.maSlopeLookback] > 0,
      ret20, oi20, f7, f30,
      struct: structAsOf(ts),
    };
    x.spotLed = ret20 > 0 && f30 < CFG.fundCoolPct && oi20 <= 0;
    series.push({ i, t: ts, date: key, px: cl[i], state: classify(x) });
  }
  log("classified days: " + series.length + " (" + series[0].date + " → " + series[series.length-1].date + ")");

  /* forward returns */
  const fwd = (i, h) => (i + h < cl.length) ? (cl[i+h]/cl[i]-1)*100 : null;
  for (const r of series){ r.f30 = fwd(r.i,30); r.f90 = fwd(r.i,90); }

  /* independent episodes: contiguous runs of the same state */
  const episodes = [];
  for (let k = 0; k < series.length; k++){
    if (k === 0 || series[k].state !== series[k-1].state
        || series[k].t - series[k-1].t > 3*DAY){
      episodes.push({ state: series[k].state, startIdx: k, start: series[k].date, days: 1 });
    } else episodes[episodes.length-1].days++;
    episodes[episodes.length-1].end = series[k].date;
  }
  for (const e of episodes){
    const r = series[e.startIdx];
    e.f30 = r.f30; e.f90 = r.f90; e.entryPx = r.px;
  }

  const STATES = ["EARLY_UPTREND","CONFIRMED_UPTREND","LATE_UPTREND","DOWNTREND","CONFLICTED"];

  /* Contiguous runs are NOT independent observations: two runs three days
     apart share 87 of their 90 forward days. Genuine independence needs the
     forward windows not to overlap, so take a greedy subset of episodes at
     least `h` days apart. This is the honest n. */
  function separated(eps, h){
    const out = [];
    let last = null;
    for (const e of eps.slice().sort((a,b) => a.start.localeCompare(b.start))){
      const t = Date.parse(e.start + "T00:00:00Z");
      if (last === null || (t - last)/DAY >= h){ out.push(e); last = t; }
    }
    return out;
  }

  const byState = {};
  for (const st of STATES){
    const days = series.filter(r => r.state === st);
    const eps  = episodes.filter(e => e.state === st);
    const sep30 = separated(eps, 30), sep90 = separated(eps, 90);
    byState[st] = {
      days: days.length,
      episodes: eps.length,
      independentCount30: sep30.length,
      independentCount90: sep90.length,
      medianEpisodeLength: eps.length ? quantile(eps.map(e=>e.days).sort((a,b)=>a-b), 0.5) : null,
      overlappingDaily: {
        f30: describe(days.map(r=>r.f30).filter(v=>v!==null)),
        f90: describe(days.map(r=>r.f90).filter(v=>v!==null)),
      },
      contiguousRuns: {
        f30: describe(eps.map(e=>e.f30).filter(v=>v!==null)),
        f90: describe(eps.map(e=>e.f90).filter(v=>v!==null)),
      },
      // the honest sample: forward windows that do not overlap each other
      independentEpisodes: {
        f30: describe(sep30.map(e=>e.f30).filter(v=>v!==null)),
        f90: describe(sep90.map(e=>e.f90).filter(v=>v!==null)),
      },
    };
  }

  const baseline = {
    days: series.length,
    overlappingDaily: {
      f30: describe(series.map(r=>r.f30).filter(v=>v!==null)),
      f90: describe(series.map(r=>r.f90).filter(v=>v!==null)),
    },
  };

  /* transition matrix over episode boundaries */
  const trans = {};
  for (const a of STATES){ trans[a] = {}; for (const b of STATES) trans[a][b] = 0; }
  for (let k = 1; k < episodes.length; k++) trans[episodes[k-1].state][episodes[k].state]++;

  const out = {
    generated: new Date().toISOString(),
    thresholds: CFG,
    window: { from: series[0].date, to: series[series.length-1].date, classifiedDays: series.length,
              limitedBy: "open-interest archive starts " + oiDays[0] },
    baseline, byState, transitions: trans,
    episodes: episodes.map(e => ({ state:e.state, start:e.start, end:e.end, days:e.days, f30:e.f30, f90:e.f90 })),
    caveats: [
      "Contiguous runs are not independent: runs a few days apart share almost all of their forward window. independentCount90 counts only episodes whose 90-day forward windows do not overlap, and is the honest n.",
      "Overlapping daily windows overstate n by roughly an order of magnitude and are shown only for comparison.",
      "Thresholds were not adjusted in response to these results.",
      "Window is limited by the Binance open-interest archive, which starts 2020-09-01.",
      "Single-venue Binance data throughout.",
    ],
  };
  fs.writeFileSync(path.join(__dirname, "..", "validation.json"), JSON.stringify(out, null, 1));
  log("wrote validation.json in " + ((Date.now()-t0)/1000).toFixed(1) + "s");

  for (const st of STATES){
    const b = byState[st];
    const d = b.independentEpisodes.f90;
    log("  " + st.padEnd(18) + " days=" + String(b.days).padStart(4)
      + " runs=" + String(b.episodes).padStart(3)
      + " indep90=" + String(b.independentCount90).padStart(3)
      + (d ? "  90d median=" + d.median.toFixed(1) + "%  n=" + d.n : "  (no forward data)"));
  }
  const bl = baseline.overlappingDaily.f90;
  log("  BASELINE (all days) 90d median=" + bl.median.toFixed(1) + "%  n=" + bl.n);
})().catch(e => { log("FAILED: " + (e && e.stack || e)); process.exit(1); });
