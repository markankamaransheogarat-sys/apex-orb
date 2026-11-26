"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ApexDb } = require("../src/db");
const {
  computeMakerPlan,
  checkRestingBidFill,
} = require("../src/polymarket/maker");
const { scoreAlphaAndMicrostructure } = require("../src/engine/scoring");

test("computeMakerPlan enforces paired bid sum <= 0.965 and skews quotes when imbalanced", () => {
  const plan = computeMakerPlan({
    fairPUp: 0.5,
    upBestBid: 0.49,
    upBestAsk: 0.51,
    downBestBid: 0.49,
    downBestAsk: 0.51,
    upShares: 0,
    downShares: 0,
    remainingSec: 200,
  });
  assert.ok(plan.upBid && plan.downBid);
  assert.ok(plan.upBid.price + plan.downBid.price <= 0.965 + 1e-9);

  // When holding 40 UP shares at 0.44, and DOWN ask is 0.52, instantTake locks pair <= 0.983
  const lockPlan = computeMakerPlan({
    fairPUp: 0.46,
    upBestBid: 0.47,
    upBestAsk: 0.49,
    downBestBid: 0.51,
    downBestAsk: 0.52,
    upAsks: [{ price: "0.49", size: "100" }],
    downAsks: [{ price: "0.52", size: "100" }],
    upShares: 40,
    upCostUsd: 17.6, // vwap = 0.44
    downShares: 0,
    downCostUsd: 0,
    remainingSec: 150,
  });
  assert.ok(lockPlan.instantTake);
  assert.equal(lockPlan.instantTake.side, "DOWN");
  assert.match(lockPlan.instantTake.reason, /^MAKER_ARB_LOCK/);
});

test("checkRestingBidFill only fills when market bestAsk crosses <= restingBid with 0% fee", () => {
  const bid = { price: 0.47, shares: 30 };
  // Market bestAsk above bid -> no fill
  assert.equal(
    checkRestingBidFill(bid, 0.48, [{ price: "0.48", size: "50" }], 0.52),
    null,
  );

  // Market crosses down to 0.46 -> fills at 0.47 with 0% fee
  const fill = checkRestingBidFill(
    bid,
    0.46,
    [{ price: "0.46", size: "50" }],
    0.52,
  );
  assert.ok(fill);
  assert.equal(fill.shares, 30);
  assert.equal(fill.price, 0.47);
  assert.equal(fill.feeUsd, 0);
  assert.equal(fill.costUsd, 14.1);
});

test("ApexDb tracks ALPHA_WHALES and boosts Alpha score on hits", () => {
  const db = new ApexDb(":memory:");
  db.creditAlphaWhale({
    wallet: "Whale111",
    role: "WHALE",
    symbol: "GEM",
    mint: "Mint1",
    isWin: true,
  });
  db.creditAlphaWhale({
    wallet: "Whale111",
    role: "WHALE",
    symbol: "GEM2",
    mint: "Mint2",
    isWin: true,
  });

  const hits = db.getAlphaWhales(["Whale111", "Other222"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].win_tokens, 2);

  const scored = scoreAlphaAndMicrostructure({
    market: {
      liquidityUsd: 80_000,
      turnoverToLiq: 5,
      m5: { buys: 20, sells: 10, txs: 30, ofi: 0.33, changePct: 10 },
    },
    curve: null,
    holders: [
      { i: 0, share: 0.03 },
      { i: 1, share: 0.02 },
    ],
    operators: [
      { id: null, wallets: [0] },
      { id: null, wallets: [1] },
    ],
    safety: { score: 85, band: "CLEAN" },
    whaleHits: hits,
  });
  assert.ok(scored.warnings.some((w) => /ALPHA_WHALES DETECTED/.test(w)));
});
