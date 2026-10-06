// Source adapters. Missing data remains null; timestamps are never invented.
const DAY = 86400000;
function number(v) {
  return v === null || v === undefined || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
}
function date(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(v + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : null;
}
function requireRows(rows) { if (!Array.isArray(rows) || !rows.length) throw new Error('Source returned no usable records'); }

function openInterest(rows, now = Date.now()) {
  requireRows(rows);
  const seen = new Set(), totals = { BTC: 0, ETH: 0, Others: 0 }, exchanges = new Set();
  let excluded = 0, count = 0, oldestTrade = now, newestTrade = 0;
  for (const r of rows) {
    const value = number(r.open_interest), traded = number(r.last_traded_at), expiry = number(r.expired_at);
    const id = r.market + '\0' + r.symbol;
    // Exclude stale/expired contracts; deduplicate the exchange + instrument pair.
    if (!r.market || !r.symbol || !r.index_id || !['perpetual', 'futures'].includes(r.contract_type)
        || value === null || value < 0 || !traded || traded * 1000 < now - DAY
        || traded * 1000 > now + 300000 || (expiry && expiry * 1000 <= now) || seen.has(id)) { excluded++; continue; }
    seen.add(id); exchanges.add(r.market); count++;
    totals[r.index_id === 'BTC' ? 'BTC' : r.index_id === 'ETH' ? 'ETH' : 'Others'] += value;
    oldestTrade = Math.min(oldestTrade, traded * 1000); newestTrade = Math.max(newestTrade, traded * 1000);
  }
  const total = totals.BTC + totals.ETH + totals.Others;
  if (!(total > 0) || !(totals.BTC > 0) || !(totals.ETH > 0)) throw new Error('Incomplete open-interest coverage');
  return { total, groups: Object.entries(totals).map(([name, usd]) => ({ name, usd, share: usd / total * 100 })),
    btcEthRatio: totals.BTC / totals.ETH, contracts: count, exchanges: exchanges.size, excluded,
    oldestTrade: new Date(oldestTrade).toISOString(), newestTrade: new Date(newestTrade).toISOString(),
    source: 'CoinGecko', sourceUrl: 'https://www.coingecko.com/en/derivatives',
    note: 'CoinGecko coverage, not the Coinalyze series. Includes perpetuals and dated futures traded within 24h; Others includes any non-BTC/ETH underlying, including TradFi.' };
}

const FUNDS = { btc: ['IBIT', 'BITB', 'ARKB'], eth: ['ETHA', 'ETHW'] };
function etfFlows(body, asset) {
  requireRows(body.data);
  const expected = FUNDS[asset];
  if (!expected) throw new Error('Unsupported ETF asset');
  const days = new Map();
  for (const r of body.data) {
    const d = date(r.date);
    if (!d || r.asset !== asset || !expected.includes(r.ticker)) continue;
    if (!days.has(d)) days.set(d, new Map());
    // Duplicate publisher records must not double-count a fund.
    const funds = days.get(d);
    const fund = { ticker: r.ticker, flow: number(r.flowUsd), holdings: number(r.holdings) };
    if (funds.has(r.ticker) && JSON.stringify(funds.get(r.ticker)) !== JSON.stringify(fund)) throw new Error('Conflicting ETF fund records');
    funds.set(r.ticker, fund);
  }
  const history = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([d, funds]) => {
    const entries = expected.map(ticker => funds.get(ticker) || { ticker, flow: null, holdings: null });
    const reported = entries.filter(f => f.flow !== null);
    return { date: d, flow: reported.length ? reported.reduce((s, f) => s + f.flow, 0) : null,
      complete: reported.length === expected.length, reported: reported.length, funds: entries };
  }).slice(-90);
  requireRows(history);
  return { asset: asset.toUpperCase(), expected, history, latest: history.at(-1),
    source: 'XOOMAR', sourceUrl: 'https://xoomar.com/markets/api/etf-flows',
    note: 'Holdings-derived USD flow for covered funds only, not total US ETF net creations. Missing reports are not zero.',
    attribution: 'Data: XOOMAR · Holdings: iShares, Bitwise' + (asset === 'btc' ? ', ARK 21Shares' : '') };
}

const SHORT = ['age_0d_1d', 'age_1d_1w', 'age_1w_1m', 'age_1m_3m', 'age_3m_6m'];
const LONG = ['age_6m_1y', 'age_1y_2y', 'age_2y_3y', 'age_3y_4y', 'age_4y_5y', 'age_5y_7y', 'age_7y_10y', 'age_10y'];
function holderMovement(rows) {
  requireRows(rows);
  const byDate = new Map();
  for (const r of rows) {
    const d = date(r.d), values = [...SHORT, ...LONG].map(k => number(r[k]));
    if (!d || values.some(v => v === null || v < 0)) continue;
    const short = values.slice(0, SHORT.length).reduce((a, b) => a + b, 0);
    const long = values.slice(SHORT.length).reduce((a, b) => a + b, 0);
    if (short + long > 0) byDate.set(d, { date: d, short, long });
  }
  const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  requireRows(series);
  const delta = (r, days) => {
    const previous = byDate.get(new Date(Date.parse(r.date) - days * DAY).toISOString().slice(0, 10));
    return previous ? { long: r.long - previous.long, short: r.short - previous.short } : { long: null, short: null };
  };
  const latest = series.at(-1);
  return { latest, changes: { '1': delta(latest, 1), '7': delta(latest, 7), '30': delta(latest, 30) },
    history: series.slice(-180).map(r => ({ ...r, change30: delta(r, 30) })),
    source: 'BGeometrics', sourceUrl: 'https://bitcoin-data.com/bguser/free-features.html',
    note: 'UTXO-age proxy: long-term ≥6 months; short-term <6 months. Not the standard 155-day entity-adjusted cohorts. Changes include coins aging between bands and issuance, not just buying or selling.' };
}

