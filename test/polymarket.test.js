"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ApexDb } = require("../src/db");
const {
  normCdf,
  LogitKalmanFilter,
  twapDigitalFairP,
  simulateBookBuy,
  evaluatePolymarketStep,
} = require("../src/polymarket/fairp");

test("normCdf and LogitKalmanFilter produce calibrated probabilities", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  assert.ok(normCdf(2) > 0.97 && normCdf(-2) < 0.03);

  const kf = new LogitKalmanFilter();
  let p = 0.5;
  for (let i = 0; i < 6; i++) p = kf.update(0.72, 0.01);
  assert.ok(p > 0.65 && p < 0.75);
});

test("twapDigitalFairP adjusts dynamically for elapsed TWAP and remaining time", () => {
  const high = twapDigitalFairP({
    spot: 60800,
    openSpot: 60500,
    twapAvg: 60700,
    elapsedSec: 200,
    totalSec: 300,
    sigmaPerSqrtSec: 0.0002,
  });
  const low = twapDigitalFairP({
    spot: 60200,
    openSpot: 60500,
    twapAvg: 60300,
    elapsedSec: 200,
    totalSec: 300,
    sigmaPerSqrtSec: 0.0002,
  });
  assert.ok(high > 0.85);
  assert.ok(low < 0.15);
});

test("simulateBookBuy walks ascending ask levels honestly and includes dynamic fee", () => {
  // Polymarket CLOB returns asks unsorted/descending; simulateBookBuy must sort ascending
  const asks = [
    { price: "0.52", size: "100" },
    { price: "0.45", size: "20" }, // $9.00 at 0.45
    { price: "0.48", size: "100" }, // remaining $16.00 at 0.48
  ];
  const fill = simulateBookBuy(asks, 25);
  assert.ok(fill);
  assert.equal(fill.bestAsk, 0.45);
  assert.ok(fill.vwapPrice > 0.45 && fill.vwapPrice < 0.48);
  assert.ok(fill.feeUsd > 0);
  assert.ok(fill.effectivePrice > fill.vwapPrice);
});

test("evaluatePolymarketStep prioritizes arbitrage pair match and enforces unhedged cap", () => {
  // Holding 50 UP shares bought at $0.44 -> DOWN available at $0.49 => pair = $0.93 (< 98.5c)
  const arb = evaluatePolymarketStep({
    fairPUp: 0.52,
    upAsks: [{ price: "0.52", size: "200" }],
    downAsks: [{ price: "0.49", size: "200" }],
    upShares: 50,
    upCostUsd: 22,
    downShares: 0,
    downCostUsd: 0,
    remainingSec: 120,
  });
  assert.ok(arb);
  assert.equal(arb.side, "DOWN");
  assert.match(arb.reason, /^ARB_MATCH/);

  // Directional edge buy blocked when unhedged exposure already >= maxUnhedgedUsd / maxUnhedgedShares
  const capped = evaluatePolymarketStep({
    fairPUp: 0.8,
    upAsks: [{ price: "0.50", size: "500" }],
    downAsks: [{ price: "0.52", size: "500" }],
    upShares: 250,
    upCostUsd: 125,
    downShares: 0,
    downCostUsd: 0,
    remainingSec: 120,
    maxUnhedgedUsd: 110,
    maxUnhedgedShares: 85,
  });
  assert.equal(capped, null);

  // Never hedge opposite side at guaranteed loss (downVwap=0.14 + upAsk=0.97 = 1.11 > 1.00)
  const noLossHedge = evaluatePolymarketStep({
    fairPUp: 0.99,
    upAsks: [{ price: "0.97", size: "500" }],
    downAsks: [{ price: "0.04", size: "500" }],
    upShares: 0,
    upCostUsd: 0,
    downShares: 80,
    downCostUsd: 11.2,
    remainingSec: 80,
  });
  assert.equal(noLossHedge, null);
});

test("ApexDb records Polymarket fills and settles window PnL accurately", () => {
  const db = new ApexDb(":memory:");
  db.upsertPmWindow({
    slug: "btc-updown-5m-test",
    asset: "BTC",
    title: "BTC 5m Test",
    startTs: 1000,
    endTs: 301000,
    openSpot: 60000,
    upTokenId: "U1",
    downTokenId: "D1",
  });

  db.recordPmFill({
    windowSlug: "btc-updown-5m-test",
    asset: "BTC",
    side: "UP",
    shares: 50,
    price: 0.44,
    feeUsd: 0.3,
    costUsd: 22.3,
    fairP: 0.55,
    edge: 0.11,
    reason: "EDGE_BUY",
    ts: 2000,
  });

  db.recordPmFill({
    windowSlug: "btc-updown-5m-test",
    asset: "BTC",
    side: "DOWN",
    shares: 50,
    price: 0.49,
    feeUsd: 0.35,
    costUsd: 24.85,
    fairP: 0.45,
    edge: 0.07,
    reason: "ARB_MATCH",
    ts: 3000,
  });

  const settled = db.settlePmWindow("btc-updown-5m-test", "UP");
  assert.equal(settled.status, "SETTLED");
  assert.equal(settled.matched_shares, 50);
  // Payout = 50 * $1.00 = $50.00; totalCost = $22.30 + $24.85 = $47.15 => PnL = +$2.85
  assert.ok(Math.abs(settled.realized_pnl_usd - 2.85) < 1e-4);

  const st = db.pmStats();
  assert.equal(st.wins, 1);
  assert.equal(st.matchedPct, 100);
});
