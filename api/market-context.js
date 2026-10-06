const { load } = require('../lib/market-context');
const TTL = { oi: 300, 'etf-btc': 3600, 'etf-eth': 3600, holders: 86400, liquidations: 300 };
// Per-instance cache + request coalescing complement the CDN cache, especially
// for the holder provider's very small free daily request quota.
const cache = new Map(), pending = new Map();
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const kind = req.query?.kind, mode = req.query?.mode || 'recorded';
  if (typeof kind !== 'string' || !Object.hasOwn(TTL, kind) || !['recorded', 'modeled'].includes(mode) || (kind !== 'liquidations' && mode !== 'recorded')) {
    res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_dataset' }));
  }
  const key = kind + ':' + mode, ttl = TTL[kind];
  try {
    let entry = cache.get(key);
    if (!entry || Date.now() - entry.time >= ttl * 1000) {
      if (!pending.has(key)) pending.set(key, load(kind, mode).then(data => {
        const next = { time: Date.now(), body: { ...data, fetchedAt: new Date().toISOString() } };
        cache.set(key, next); return next;
      }).finally(() => pending.delete(key)));
      entry = await pending.get(key);
    }
    // Do not extend an already cached entry's freshness by another full TTL.
    const remaining = Math.max(1, Math.floor(ttl - (Date.now() - entry.time) / 1000));
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=' + remaining);
    res.statusCode = 200; res.end(JSON.stringify(entry.body));
  } catch (e) {
    res.statusCode = e.code === 'provider_not_configured' ? 503 : 502;
    res.end(JSON.stringify({ error: e.code || 'upstream_failed', detail: e.message || 'Source unavailable' }));
  }
};
