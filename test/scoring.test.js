"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  priceImpact,
  evaluateShield,
  evaluateGuard,
  scoreSafety,
  scoreAlphaAndMicrostructure,
} = require("../src/engine/scoring");

test("priceImpact follows constant-product sell equation", () => {
  // Selling as many tokens as pool reserve R drops price by 75%
  assert.ok(Math.abs(priceImpact(100, 100) - 0.75) < 1e-9);
  assert.equal(priceImpact(0, 100), 0);
});

test("scoreSafety rewards clean distributed holders and flags Operator Memory recidivists", () => {
  const holders = Array.from({ length: 20 }, (_, i) => ({
    i,
    owner: `W${i}`,
    share: 0.015,
    kind: "buy",
    virgin: false,
    sniper: false,
    sold: false,
    dev: false,
    unread: false,
  }));
  const ops = holders.map((h) => ({
    id: null,
    wallets: [h.i],
    share: h.share,
    weighted: h.share,
    level: null,
  }));

  const clean = scoreSafety(holders, ops, {
    floatTokens: 1_000_000,
    reserveTokens: 500_000,
    liquidityUsd: 80_000,
    unread: 0,
    recidivistRoots: [],
  });
  assert.equal(clean.band, "CLEAN");
  assert.ok(clean.score >= 85);

  const flagged = scoreSafety(holders, ops, {
    floatTokens: 1_000_000,
    reserveTokens: 500_000,
    liquidityUsd: 80_000,
    unread: 0,
    recidivistRoots: [
      {
        root_addr: "BadRoot1111111111111111111111111111111111",
        danger_tokens: 2,
      },
    ],
  });
  assert.equal(flagged.band, "DANGER");
  assert.ok(flagged.score <= 38);
});

test("scoreAlphaAndMicrostructure penalizes wash trading and illiquid exit costs", () => {
  const holders = Array.from({ length: 15 }, (_, i) => ({ i, share: 0.02 }));
  const ops = holders.map((h) => ({
    id: null,
    wallets: [h.i],
    share: h.share,
    weighted: h.share,
  }));
  const safety = { score: 86, band: "CLEAN" };

  const gem = scoreAlphaAndMicrostructure({
    market: {
      liquidityUsd: 90_000,
      turnoverToLiq: 4.5,
      m5: { buys: 42, sells: 14, txs: 56, ofi: 0.5, changePct: 18 },
    },
    curve: { complete: false, mayhem: false, realTokens: 350_000_000 },
    holders,
    operators: ops,
    safety,
  });
  assert.equal(gem.matrix.quadrant, "SNIPER_GEM");
  assert.equal(gem.matrix.action, "PAPER_ENTER");
  assert.ok(gem.score >= 70);

  const washIlliquid = scoreAlphaAndMicrostructure({
    market: {
      liquidityUsd: 3_000,
      turnoverToLiq: 55.0,
      m5: { buys: 30, sells: 28, txs: 58, ofi: 0.03, changePct: 2 },
    },
    curve: null,
    holders,
    operators: ops,
    safety,
  });
  assert.ok(washIlliquid.warnings.length >= 2);
  assert.ok(washIlliquid.score <= 55);
});

test("evaluateShield and evaluateGuard detect serial creators and heavy dev buys", () => {
  const s = evaluateShield(
    { launched: 25, graduated: 1 },
    200_000_000,
    1_000_000_000,
  );
  assert.equal(s.pass, false);
  assert.match(s.reason, /serial creator/i);

  const g = evaluateGuard({
    creator: "Dev111",
    history: { launched: 3, graduated: 2 },
    slot0Share: 0.35,
    devShare: 0.04,
    ownerPowers: {
      mintAuthority: null,
      freezeAuthority: null,
      transferFeeBps: 0,
    },
  });
  assert.equal(g.pass, false);
  assert.match(g.reason, /slot-0/i);
});

test("scoreSafety never gives a silent pass when holders list is empty", () => {
  const unavailable = scoreSafety([], [], { floatTokens: 1, reserveTokens: 0 });
  assert.equal(unavailable.score, null);
  assert.equal(unavailable.band, "UNAVAILABLE");
  assert.equal(unavailable.state, "unavailable");
});
