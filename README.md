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

The default panels use public feeds without keys. The optional **modeled** liquidation map requires a CoinGlass API subscription with map access.

| Source | Used for |
|---|---|
| Binance spot + USD-M futures REST | price, volume, funding, open interest, long/short, taker flow |
| `data.binance.vision` bulk archive | open-interest history back to 2020-09-01 (the REST endpoint caps at 30 days) |
| Deribit | DVOL, option chain for skew |
| Bybit, OKX, Hyperliquid | cross-venue funding and OI |
| Coinbase | US spot premium |
| DefiLlama | stablecoin supply |
| bitcoin-data.com | short/long-term holder cost basis, MVRV Z-score, NUPL |
| Coin Metrics Community | MVRV, market cap, exchange flows |
| OKX liquidation orders | forced liquidations with the long/short split |
| CoinGecko public_treasury | corporate BTC holdings and cost basis |
| CoinGecko derivatives | current BTC / ETH / Others OI shares and BTC-to-ETH OI ratio |
| XOOMAR issuer holdings | daily holdings-derived ETF flows: IBIT, BITB, ARKB, ETHA, ETHW |
| BGeometrics HODL waves | holder supply and 1/7/30-day changes using a six-month age cutoff |
| OKX instruments + liquidation orders | recorded liquidation map by bankruptcy-price band, converted to USD notional |
| CoinGlass (optional key) | modeled Binance BTCUSDT liquidation map |

### New market-context panels

`#market-context` contains four independent panels with a separate refresh control,
dates, source links, responsive SVG charts, and accessible data tables. They refresh
every five minutes while the page is visible and do not affect the classifier.

- **OI dominance:** BTC/ETH/other shares of USD OI plus BTC/ETH ratio. Coinalyze's
  public chart requests returned HTTP 403 from this environment; its exact history
  is linked, **not embedded or reproduced**. The native snapshot uses CoinGecko's
  different coverage, including perpetuals, dated futures, and noncrypto underlyings
  in Others. Duplicate instruments, expired contracts, invalid values, and contracts
  last traded over 24 hours ago are excluded. Last-trade times are not OI update times.
- **ETF tracker:** BTC/ETH switch, latest report, last five complete reports, chart,
  and fund breakdown. XOOMAR derives USD flows from changes in issuer coin holdings.
  This covers three BTC and two ETH funds, **not all US spot ETFs or official net
  creations**. Missing reports stay null; partial totals and bars are labeled.
- **Holder movement:** free UTXO-age proxy (≥6 months versus <6 months), not the
  standard entity-adjusted 155-day LTH/STH series. Net changes use exact calendar
  dates; no interpolation. Coin aging and issuance also change cohort balances.
- **Liquidation map:** Recorded mode groups OKX BTC-USDT swap events in $100
  bankruptcy-price bands. Contract notional uses `ctVal × ctMult × sz × bkPx`.
  The returned event window is labeled and is not a 24-hour cross-exchange total.
  Modeled mode uses CoinGlass's Binance BTCUSDT 1-day map; absent credentials produce
  an explicit unavailable state. The adapter follows the documented response schema
  and is fixture-tested, but cannot be live-verified without an eligible key.

