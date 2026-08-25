/* Same-origin relay for the market-data hosts the page reads directly.

   Why this exists: every panel below the price header is driven by
   fapi.binance.com, and a browser can fail to reach that host for reasons the
   page cannot see or fix — a regional block on the futures API, a DNS or
   corporate filter, an ad blocker with a crypto list. The failure surfaces as
   a bare TypeError ("Failed to fetch"), so there is no status code to react
   to and no upstream to retry against.

   The relay is the retry. Vercel's function runs in fra1 and reaches these
   hosts fine, so the page can ask its own origin for the same bytes. The
   client only falls back here after a direct fetch has actually failed (or
   returned 403/451), so the normal path stays browser-to-exchange with no
   added hop, and a viewer opening the file off disk is unaffected.

   Everything is pass-through: same bytes, same content type, no parsing. The
   host allowlist keeps it from being a general-purpose open proxy. */

const ALLOW = new Set([
  "api.binance.com",
  "data-api.binance.vision",
  "data.binance.vision",
  "fapi.binance.com",
  "dapi.binance.com",
  "www.deribit.com",
  "api.bybit.com",
  "www.okx.com",
  "api.hyperliquid.xyz",
  "api.exchange.coinbase.com",
  "stablecoins.llama.fi",
  "bitcoin-data.com",
  "api.coingecko.com",
]);

/* Only hyperliquid needs a POST; everything else is a plain GET. */
const POST_OK = new Set(["api.hyperliquid.xyz"]);

/* The bulk archive files are immutable once published, so they can sit in the
   CDN for a day. Live endpoints get a short shared window: long enough to
   collapse a room full of viewers into one upstream call, short enough that
   funding and open interest still move on the page. */
function cachePolicy(host){
  if (host === "data.binance.vision") return "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800";
  return "public, max-age=0, s-maxage=15, stale-while-revalidate=60";
}

function rawBody(req){
  if (req.body === undefined || req.body === null) return null;
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body;
  return JSON.stringify(req.body);
}

module.exports = async (req, res) => {
  // Marks the response as having come from this route. The page uses it to
  // tell "the relay answered" from "this deployment has no relay" — a static
  // host answers /api/relay with its own 404, which carries no such header.
  res.setHeader("x-relay", "1");
  res.setHeader("Cache-Control", "no-store");   // failures must never cache

  const fail = (code, error, detail) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error, detail }));
  };

  let target;
  try {
    const u = new URL(req.url, "http://x").searchParams.get("u");
    if (!u) return fail(400, "missing_url", "pass the upstream URL as ?u=<encoded>");
    target = new URL(u);
  } catch (e) {
    return fail(400, "bad_url", String(e && e.message || e));
  }

  if (target.protocol !== "https:") return fail(400, "bad_scheme", "https only");
  if (!ALLOW.has(target.hostname)) return fail(403, "host_not_allowed", target.hostname + " is not on the relay allowlist");

  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") return fail(405, "bad_method", method);
  if (method === "POST" && !POST_OK.has(target.hostname))
    return fail(405, "post_not_allowed", "POST is only relayed to " + [...POST_OK].join(", "));

  try {
    const init = { method, headers: { accept: req.headers.accept || "*/*" } };
    if (method === "POST"){
      init.body = rawBody(req);
      init.headers["content-type"] = req.headers["content-type"] || "application/json";
    }
    const r = await fetch(target.toString(), init);
    const buf = Buffer.from(await r.arrayBuffer());

    res.statusCode = r.status;
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    if (r.ok) res.setHeader("Cache-Control", cachePolicy(target.hostname));
    res.end(buf);
  } catch (e) {
    // The relay itself could not reach the upstream. 502 keeps this distinct
    // from an upstream error, which is forwarded with its own status above.
    fail(502, "upstream_unreachable", String(e && e.message || e));
  }
};
