# BTC Regime Monitor

A live Bitcoin market-regime dashboard. It classifies the *present* state of the market from public exchange data and shows every condition behind that classification. It does not forecast, set price targets, or recommend trades.

**Live:** https://btc-regime-monitor.vercel.app
**Machine-readable:** [`/api/snapshot`](https://btc-regime-monitor.vercel.app/api/snapshot)

---

## Read this before trusting the output

The rule set is **unvalidated**, and the repo says so on the page itself.

A full replay over 2,163 days (2020-09-21 → 2026-08-23, see [`validation.json`](validation.json)) found that **no state has enough independent observations to support any claim about what follows it.** Counting only episodes whose 90-day forward windows do not overlap, the sample sizes are 9, 6, 5, 4 and 15. Two of the five states change the *sign* of their median forward return purely by switching how episodes are counted.

Six years is roughly one and a half cycles for a four-year asset. More history is not available: the open-interest archive starts 2020-09-01.

Thresholds were never tuned in response to these results, and should not be. Treat the tool as instrumentation, not as a signal.

One flaw needs no statistics at all. `EARLY_UPTREND` requires open interest flat or falling; `CONFIRMED_UPTREND` requires it expanding. The two are mutually exclusive on that leg, so the ladder is **spot-led versus leverage-led**, not weaker versus stronger confirmation — despite the naming.

---

## What it shows

**Five-state classifier** — `EARLY_UPTREND`, `CONFIRMED_UPTREND`, `LATE_UPTREND`, `DOWNTREND`, `CONFLICTED`, evaluated in that precedence order. A state is reached only when *every* one of its conditions is true. `CONFLICTED` is a real state, not a fallback: when structure and positioning disagree, that disagreement is the information.

**Layered reversal engine** — 21 votes across three tiers, shown alongside the five-state machine rather than replacing it. L1 crowding, L2 deterioration, L3 structural break. Escalation to L3 requires a close below the 200DMA *plus* a supporting break; a falling slope alone is not a break.

**Week over week** — the classifier recomputed as of seven days ago from source data, with each trigger marked new / sustained / cleared. No database: every input except the point-in-time feeds is itself historical, so past state is derived rather than accumulated.

**Panels** — 200DMA and slope, weekly swing pivots, 50DMA and the 20W/21W band, realized vol percentile, funding with 2-year percentile, coin-denominated OI with the four-quadrant flag, OI vs its 90-day mean, OI-to-volume, cross-venue OI-weighted funding, Coinbase premium, spot vs perp CVD, DVOL and IV−RV, 25-delta skew, quarterly basis, weekly RSI with divergence, stablecoin supply, account long/short, taker buy/sell.

---

## Data sources

All public, no API key required for anything on the page.

| Source | Used for |
|---|---|
| Binance spot + USD-M futures REST | price, volume, funding, open interest, long/short, taker flow |
| `data.binance.vision` bulk archive | open-interest history back to 2020-09-01 (the REST endpoint caps at 30 days) |
| Deribit | DVOL, option chain for skew |
| Bybit, OKX, Hyperliquid | cross-venue funding and OI |
| Coinbase | US spot premium |
| DefiLlama | stablecoin supply |

Failed requests grey their panel and print the status code. Nothing is interpolated, forward-filled, or estimated.

---

## Running it

The dashboard is a single self-contained file. Open `btc-regime.html` in a browser and it works — no build step, no server, no key. The `/api` routes need Vercel.

```bash
vercel dev            # full local environment including /api
vercel deploy --prod  # ship
```

### Regenerating the validation

```bash
node tools/backfill.js
```

Replays the classifier over all available history and rewrites `validation.json`. The open-interest archive is cached in `tools/cache/`, so the first run takes about a minute and later runs about a second.

### Configuration

Thresholds live in [`config.json`](config.json) with a changelog. The page falls back to built-in defaults if the file is missing, which is what keeps `file://` working.

### Environment variables

| Variable | Effect |
|---|---|
| `TWELVEDATA_API_KEY` or `ALPHAVANTAGE_API_KEY` | enables `/api/equity` and the BTC–QQQ correlation panel |
| `SNAPSHOT_TOKEN` | requires a read-only token on `/api/snapshot`; without it the route is open |

---

## Notes on deployment

Serverless functions are pinned to `fra1` in [`vercel.json`](vercel.json). **Binance returns HTTP 451 to US datacenter IPs**, so a US-region function cannot reach it.

Hosting does not proxy anything — the browser fetches exchange APIs directly, using the viewer's own IP. Deploying does not bypass a regional block.

---

## Known limits

- Single-venue Binance data for the core series. Not the aggregate market.
- Funding percentiles use a trailing 2-year window against an asset with roughly 4-year cycles, so the same absolute condition ranks differently depending on where the window sits.
- OI-to-volume divides by a trailing 7-day mean, because raw daily perp volume has a strong weekday cycle that would otherwise dominate the reading.
- The L1/L2/L3 tier membership is inferred, not specified. Treat it as a weak prior.
- The event log stores to `localStorage` — it is per-browser, not shared.
- `api/_engine.js` re-implements the classifier server-side so the page stays self-contained. Both read `config.json`, so parameters cannot drift, but the code paths can. A rule change must be made in both places.

## Not included

On-chain metrics, liquidation splits, ETF flows and CME basis all require paid data subscriptions and are not implemented.

---

Nothing here is financial advice.
