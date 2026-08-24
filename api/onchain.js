/* On-chain metrics (gap-set item 14) and corporate treasury (part of item 12).

   Routed through the server for one reason: bitcoin-data.com rate-limits by
   the hour and returned RATE_LIMIT_HOUR_EXCEEDED after roughly a dozen probes.
   Fetching from every viewer's browser on the dashboard's 5-minute loop would
   burn that instantly. With s-maxage the CDN serves one upstream fetch per
   hour to all viewers, which is also the right cadence — these are daily
   metrics that do not move intraday.

   No API key and no subscription. Replaces the ~$99/mo on-chain tier. */

const BD = "https://bitcoin-data.com/v1";
const CG = "https://api.coingecko.com/api/v3";

/* Fetch the FULL series for each metric rather than /last plus a history call.
   One request yields both the current value and its percentile, which halves
   the calls against a provider whose hourly limit is genuinely tight. */
async function series(pathname, field){
  const r = await fetch(BD + pathname);
  if (!r.ok) return { error: pathname + " HTTP " + r.status + (r.status === 429 ? " (hourly rate limit)" : "") };
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) return { error: pathname + " empty" };
  const vals = rows.map(x => parseFloat(x[field])).filter(v => isFinite(v));
  if (!vals.length) return { error: pathname + " missing " + field };
  return {
    value: vals[vals.length-1],
    date: rows[rows.length-1].d,
    percentile: pctRank(vals.slice(0,-1), vals[vals.length-1]),
    days: vals.length,
    from: rows[0].d,
  };
}

function pctRank(arr, v){
  if (!arr.length) return null;
  let c = 0;
  for (const x of arr) if (x < v) c++;
  return 100 * c / arr.length;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Default to no-store so a transient upstream failure is never cached; the
  // success path opts in to the shared hourly cache. max-age=0 keeps the
  // browser revalidating while s-maxage lets the CDN serve one fetch an hour.
  res.setHeader("Cache-Control", "no-store");
  const cacheOk = () => res.setHeader("Cache-Control",
    "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");

  const out = { asOf: new Date().toISOString(), sources: {}, errors: [] };
  try {
    const [sth, lth, mvrvZ, nupl, treasury] = await Promise.all([
      series("/sth-realized-price", "sthRealizedPrice"),
      series("/lth-realized-price", "lthRealizedPrice"),
      series("/mvrv-zscore", "mvrvZscore"),
      series("/nupl", "nupl"),
      fetch(CG + "/companies/public_treasury/bitcoin").then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    for (const v of [sth, lth, mvrvZ, nupl]) if (v.error) out.errors.push(v.error);

    out.onchain = {
      sthRealizedPrice: sth.value ?? null,
      lthRealizedPrice: lth.value ?? null,
      mvrvZscore: mvrvZ.value ?? null,
      mvrvZPercentile: mvrvZ.percentile ?? null,
      nupl: nupl.value ?? null,
      nuplPercentile: nupl.percentile ?? null,
      // MVRV falls out of NUPL: NUPL = 1 - 1/MVRV
      mvrv: nupl.value != null ? 1/(1 - nupl.value) : null,
      asOfDate: sth.date || mvrvZ.date || null,
      historyDays: mvrvZ.days ?? sth.days ?? null,
      historyFrom: mvrvZ.from ?? sth.from ?? null,
    };
    out.sources.onchain = "bitcoin-data.com (free, no key)";

    if (treasury && Array.isArray(treasury.companies)){
      const mstr = treasury.companies.find(c => (c.symbol || "").startsWith("MSTR"));
      if (mstr){
        out.treasury = {
          name: mstr.name,
          symbol: mstr.symbol,
          btcHeld: mstr.total_holdings,
          navUsd: mstr.total_current_value_usd,
          costBasisUsd: mstr.total_entry_value_usd,
          avgEntryPrice: mstr.total_entry_value_usd / mstr.total_holdings,
          pctOfSupply: mstr.percentage_of_total_supply,
        };
      }
      out.treasury = out.treasury || {};
      out.treasury.allCompaniesBtc = treasury.total_holdings;
      out.sources.treasury = "CoinGecko public_treasury (free)";
      // mNAV needs the equity market cap, which needs an equity data key
      out.treasury.mNav = null;
      out.treasury.mNavNote = "mNAV needs MSTR market cap. Set TWELVEDATA_API_KEY or ALPHAVANTAGE_API_KEY to complete it.";
    }

    const ok = !(out.onchain.sthRealizedPrice == null && out.onchain.mvrvZscore == null);
    if (ok) cacheOk();
    res.statusCode = ok ? 200 : 502;
    res.end(JSON.stringify(out, null, 2));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: "upstream_failed", detail: String(e && e.message || e) }));
  }
};
