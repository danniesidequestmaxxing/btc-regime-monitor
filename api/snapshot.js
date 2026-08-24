const { gather, compute } = require("./_engine.js");
const fs = require("fs");
const path = require("path");

let CFG = null;
function config(){
  if (CFG) return CFG;
  try { CFG = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config.json"), "utf8")); }
  catch (e) { CFG = {}; }
  const D = { maLen:200, maSlopeLookback:20, retLookback:20, oiLookback:20, fundShort:7,
              fundLong:30, pctWindowDays:730, rvLen:30, pivotN:3, fundCoolPct:50,
              fundHotPct:85, fundConfirmMaxPct:80, oiHotPct:10, lsRatioHot:2,
              tierL1Arm:2, tierL2Arm:2 };
  for (const k of Object.keys(D)) if (typeof CFG[k] !== "number") CFG[k] = D[k];
  return CFG;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");   // errors and 401s must not cache

  const want = process.env.SNAPSHOT_TOKEN;
  if (want){
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const url = new URL(req.url, "http://x");
    const got = auth || url.searchParams.get("token") || "";
    if (got !== want){
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "unauthorized", hint: "pass ?token= or an Authorization: Bearer header" }));
    }
  }

  try {
    const snap = compute(await gather(), config());
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
    if (!want) snap.auth = "disabled — set the SNAPSHOT_TOKEN environment variable to require a read-only token";
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 200;
    res.end(JSON.stringify(snap, null, 2));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "upstream_failed", detail: String(e && e.message || e) }));
  }
};