Provider documentation: [CoinGecko](https://docs.coingecko.com/reference/derivatives-tickers),
[XOOMAR](https://xoomar.com/markets/api/etf-flows),
[BGeometrics](https://bitcoin-data.com/bguser/free-features.html),
[CoinGlass](https://docs.coinglass.com/reference/liquidation-map).

`/api/market-context?kind=oi|etf-btc|etf-eth|holders|liquidations` serves these feeds.
Add `&mode=modeled` for the CoinGlass liquidation map. The endpoint accepts GET
only and fixed upstreams. Timeouts, per-instance caching/request coalescing, and
CDN caching bound requests: 5 minutes for OI/liquidations, 1 hour for ETFs, and
24 hours for holder data. Failures are not cached or presented as fresh values.

Failed core requests grey their panels; new panels show explicit source errors and
clear old values. Missing observations are never forward-filled. Derived flows,
holder proxies and modeled liquidation levels are labeled as such.

---

## Running it

The core dashboard lives in `btc-regime.html`; the new panels use
`market-context.js` and `market-context.css`. There is no build step. Core exchange
panels can still open off disk; API-backed panels need Vercel or the local server
(Node 20+). Keep the adjacent JS/CSS files with the HTML.

```bash
node tools/dev.js    # http://127.0.0.1:8765/#market-context, including API routes
vercel dev            # full local environment including /api
vercel deploy --prod  # ship
```

### Tests

```bash
node tests/run.js
node --test tests/market-context.js
```

64 assertions over the indicator layer. Every fixture is small enough to check
by hand, and the expected value is written alongside the arithmetic that
produces it, so the test can be verified rather than trusted.

The tests do not keep their own copy of the functions. They extract the shipped
code from `btc-regime.html` between `PURE:BEGIN` / `PURE:END` markers and
evaluate it, so a function that drifts out of a marked region fails loudly
instead of silently going untested. A dedicated block runs the page's
classifier and `api/_engine.js` against identical inputs and asserts they
agree, which is the guard against the two implementations diverging.

The suite has been mutation-tested: flipping the pivot comparison, making
`pctRank` inclusive, switching `stdev` to a population deviation, inverting the
CVD sign, moving the quadrant boundary, and changing the annualisation factor
each fail it.

The market-context suite checks USD OI aggregation, partial ETF reports and nulls,
exact-date holder changes, contract-to-USD liquidation conversion, map schemas,
API validation, error isolation, caching and server-only key handling.

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
| `COINGLASS_API_KEY` | enables Modeled liquidation map; requires a plan with `/api/futures/liquidation/map` access (Professional/Enterprise in the provider docs checked October 2026) |

Store provider credentials in Vercel environment variables (or the local server
environment), never in client code or Git. Redeploy after changing production
environment variables. No key is needed for Recorded mode or the free context feeds.

---

## Notes on deployment

Serverless functions are pinned to `fra1` in [`vercel.json`](vercel.json). **Binance returns HTTP 451 to US datacenter IPs**, so a US-region function cannot reach it.

The browser fetches exchange APIs directly, using the viewer's own IP. That is the
default and the fast path. When a direct fetch fails outright — a bare
`Failed to fetch`, which is what a regional block on the futures API, a DNS or
corporate filter, or an ad blocker with a crypto list all look like from
JavaScript — or comes back 403/451, the page retries that one request through
[`/api/relay`](api/relay.js) and remembers the host for the rest of the session.
The relay refetches it from `fra1` and returns the bytes unchanged.

The relay allowlists the exchange hosts this page already reads, so it is not a
general-purpose proxy, and it only exists on a deployment: opened off disk or
from a static file server the page probes it once, disables the fallback, and
names the unreachable endpoints in the error box instead. Add `?relay=1` to the
URL to skip the direct attempt and route everything through it.

---

## Known limits

- Single-venue Binance data for the core series. Not the aggregate market.
- Funding percentiles use a trailing 2-year window against an asset with roughly 4-year cycles, so the same absolute condition ranks differently depending on where the window sits.
- OI-to-volume divides by a trailing 7-day mean, because raw daily perp volume has a strong weekday cycle that would otherwise dominate the reading.
- The L1/L2/L3 tier membership is inferred, not specified. Treat it as a weak prior.
- The event log stores to `localStorage` — it is per-browser, not shared.
- `bitcoin-data.com` rate-limits by the hour, which is why the on-chain metrics
  are served through `/api/onchain` with `s-maxage=3600` rather than fetched
  per viewer. It is a small single operator with four years of history and no SLA;
  Coin Metrics is the more institutional source where the two overlap.
- Liquidations are a rolling window of roughly four hours from a single venue.
  Depth and cross-venue aggregation are what the paid feeds actually sell.
  Liquidation history cannot be derived after the fact — capturing the
  websocket stream is the one part of this project that would genuinely
  justify a database.
- `api/_engine.js` re-implements the classifier server-side so the page stays
  self-contained. Both read `config.json`, so parameters cannot drift, and
  `tests/run.js` asserts the two agree on every state and on the shared
  primitives — but a rule change still has to be made in both places.

## Not included

- **Full-market official spot ETF net flows** — Farside blocks automated requests.
  The new free tracker covers a subset of issuer holdings-derived flows instead.
- **CME basis** — no free source.
- **BTC–QQQ correlation** — implemented at `/api/equity`, but dormant until an
  equity API key is set. Free browser-reachable equity data no longer exists:
  Stooq serves a proof-of-work bot challenge and Yahoo sends no CORS header.
- **mNAV** — the treasury panel shows holdings and cost basis; the ratio needs an
  equity market cap, so it completes with the same key.
- **Exact 155-day entity-adjusted LTH/STH supply** — the new free holder panel uses
  BGeometrics six-month UTXO age bands instead.

---

Nothing here is financial advice.
