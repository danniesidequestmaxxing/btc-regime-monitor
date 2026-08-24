/* Item 15: BTC vs QQQ 30-day correlation.
   Free browser-reachable equity data does not exist: Stooq now serves a
   proof-of-work bot challenge and Yahoo sends no CORS header and rate-limits.
   Rather than defeat a bot check, this route reads a proper market-data API,
   which needs a free key set as an environment variable on the project.

     vercel env add TWELVEDATA_API_KEY      (twelvedata.com — free tier)
   or vercel env add ALPHAVANTAGE_API_KEY   (alphavantage.co — free tier)

   With neither set it returns 501 and the panel greys with that reason. */

async function twelve(symbol, key){
  const u = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(symbol)
          + "&interval=1day&outputsize=120&apikey=" + encodeURIComponent(key);
  const r = await fetch(u);
  if (!r.ok) throw new Error("twelvedata HTTP " + r.status);
  const d = await r.json();
  if (d.status === "error") throw new Error("twelvedata: " + d.message);
  return d.values.map(v => ({ date: v.datetime, close: +v.close })).reverse();
}
async function alphaVantage(symbol, key){
  const u = "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol="
          + encodeURIComponent(symbol) + "&outputsize=compact&apikey=" + encodeURIComponent(key);
  const r = await fetch(u);
  if (!r.ok) throw new Error("alphavantage HTTP " + r.status);
  const d = await r.json();
  const series = d["Time Series (Daily)"];
  if (!series) throw new Error("alphavantage: " + (d.Note || d.Information || d["Error Message"] || "no series"));
  return Object.keys(series).sort().map(k => ({ date: k, close: +series[k]["4. close"] }));
}

function pearson(a, b){
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((p,c)=>p+c,0)/n, my = y.reduce((p,c)=>p+c,0)/n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++){ const dx = x[i]-mx, dy = y[i]-my; sxy += dx*dy; sxx += dx*dx; syy += dy*dy; }
  return sxx && syy ? sxy/Math.sqrt(sxx*syy) : null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Never cache a failure. Setting the success policy up front meant a 501 from
  // a missing key was served from cache for an hour after the key was added.
  res.setHeader("Cache-Control", "no-store");
  const cacheOk = () => res.setHeader("Cache-Control",
    "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");

  const td = process.env.TWELVEDATA_API_KEY, av = process.env.ALPHAVANTAGE_API_KEY;
  if (!td && !av){
    res.statusCode = 501;
    return res.end(JSON.stringify({
      error: "no_equity_key",
      detail: "Set TWELVEDATA_API_KEY or ALPHAVANTAGE_API_KEY on the Vercel project. Free equity sources reachable from a browser no longer exist: Stooq serves a proof-of-work bot challenge and Yahoo sends no CORS header.",
    }));
  }
  try {
    const qqq = td ? await twelve("QQQ", td) : await alphaVantage("QQQ", av);
    const r = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=200");
    if (!r.ok) throw new Error("binance HTTP " + r.status);
    const btcRaw = await r.json();
    const btc = new Map(btcRaw.map(k => [new Date(k[0]).toISOString().slice(0,10), +k[4]]));

    // align on equity trading days only — no weekend fill
    const rows = qqq.filter(q => btc.has(q.date)).map(q => ({ date:q.date, qqq:q.close, btc:btc.get(q.date) }));
    if (rows.length < 35) throw new Error("only " + rows.length + " aligned sessions");
    const rq = [], rb = [];
    for (let i = 1; i < rows.length; i++){
      rq.push(Math.log(rows[i].qqq/rows[i-1].qqq));
      rb.push(Math.log(rows[i].btc/rows[i-1].btc));
    }
    cacheOk();
    res.statusCode = 200;
    res.end(JSON.stringify({
      asOf: new Date().toISOString(),
      provider: td ? "twelvedata" : "alphavantage",
      lastSession: rows[rows.length-1].date,
      alignedSessions: rows.length,
      corr30: pearson(rq.slice(-30), rb.slice(-30)),
      corr90: rq.length >= 90 ? pearson(rq.slice(-90), rb.slice(-90)) : null,
      qqq: rows[rows.length-1].qqq,
      btc: rows[rows.length-1].btc,
      note: "Pearson correlation of daily log returns, aligned on equity trading days only.",
    }, null, 2));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: "upstream_failed", detail: String(e && e.message || e) }));
  }
};
