const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openInterest, etfFlows, holderMovement, recordedLiquidations, modeledLiquidations } = require('../lib/market-context');
const NOW = Date.parse('2026-10-06T12:00:00Z');
const contract = (symbol, asset, oi, extra = {}) => ({ symbol, market: 'A', index_id: asset, open_interest: oi, contract_type: 'perpetual', last_traded_at: NOW / 1000, ...extra });

test('OI uses USD sums, excludes stale/expired/missing entries and deduplicates contracts', () => {
  const result = openInterest([
    contract('BTCUSD', 'BTC', 600), contract('ETHUSD', 'ETH', 300), contract('SOLUSD', 'SOL', 100),
    contract('BTCUSD', 'BTC', 600), contract('OLD', 'BTC', 1000, { last_traded_at: NOW / 1000 - 86401 }),
    contract('EXPIRED', 'ETH', 1000, { expired_at: NOW / 1000 - 1 }), contract('NULL', 'BTC', null),
    contract('BAD', 'BTC', 'bad'), contract('EMPTY', 'ETH', ''), contract('NEG', 'ETH', -1)
  ], NOW);
  assert.equal(result.total, 1000);
  assert.deepEqual(result.groups.map(r => r.share), [60, 30, 10]);
  assert.equal(result.btcEthRatio, 2);
  assert.equal(result.contracts, 3);
  assert.equal(result.excluded, 7);
  assert.throws(() => openInterest([contract('BTC', 'BTC', 100)], NOW), /Incomplete/);
});

const fund = (date, ticker, flow, asset = 'btc') => ({ date, ticker, flowUsd: flow, asset, holdings: '100' });
test('ETF partial reports are preserved; null is not zero, and duplicate rows do not add flow', () => {
  const data = etfFlows({ data: [
    fund('2026-10-05', 'ARKB', '-20'), fund('2026-10-05', 'IBIT', '100'), fund('2026-10-05', 'BITB', '0'),
    fund('2026-10-06', 'IBIT', null), fund('2026-10-06', 'ARKB', '25'), fund('2026-10-06', 'ARKB', '25'),
    fund('2026-02-30', 'IBIT', '999'), fund('2026-10-06', 'ETHA', '900', 'eth')
  ] }, 'btc');
  assert.equal(data.history.length, 2);
  assert.equal(data.history[0].flow, 80);
  assert.equal(data.history[0].complete, true);
  assert.equal(data.latest.flow, 25);
  assert.equal(data.latest.complete, false);
  assert.equal(data.latest.reported, 1);
  assert.equal(data.latest.funds.find(f => f.ticker === 'BITB').flow, null);
  assert.equal(etfFlows({ data: [fund('2026-10-06', 'ETHA', null, 'eth')] }, 'eth').latest.flow, null);
  assert.throws(() => etfFlows({ data: [fund('2026-10-05', 'IBIT', '10'), fund('2026-10-05', 'IBIT', '11')] }, 'btc'), /Conflicting/);
});

const bands = ['age_0d_1d', 'age_1d_1w', 'age_1w_1m', 'age_1m_3m', 'age_3m_6m', 'age_6m_1y', 'age_1y_2y', 'age_2y_3y', 'age_3y_4y', 'age_4y_5y', 'age_5y_7y', 'age_7y_10y', 'age_10y'];
const cohort = (d, short, long) => ({ d, ...Object.fromEntries(bands.map(k => [k, '0'])), age_0d_1d: short, age_6m_1y: long });
test('Holder deltas use calendar dates, sort source rows, and reject incomplete bands', () => {
  const result = holderMovement([cohort('2026-10-06', 450, 1550), cohort('2026-09-06', 500, 1500),
    cohort('2026-10-05', 460, 1540), { ...cohort('2026-10-07', 100, 100), age_1y_2y: null }]);
  assert.equal(result.latest.date, '2026-10-06');
  assert.deepEqual(result.changes['30'], { long: 50, short: -50 });
  assert.deepEqual(result.changes['1'], { long: 10, short: -10 });
  assert.deepEqual(result.changes['7'], { long: null, short: null });
  assert.equal(result.history[0].change30.long, null);
});

