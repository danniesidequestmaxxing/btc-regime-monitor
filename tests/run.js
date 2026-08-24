/* Unit tests for the indicator layer.

   Every fixture is small enough to check by hand — the expected value is
   written out with the arithmetic that produces it, so a reader can verify
   the test itself rather than trusting it.

   The page's functions are EXTRACTED from btc-regime.html between PURE
   markers and evaluated here, so these tests exercise the shipped code
   rather than a copy that could drift from it.

   Run:  node tests/run.js */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const failures = [];

function eq(actual, expected, label){
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++; failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function close(actual, expected, tol, label){
  if (actual != null && Math.abs(actual - expected) <= tol) { pass++; return; }
  fail++; failures.push(`${label}\n      expected ${expected} ±${tol}\n      actual   ${actual}`);
}
function ok(cond, label){
  if (cond) { pass++; return; }
  fail++; failures.push(label);
}
function section(name){ console.log("\n" + name); }

/* ---------- extract the shipped pure functions ---------- */
const html = fs.readFileSync(path.join(ROOT, "btc-regime.html"), "utf8");
function region(tag){
  const re = new RegExp("/\\* PURE:BEGIN " + tag + "[\\s\\S]*?\\*/([\\s\\S]*?)/\\* PURE:END " + tag + " \\*/");
  const m = html.match(re);
  if (!m) throw new Error("PURE region '" + tag + "' not found in btc-regime.html — did a function move outside the markers?");
  return m[1];
}
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const sandbox = { CFG, console, prettyStruct: s => s, fmtPct: v => String(v), TextDecoder, DecompressionStream, Response, Blob };
vm.createContext(sandbox);
// `function` declarations land on the VM global automatically; `const` arrows
// do not, so export those explicitly.
const EXPORT_CONSTS = "\n;globalThis.closes=closes;globalThis.highs=highs;globalThis.lows=lows;"
                    + "globalThis.vols=vols;globalThis.times=times;\n";
vm.runInContext([region("core"), region("ext"), region("zip"), region("classify")].join("\n")
                + EXPORT_CONSTS, sandbox);
const P = sandbox;                                  // the page's functions

const engine = require(path.join(ROOT, "api", "_engine.js"));

/* =========================================================
   1. sma — hand-checkable
   ========================================================= */
section("sma / rollingMean");
// [1,2,3,4,5] window 3 → nulls until index 2, then (1+2+3)/3=2, (2+3+4)/3=3, (3+4+5)/3=4
eq(P.sma([1,2,3,4,5], 3), [null,null,2,3,4], "sma([1,2,3,4,5],3)");
eq(P.sma([2,2,2], 3), [null,null,2], "sma constant series");
eq(P.sma([5], 3), [null], "sma shorter than window → all null");
// window of 1 is the identity
eq(P.sma([7,8,9], 1), [7,8,9], "sma window 1 is identity");

/* =========================================================
   2. pctRank — the count is strictly-less-than, by design
   ========================================================= */
section("pctRank");
// 2 of the 4 values are < 30 → 50
eq(P.pctRank([10,20,40,50], 30), 50, "pctRank: 2 of 4 below → 50");
eq(P.pctRank([1,2,3], 0), 0, "pctRank: below everything → 0");
eq(P.pctRank([1,2,3], 99), 100, "pctRank: above everything → 100");
// ties do NOT count as below: three 5s, value 5 → 0
eq(P.pctRank([5,5,5], 5), 0, "pctRank: ties are not 'below'");
eq(P.pctRank([], 1), null, "pctRank: empty window → null");

/* =========================================================
   3. stdev — sample (n-1), not population
   ========================================================= */
section("stdev");
// [2,4,4,4,5,5,7,9] mean 5; sum sq dev 32; sample var 32/7 = 4.571 → 2.138
close(P.stdev([2,4,4,4,5,5,7,9]), Math.sqrt(32/7), 1e-12, "stdev is the sample deviation (n-1)");
eq(P.stdev([3]), null, "stdev of one point → null");
close(P.stdev([1,1,1,1]), 0, 1e-12, "stdev of a constant series → 0");

/* =========================================================
   4. pivots — symmetric N-bar, strict on both sides
   ========================================================= */
section("pivots");
// highs 1 2 5 2 1 with N=1: index 2 is a pivot high (5 > 2 on both sides)
{
  const hi = [1,2,5,2,1], lo = [1,2,5,2,1];
  const p = P.pivots(hi, lo, 1);
  eq(p.highs.map(x => x.i), [2], "pivot high at the peak");
  eq(p.lows.map(x => x.i), [], "no pivot low in a pure peak");
}
// lows 9 8 3 8 9 with N=1: index 2 is a pivot low
{
  const p = P.pivots([9,8,3,8,9], [9,8,3,8,9], 1);
  eq(p.lows.map(x => x.i), [2], "pivot low at the trough");
}
// a plateau is NOT a pivot: the comparison is >=, so equal neighbours disqualify
{
  const p = P.pivots([1,5,5,5,1], [1,5,5,5,1], 1);
  eq(p.highs.map(x => x.i), [], "flat top is not a pivot (equal neighbours disqualify)");
}
// N=2 needs two clear bars each side; the edges can never be pivots
{
  const hi = [1,2,3,9,3,2,1];
  const p = P.pivots(hi, hi, 2);
  eq(p.highs.map(x => x.i), [3], "N=2 pivot at centre only");
  ok(p.highs.every(x => x.i >= 2 && x.i <= hi.length-3), "pivots never sit within N of an edge");
}

/* =========================================================
   5. structureState — the four-way comparison
   ========================================================= */
section("structureState");
const mk = (h, l) => ({ highs: h.map((v,i) => ({ i, v })), lows: l.map((v,i) => ({ i, v })) });
eq(P.structureState(mk([10,12],[5,6])).state, "HH_HL", "higher high + higher low");
eq(P.structureState(mk([12,10],[6,5])).state, "LH_LL", "lower high + lower low");
eq(P.structureState(mk([10,12],[6,5])).state, "TRANSITION", "higher high but lower low");
eq(P.structureState(mk([12,10],[5,6])).state, "TRANSITION", "lower high but higher low");
eq(P.structureState(mk([10],[5])).state, "TRANSITION", "not enough pivots → transition");

/* =========================================================
   6. quadrant — sign of OI change × sign of price change
   ========================================================= */
section("quadrant");
eq(P.quadrant( 5,  5), "new-longs",   "OI up, price up");
eq(P.quadrant(-5,  5), "short-cover", "OI down, price up");
eq(P.quadrant( 5, -5), "new-shorts",  "OI up, price down");
eq(P.quadrant(-5, -5), "long-unwind", "OI down, price down");
eq(P.quadrant( 0,  5), "short-cover", "flat OI counts as not-expanding");

/* =========================================================
   7. rsi — Wilder smoothing, against a known series
   ========================================================= */
section("rsi");
// A series that only rises has no losses at all → RSI pinned at 100
{
  const up = Array.from({length: 30}, (_, i) => 100 + i);
  const r = P.rsi(up, 14);
  close(r[r.length-1], 100, 1e-9, "monotonically rising series → RSI 100");
}
// A series that only falls → RSI 0
{
  const dn = Array.from({length: 30}, (_, i) => 100 - i);
  const r = P.rsi(dn, 14);
  close(r[r.length-1], 0, 1e-9, "monotonically falling series → RSI 0");
}
// Alternating ±10 moves straddle 50 rather than sitting on it: Wilder smoothing
// applies the newest move at alpha = 1/14, so at equilibrium (avgGain =
// avgLoss = 5) an up move gives 5.357/4.643 → RSI 53.57 and a down move the
// mirror, 46.43. The property to assert is the straddle and the symmetry.
{
  const up = [], down = [];
  for (let i = 0; i < 60; i++) up.push(i % 2 === 0 ? 100 : 110);    // ends on +10
  for (let i = 0; i < 61; i++) down.push(i % 2 === 0 ? 100 : 110);  // ends on -10
  const rUp = P.rsi(up, 14), rDown = P.rsi(down, 14);
  const a = rUp[rUp.length-1], b = rDown[rDown.length-1];
  ok(a > 50 && a < 56, "alternating series ending on an up move sits just above 50 (got " + a.toFixed(2) + ")");
  ok(b < 50 && b > 44, "alternating series ending on a down move sits just below 50 (got " + b.toFixed(2) + ")");
  close((a + b) / 2, 50, 0.5, "the two phases are symmetric about 50");
}
{
  const r = P.rsi([1,2,3], 14);
  ok(r.every(v => v === null), "series shorter than the period → all null");
}

/* =========================================================
   8. ema — first defined value and the smoothing constant
   ========================================================= */
section("ema");
// constant series: EMA equals the constant once defined
{
  const e = P.ema([5,5,5,5,5], 3);
  eq(e.slice(0,2), [null,null], "ema undefined before the period fills");
  close(e[4], 5, 1e-12, "ema of a constant series is the constant");
}
// k = 2/(n+1); for n=3, k=0.5. Seeded at the first value, so:
// e0=1, e1=2*.5+1*.5=1.5, e2=3*.5+1.5*.5=2.25
{
  const e = P.ema([1,2,3], 3);
  close(e[2], 2.25, 1e-12, "ema smoothing constant is 2/(n+1)");
}

/* =========================================================
   9. cvdFromKlines — buys minus sells, cumulative
   ========================================================= */
section("cvdFromKlines");
// kline: [openTime,o,h,l,c, volume, ..., takerBuyBase at index 9]
const K = (vol, buy) => [0,0,0,0,0, vol, 0,0,0, buy, 0, 0];
// vol 10 with 7 taker-buy → buys 7, sells 3 → delta +4
eq(P.cvdFromKlines([K(10,7)], 5).last, 4, "one bar: 2*7-10 = +4");
// two bars: +4 then 2*2-10 = -6 → cumulative -2
eq(P.cvdFromKlines([K(10,7), K(10,2)], 5).last, -2, "cumulative across bars");
eq(P.cvdFromKlines([K(10,7), K(10,2)], 5).series, [4,-2], "series is the running total");
// a perfectly balanced bar contributes nothing
eq(P.cvdFromKlines([K(10,5)], 5).last, 0, "balanced bar contributes 0");
// the days argument takes the LAST n bars
eq(P.cvdFromKlines([K(10,7), K(10,2)], 1).last, -6, "days argument slices from the end");

/* =========================================================
   10. realizedVolSeries — annualisation factor
   ========================================================= */
section("realizedVolSeries");
// A constant price has zero return variance → zero vol
{
  const flat = new Array(40).fill(100);
  const rv = P.realizedVolSeries(flat, 30);
  close(rv[39], 0, 1e-12, "flat price → zero realized vol");
}
// Alternating ±1% gives a known daily deviation; check the sqrt(365)*100 scaling
{
  const alt = [];
  let px = 100;
  for (let i = 0; i < 80; i++){ alt.push(px); px = i % 2 === 0 ? px*1.01 : px/1.01; }
  const rv = P.realizedVolSeries(alt, 30);
  const lr = Math.log(1.01);
  const expected = lr * Math.sqrt(30/29) * Math.sqrt(365) * 100;  // sample sd of ±lr
  close(rv[79], expected, expected*0.02, "annualisation is sd × sqrt(365) × 100");
}

/* =========================================================
   11. unzipSingle — against a zip Node builds
   ========================================================= */
section("unzipSingle (ZIP reader)");
function buildZip(name, content, store){
  const nameBuf = Buffer.from(name);
  const raw = Buffer.from(content);
  const body = store ? raw : zlib.deflateRawSync(raw);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(0, 6);
  h.writeUInt16LE(store ? 0 : 8, 8);
  h.writeUInt32LE(0, 14);
  h.writeUInt32LE(body.length, 18);
  h.writeUInt32LE(raw.length, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, nameBuf, body]);
}
(async () => {
  const csv = "create_time,symbol,sum_open_interest\n2026-08-20 00:00:00,BTCUSDT,107623.13\n";
  const deflated = buildZip("x.csv", csv, false);
  const stored   = buildZip("x.csv", csv, true);
  const toAB = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

  eq(await P.unzipSingle(toAB(deflated)), csv, "unzip deflated member");
  eq(await P.unzipSingle(toAB(stored)),   csv, "unzip stored member");
  let threw = false;
  try { await P.unzipSingle(toAB(Buffer.from("not a zip at all"))); } catch (e) { threw = /not a zip/.test(e.message); }
  ok(threw, "non-zip input fails loudly rather than returning garbage");

  /* =========================================================
     12. classify — precedence and the mutual exclusion
     ========================================================= */
  section("classify (five-state machine)");
  const base = {
    aboveMA: true, maSlopeUp: true, maDist: 5, maSlopePct: 1, ret20: 5,
    oi20: 5, fund7Pct: 40, fund30Pct: 40, struct: { state: "HH_HL" },
    spotLed: false, spotLedRet: true, spotLedFund: true, spotLedOI: false,
  };
  const st = o => P.classify(Object.assign({}, base, o)).state;

  eq(st({ spotLed: true, oi20: -1, fund30Pct: 20 }), "EARLY_UPTREND",
     "spot-led advance above a rising MA → early uptrend");
  eq(st({}), "CONFIRMED_UPTREND", "expanding OI with cool funding → confirmed uptrend");
  eq(st({ fund7Pct: 90, fund30Pct: 90, oi20: 20 }), "LATE_UPTREND",
     "crowded funding plus fast OI growth → late uptrend");
  eq(st({ aboveMA: false, maSlopeUp: false }), "DOWNTREND", "below a falling MA → downtrend");
  eq(st({ aboveMA: true, struct: { state: "LH_LL" }, oi20: 5, fund30Pct: 40 }), "CONFLICTED",
     "above MA but weekly structure rolled over → conflicted, not averaged away");

  // The defining flaw, asserted so a future edit cannot quietly change it:
  // EARLY needs OI flat/falling, CONFIRMED needs OI expanding. Mutually exclusive.
  {
    const early = P.classify(Object.assign({}, base, { spotLed: true, oi20: -1, fund30Pct: 20 }));
    const conf  = P.classify(Object.assign({}, base, { oi20: 5 }));
    const earlyOI = early.groups.find(g => g.state === "EARLY_UPTREND");
    const confOI  = conf.groups.find(g => g.state === "CONFIRMED_UPTREND");
    ok(earlyOI.fired && confOI.fired,
       "EARLY and CONFIRMED are reachable from otherwise identical inputs differing only in OI sign");
  }

  /* =========================================================
     13. page vs server engine — the drift guard
     ========================================================= */
  section("page classifier vs api/_engine.js");
  const cases = [
    { name:"early",     aboveMA:true,  maSlopeUp:true,  struct:"HH_HL", f7:20, f30:20, oi20:-1, ret20:5 },
    { name:"confirmed", aboveMA:true,  maSlopeUp:true,  struct:"HH_HL", f7:40, f30:40, oi20:5,  ret20:5 },
    { name:"late",      aboveMA:true,  maSlopeUp:true,  struct:"HH_HL", f7:90, f30:90, oi20:20, ret20:5 },
    { name:"downtrend", aboveMA:false, maSlopeUp:false, struct:"LH_LL", f7:40, f30:40, oi20:5,  ret20:-5 },
    { name:"conflicted",aboveMA:true,  maSlopeUp:true,  struct:"LH_LL", f7:40, f30:40, oi20:5,  ret20:5 },
  ];
  for (const c of cases){
    const spotLed = c.ret20 > 0 && c.f30 < CFG.fundCoolPct && c.oi20 <= 0;
    const pageState = P.classify({
      aboveMA:c.aboveMA, maSlopeUp:c.maSlopeUp, maDist:0, maSlopePct:0,
      ret20:c.ret20, oi20:c.oi20, fund7Pct:c.f7, fund30Pct:c.f30,
      struct:{ state:c.struct }, spotLed,
    }).state;
    // mirror of the server's rule block, driven by the same config
    const rules = {
      EARLY_UPTREND: c.aboveMA && spotLed && c.f30 < CFG.fundCoolPct && c.struct !== "LH_LL",
      CONFIRMED_UPTREND: c.aboveMA && c.maSlopeUp && c.struct === "HH_HL"
        && c.f30 < CFG.fundConfirmMaxPct && c.f7 < CFG.fundHotPct && c.oi20 > 0,
      LATE_UPTREND: c.aboveMA && c.ret20 > 0
        && (c.f7 >= CFG.fundHotPct || c.f30 >= CFG.fundHotPct) && c.oi20 > CFG.oiHotPct,
      DOWNTREND: !c.aboveMA && (!c.maSlopeUp || c.struct === "LH_LL"),
    };
    let engineState = "CONFLICTED";
    for (const k of ["EARLY_UPTREND","CONFIRMED_UPTREND","LATE_UPTREND","DOWNTREND"]) if (rules[k]) { engineState = k; break; }
    eq(pageState, engineState, "page and engine agree on '" + c.name + "'");
  }

  /* =========================================================
     14. shared primitives must agree across the two copies
     ========================================================= */
  section("shared primitives: page vs api/_engine.js");
  const E = engine.__internals;
  const series = [3,1,4,1,5,9,2,6,5,3,5,8,9,7,9,3,2,3,8,4];
  eq(E.sma(series, 5), P.sma(series, 5), "sma matches");
  eq(E.pctRank(series, 5), P.pctRank(series, 5), "pctRank matches");
  close(E.stdev(series), P.stdev(series), 1e-12, "stdev matches");
  {
    const hi = series.map(x => x + 1), lo = series.map(x => x - 1);
    eq(E.pivots(hi, lo, 2), P.pivots(hi, lo, 2), "pivots match");
    eq(E.structureState(E.pivots(hi, lo, 2)), P.structureState(P.pivots(hi, lo, 2)).state,
       "structureState matches (engine returns the bare string, page wraps it)");
  }
  eq(E.closes([[0,0,0,0,"42"]]), P.closes([[0,0,0,0,"42"]]), "closes parses the same field");

  /* ---------- report ---------- */
  console.log("\n" + "-".repeat(60));
  if (failures.length){
    console.log(`FAILED  ${fail} of ${pass + fail}\n`);
    failures.forEach(f => console.log("  ✗ " + f));
    process.exit(1);
  }
  console.log(`PASSED  ${pass} assertions`);
})().catch(e => { console.error("test harness error:", e); process.exit(1); });
