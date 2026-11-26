"use strict";

/*
 * Pure Maker Pair-Arb + Skewed Quoting Engine (0% Maker Fee on Polymarket):
 *   - Posts passive BID quotes on UP & DOWN such that Bid_UP + Bid_DOWN <= $0.965
 *   - Honest fill simulation: a resting bid ONLY fills if live CLOB bestAsk <= quotePrice
 *   - Inventory-skewed quoting: pauses overweight side and skews underweight bid up to 0.985 - vwap
 *   - Never pays taker fees on directional guesses; locks guaranteed +1.5c..+3.5c spreads
 */

const { clamp } = require("../solana/util");
const { simulateBookBuy } = require("./fairp");

const roundCents = (p) => Math.round(clamp(p, 0.01, 0.99) * 100) / 100;

function computeMakerPlan({
  fairPUp,
  upBestBid,
  upBestAsk,
  downBestBid,
  downBestAsk,
  upAsks = [],
  downAsks = [],
  upShares = 0,
  upCostUsd = 0,
  downShares = 0,
  downCostUsd = 0,
  remainingSec = 300,
  maxPairSum = 0.965,
  maxHedgePairSum = 0.985,
  targetShares = 30,
  maxUnhedgedShares = 65,
}) {
  // Do not rest passive bids in the final 25s (adverse selection risk)
  if (remainingSec < 25 || remainingSec > 296) {
    return { upBid: null, downBid: null, instantTake: null };
  }

  if (
    upBestBid == null ||
    upBestAsk == null ||
    downBestBid == null ||
    downBestAsk == null
  ) {
    return { upBid: null, downBid: null, instantTake: null };
  }

  const fairPDown = 1 - fairPUp;
  const upVwap = upShares > 0 ? upCostUsd / upShares : null;
  const downVwap = downShares > 0 ? downCostUsd / downShares : null;
  const excessUp = upShares - downShares;
  const excessDown = downShares - upShares;

  // 1. If imbalanced and opposite side bestAsk locks guaranteed >= 1.5c profit even with taker fee, lock immediately
  if (excessUp > 4 && upVwap != null) {
    const matchSh = Math.min(35, excessUp);
    const estUsd = Math.max(5.5, matchSh * downBestAsk * 1.03);
    const fill = simulateBookBuy(downAsks, Math.min(25, estUsd));
    if (fill && upVwap + fill.effectivePrice <= 0.983) {
      return {
        upBid: null,
        downBid: null,
        instantTake: {
          side: "DOWN",
          fill,
          fairP: fairPDown,
          edge: Number((1 - (upVwap + fill.effectivePrice)).toFixed(4)),
          reason: `MAKER_ARB_LOCK pair=${((upVwap + fill.effectivePrice) * 100).toFixed(1)}¢`,
        },
      };
    }
  }

  if (excessDown > 4 && downVwap != null) {
    const matchSh = Math.min(35, excessDown);
    const estUsd = Math.max(5.5, matchSh * upBestAsk * 1.03);
    const fill = simulateBookBuy(upAsks, Math.min(25, estUsd));
    if (fill && downVwap + fill.effectivePrice <= 0.983) {
      return {
        upBid: null,
        downBid: null,
        instantTake: {
          side: "UP",
          fill,
          fairP: fairPUp,
          edge: Number((1 - (downVwap + fill.effectivePrice)).toFixed(4)),
          reason: `MAKER_ARB_LOCK pair=${((downVwap + fill.effectivePrice) * 100).toFixed(1)}¢`,
        },
      };
    }
  }

  // 2. Compute two-sided passive Maker BID quotes
  let upBid = roundCents(
    Math.min(fairPUp - 0.02, upBestAsk - 0.01, upBestBid + 0.01),
  );
  let downBid = roundCents(
    Math.min(fairPDown - 0.02, downBestAsk - 0.01, downBestBid + 0.01),
  );

  // Keep inside realistic tradeable range (16c..82c) so we don't catch falling knives at 2c
  if (upBid < 0.16 || upBid > 0.82) upBid = null;
  if (downBid < 0.16 || downBid > 0.82) downBid = null;

  // Enforce combined pair cost <= maxPairSum (e.g. 96.5c => +3.5c spread)
  if (upBid != null && downBid != null && upBid + downBid > maxPairSum) {
    const excess = (upBid + downBid - maxPairSum) / 2;
    upBid = roundCents(upBid - excess);
    downBid = roundCents(downBid - excess);
    if (upBid < 0.16) upBid = null;
    if (downBid < 0.16) downBid = null;
  }

  // 3. Inventory Skew (Avellaneda-Stoikov style):
  // If overweight UP, suppress UP bid and skew DOWN bid up toward (maxHedgePairSum - upVwap)
  if (excessUp > 4 && upVwap != null) {
    if (excessUp >= maxUnhedgedShares) {
      upBid = null;
    } else if (upBid != null) {
      upBid = roundCents(upBid - 0.03);
      if (upBid < 0.16) upBid = null;
    }
    const maxProfitableDn = roundCents(maxHedgePairSum - upVwap);
    if (maxProfitableDn >= 0.12 && downBestAsk > 0.05) {
      const targetDn = Math.min(
        maxProfitableDn,
        downBestAsk - 0.01,
        fairPDown - 0.005,
      );
      downBid = targetDn >= 0.12 ? roundCents(targetDn) : null;
    } else {
      downBid = null;
    }
  } else if (excessDown > 4 && downVwap != null) {
    if (excessDown >= maxUnhedgedShares) {
      downBid = null;
    } else if (downBid != null) {
      downBid = roundCents(downBid - 0.03);
      if (downBid < 0.16) downBid = null;
    }
    const maxProfitableUp = roundCents(maxHedgePairSum - downVwap);
    if (maxProfitableUp >= 0.12 && upBestAsk > 0.05) {
      const targetUp = Math.min(
        maxProfitableUp,
        upBestAsk - 0.01,
        fairPUp - 0.005,
      );
      upBid = targetUp >= 0.12 ? roundCents(targetUp) : null;
    } else {
      upBid = null;
    }
  }

  return {
    upBid:
      upBid != null
        ? {
            price: upBid,
            shares: excessDown > 4 ? Math.min(35, excessDown) : targetShares,
          }
        : null,
    downBid:
      downBid != null
        ? {
            price: downBid,
            shares: excessUp > 4 ? Math.min(35, excessUp) : targetShares,
          }
        : null,
    instantTake: null,
  };
}

// Honest passive fill check: fills ONLY when live market bestAsk crosses down to <= restingBid.price
function checkRestingBidFill(restingBid, bestAsk, rawAsks, fairP) {
  if (!restingBid || bestAsk == null || bestAsk > restingBid.price) return null;

  const matchingAsks = (rawAsks || [])
    .map((a) => ({ price: Number(a.price), size: Number(a.size) }))
    .filter(
      (a) =>
        Number.isFinite(a.price) &&
        Number.isFinite(a.size) &&
        a.price > 0 &&
        a.price <= restingBid.price &&
        a.size > 0,
    );

  const availShares = matchingAsks.reduce((s, a) => s + a.size, 0);
  if (availShares < 5) return null;

  const filledShares = Number(
    Math.min(restingBid.shares, availShares).toFixed(4),
  );
  const fillPrice = restingBid.price; // conservative: filled at our resting limit price, 0% maker fee!
  const costUsd = Number((filledShares * fillPrice).toFixed(4));

  return {
    shares: filledShares,
    price: fillPrice,
    feeUsd: 0,
    costUsd,
    fairP,
    edge: Number((fairP - fillPrice).toFixed(4)),
  };
}

module.exports = {
  computeMakerPlan,
  checkRestingBidFill,
};