function recordedLiquidations(body, instruments) {
  if (body.code !== '0' || instruments.code !== '0') throw new Error('OKX did not return successful data');
  requireRows(instruments.data);
  const instrument = instruments.data.find(r => r.instId === 'BTC-USDT-SWAP');
  const ctVal = number(instrument?.ctVal), mult = number(instrument?.ctMult);
  if (!ctVal || !mult || instrument.ctValCcy !== 'BTC' || instrument.ctType !== 'linear') throw new Error('Unsupported OKX contract denomination');
  if (!Array.isArray(body.data)) throw new Error('Invalid OKX liquidation response');
  const events = [];
  for (const group of body.data) {
    if (group.instId !== 'BTC-USDT-SWAP') continue;
    for (const r of group.details || []) {
      const price = number(r.bkPx), size = number(r.sz), t = number(r.ts);
      if (!price || price < 0 || !size || size < 0 || !t || !['long', 'short'].includes(r.posSide)) continue;
      events.push({ price, side: r.posSide, usd: price * size * ctVal * mult, time: t });
    }
  }
  const buckets = new Map();
  for (const e of events) {
    const price = Math.floor(e.price / 100) * 100;
    if (!buckets.has(price)) buckets.set(price, { price, long: 0, short: 0 });
    buckets.get(price)[e.side] += e.usd;
  }
  return { mode: 'recorded', bins: [...buckets.values()].sort((a, b) => a.price - b.price),
    count: events.length, long: events.filter(e => e.side === 'long').reduce((s, e) => s + e.usd, 0),
    short: events.filter(e => e.side === 'short').reduce((s, e) => s + e.usd, 0),
    from: events.length ? new Date(Math.min(...events.map(e => e.time))).toISOString() : null,
    to: events.length ? new Date(Math.max(...events.map(e => e.time))).toISOString() : null,
    source: 'OKX', sourceUrl: 'https://www.okx.com/trade-swap/btc-usdt-swap',
    note: 'Recorded BTC-USDT swap liquidations at bankruptcy prices, grouped in $100 bands. USD notional uses the contract size. One venue’s returned window, not a 24h total or a forecast of future liquidation levels.' };
}

function modeledLiquidations(body) {
  if (body.code !== '0') throw new Error('CoinGlass rejected the request; check the key and plan');
  const data = body.data?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('CoinGlass map schema changed');
  const levels = new Map();
  for (const entries of Object.values(data)) {
    if (!Array.isArray(entries)) continue;
    for (const row of entries) {
      if (!Array.isArray(row)) continue;
      const price = number(row[0]), level = number(row[1]);
      if (!price || price < 0 || level === null || level < 0) continue;
      levels.set(price, (levels.get(price) || 0) + level);
    }
  }
  const bins = [...levels].sort(([a], [b]) => a - b).map(([price, level]) => ({ price, level }));
  requireRows(bins);
  return { mode: 'modeled', bins, source: 'CoinGlass', sourceUrl: 'https://www.coinglass.com/pro/futures/LiquidationMap',
    note: 'Binance BTCUSDT · 1-day model · aggregated leverage levels. Provider-estimated liquidation intensity, not executed trades or guaranteed future liquidations.' };
}

async function json(url, headers = {}) {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(new URL(url).hostname + ' HTTP ' + r.status);
  return r.json();
}
async function load(kind, mode) {
  if (kind === 'oi') return openInterest(await json('https://api.coingecko.com/api/v3/derivatives'));
  if (kind === 'etf-btc' || kind === 'etf-eth') {
    const asset = kind.slice(4);
    return etfFlows(await json('https://xoomar.com/api/markets/etf-flows?asset=' + asset + '&days=90'), asset);
  }
  if (kind === 'holders') return holderMovement(await json('https://bitcoin-data.com/v1/hodl-waves-supply'));
  if (kind === 'liquidations' && mode === 'modeled') {
    if (!process.env.COINGLASS_API_KEY) {
      const error = new Error('The forward-looking map requires a CoinGlass API key with liquidation-map access. Recorded liquidations are available without a key.');
      error.code = 'provider_not_configured'; throw error;
    }
    return modeledLiquidations(await json('https://open-api-v4.coinglass.com/api/futures/liquidation/map?exchange=Binance&symbol=BTCUSDT&range=1d', { 'CG-API-KEY': process.env.COINGLASS_API_KEY }));
  }
  if (kind === 'liquidations') {
    const [events, instruments] = await Promise.all([
      json('https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=BTC-USDT&state=filled&limit=100'),
      json('https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=BTC-USDT-SWAP')
    ]);
    return recordedLiquidations(events, instruments);
  }
  throw new Error('Unknown dataset');
}
module.exports = { number, date, openInterest, etfFlows, holderMovement, recordedLiquidations, modeledLiquidations, load };