const instrument = { code: '0', data: [{ instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC', ctType: 'linear' }] };
test('Liquidation USD conversion uses contract value and preserves long/short sides', () => {
  const result = recordedLiquidations({ code: '0', data: [{ instId: 'BTC-USDT-SWAP', details: [
    { bkPx: '85010', sz: '2', ts: NOW, posSide: 'long' },
    { bkPx: '85090', sz: '3', ts: NOW + 1000, posSide: 'short' },
    { bkPx: '', sz: '300', ts: NOW, posSide: 'long' }
  ] }, { instId: 'ETH-USDT-SWAP', details: [{ bkPx: '2500', sz: '1000', ts: NOW, posSide: 'long' }] }] }, instrument);
  assert.equal(result.long, 1700.2); // 2 contracts × .01 BTC × $85010
  assert.ok(Math.abs(result.short - 2552.7) < 1e-8);
  assert.equal(result.bins.length, 1);
  assert.equal(result.bins[0].price, 85000);
  assert.equal(result.count, 2);
  assert.equal(recordedLiquidations({ code: '0', data: [] }, instrument).count, 0);
  assert.throws(() => recordedLiquidations({ code: '1', data: [] }, instrument));
});

test('Modeled map sums leverage levels by price and does not invent position sides', () => {
  const result = modeledLiquidations({ code: '0', data: { data: { '85000': [[85000, 10, 25, null], [85000, 15, 50, null]], '86000': [[86000, 30, 100, null]] } } });
  assert.deepEqual(result.bins, [{ price: 85000, level: 25 }, { price: 86000, level: 30 }]);
  assert.throws(() => modeledLiquidations({ code: '0', data: {} }), /schema/);
  assert.throws(() => modeledLiquidations({ code: '400' }), /rejected/);
});

test('API validates requests, protects secrets, isolates errors and coalesces cached fetches', async () => {
  const handler = require('../api/market-context');
  const response = () => ({ headers: {}, statusCode: 0, setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = JSON.parse(v); } });
  let res = response();
  await handler({ method: 'GET', query: { kind: '__proto__' } }, res);
  assert.equal(res.statusCode, 400);
  res = response(); await handler({ method: 'POST', query: { kind: 'oi' } }, res);
  assert.equal(res.statusCode, 405);
  const originalFetch = global.fetch, originalKey = process.env.COINGLASS_API_KEY;
  try {
    delete process.env.COINGLASS_API_KEY;
    res = response(); await handler({ method: 'GET', query: { kind: 'liquidations', mode: 'modeled' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'provider_not_configured');
    assert.equal(res.headers['Cache-Control'], 'no-store');
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: true, json: async () => ({ data: [fund('2026-10-06', 'ETHA', '10', 'eth'), fund('2026-10-06', 'ETHW', '0', 'eth')] }) }; };
    const responses = [response(), response()];
    await Promise.all(responses.map(r => handler({ method: 'GET', query: { kind: 'etf-eth' } }, r)));
    assert.equal(calls, 1);
    assert.equal(responses[0].statusCode, 200);
    assert.match(responses[0].headers['Cache-Control'], /s-maxage=/);
    global.fetch = async () => ({ ok: false, status: 429 });
    res = response(); await handler({ method: 'GET', query: { kind: 'holders' } }, res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    global.fetch = async (url, opts) => { assert.equal(opts.headers['CG-API-KEY'], 'test-secret'); throw new Error('Provider unavailable'); };
    process.env.COINGLASS_API_KEY = 'test-secret';
    res = response(); await handler({ method: 'GET', query: { kind: 'liquidations', mode: 'modeled' } }, res);
    assert.equal(res.statusCode, 502);
    assert.ok(!JSON.stringify(res.body).includes('test-secret'));
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.COINGLASS_API_KEY; else process.env.COINGLASS_API_KEY = originalKey;
  }
});
