"use strict";

/*
 * Polymarket 5m Statistical Arbitrage & Fair-P Quantitative Core:
 *   1. TWAP-adjusted Digital Binary Probability Phi(d2) using Brownian bridge variance (tau / 3)
 *   2. 1D Kalman Filter in Logit Space (x_t = ln(p / (1 - p)))
 *   3. Honest L2 Ask-Depth Walker + Polymarket dynamic crypto fee curve
 *   4. Pair-Match Arbitrage (UP + DOWN < $0.985) + Directional +EV Edge Engine ("Never Sell, Flip & Match")
 */

const { clamp } = require("../solana/util");

// Abramowitz & Stegun 7.1.26 standard normal CDF approximation (error < 1.5e-7)
function normCdf(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

const logit = (p) => {
  const c = clamp(p, 0.005, 0.995);
  return Math.log(c / (1 - c));
};

const invLogit = (x) => 1 / (1 + Math.exp(-clamp(x, -12, 12)));

class LogitKalmanFilter {
  constructor({ processVar = 0.015, measVar = 0.04 } = {}) {
    this.x = 0; // logit(0.5) = 0
    this.p = 0.5; // state variance
    this.q = processVar;
    this.r = measVar;
    this.initialized = false;
  }

  update(probMeasurement, spreadPenalty = 0) {
    const z = logit(probMeasurement);
    if (!this.initialized) {
      this.x = z;
      this.p = 0.2;
      this.initialized = true;
      return invLogit(this.x);
    }
    const pPred = this.p + this.q;
    const rEff = this.r + spreadPenalty;
    const k = pPred / (pPred + rEff);
    this.x = this.x + k * (z - this.x);
    this.p = (1 - k) * pPred;
    return invLogit(this.x);
  }
}

// TWAP-adjusted binary option probability: resolves UP iff final 5m TWAP >= openSpot
function twapDigitalFairP({
  spot,
  openSpot,
  twapAvg,
  elapsedSec,
  totalSec = 300,
  sigmaPerSqrtSec = 0.00022,
}) {
  if (!(spot > 0) || !(openSpot > 0)) return 0.5;
  const elapsed = clamp(elapsedSec, 0, totalSec);
  const rem = Math.max(0.5, totalSec - elapsed);

  if (elapsed <= 1) {
    const vol = Math.max(1e-6, sigmaPerSqrtSec * Math.sqrt(totalSec / 3));
    return clamp(normCdf(Math.log(spot / openSpot) / vol), 0.01, 0.99);
  }

  const avgSoFar = twapAvg > 0 ? twapAvg : spot;
  // Required remaining average to make 5m TWAP == openSpot
  const requiredRemAvg = (totalSec * openSpot - elapsed * avgSoFar) / rem;

  if (requiredRemAvg <= spot * 0.85) return 0.99;
  if (requiredRemAvg >= spot * 1.15) return 0.01;

  // Integrated Brownian motion standard deviation over remaining window: sigma * sqrt(rem / 3)
  const denom = Math.max(1e-6, sigmaPerSqrtSec * Math.sqrt(rem / 3));
  const d2 = Math.log(spot / requiredRemAvg) / denom;
  return clamp(normCdf(d2), 0.01, 0.99);
}

// Polymarket dynamic crypto taker fee rate: peaks ~1.56% around p=0.50, drops sharply at tails
function polymarketTakerFeeRate(price) {
  const p = clamp(price, 0.01, 0.99);
  return 0.25 * Math.pow(p * (1 - p), 2);
}

// Walks sorted ascending asks to simulate honest L2 market-buy execution for targetUsd
function simulateBookBuy(rawAsks, targetUsd) {
  if (!Array.isArray(rawAsks) || !rawAsks.length || !(targetUsd > 0))
    return null;

  const asks = rawAsks
    .map((a) => ({ price: Number(a.price), size: Number(a.size) }))
    .filter(
      (a) =>
        Number.isFinite(a.price) &&
        Number.isFinite(a.size) &&
        a.price > 0 &&
        a.price < 1 &&
        a.size > 0,
    )
    .sort((a, b) => a.price - b.price);

  if (!asks.length) return null;

  const bestAsk = asks[0].price;
  let remainingUsd = targetUsd;
  let totalShares = 0;
  let grossCostUsd = 0;

  for (const lvl of asks) {
    const lvlUsd = lvl.price * lvl.size;
    if (lvlUsd >= remainingUsd) {
      const sh = remainingUsd / lvl.price;
      totalShares += sh;
      grossCostUsd += remainingUsd;
      remainingUsd = 0;
      break;
    } else {
      totalShares += lvl.size;
      grossCostUsd += lvlUsd;
      remainingUsd -= lvlUsd;
    }
  }

  if (totalShares <= 0 || grossCostUsd < Math.min(5, targetUsd * 0.4))
    return null;

  const vwapPrice = grossCostUsd / totalShares;
  const feeRate = polymarketTakerFeeRate(vwapPrice);
  const feeUsd = grossCostUsd * feeRate;
  const totalCostUsd = grossCostUsd + feeUsd;
  const effectivePrice = totalCostUsd / totalShares;

  return {
    bestAsk,
    vwapPrice: Number(vwapPrice.toFixed(4)),
    effectivePrice: Number(effectivePrice.toFixed(4)),
    shares: Number(totalShares.toFixed(4)),
    feeUsd: Number(feeUsd.toFixed(4)),
    costUsd: Number(totalCostUsd.toFixed(4)),
    slippageCents: Number(((vwapPrice - bestAsk) * 100).toFixed(2)),
  };
}

function bestAskOf(rawAsks) {
  if (!Array.isArray(rawAsks) || !rawAsks.length) return null;
  const prices = rawAsks
    .map((a) => Number(a.price))
    .filter((p) => Number.isFinite(p) && p > 0 && p < 1);
  return prices.length ? Math.min(...prices) : null;
}

function evaluatePolymarketStep({
  fairPUp,
  upAsks,
  downAsks,
  upShares = 0,
  upCostUsd = 0,
  downShares = 0,
  downCostUsd = 0,
  remainingSec = 300,
  targetShares = 35,
  orderSizeUsd = 25,
  minEdge = 0.045,
  maxUnhedgedUsd = 90,
  maxUnhedgedShares = 85,
}) {
  if (remainingSec < 18 || remainingSec > 296) return null;

  const fairPDown = 1 - fairPUp;
  const upVwap = upShares > 0 ? upCostUsd / upShares : null;
  const downVwap = downShares > 0 ? downCostUsd / downShares : null;
  const netUnhedgedUsd = Math.abs(upCostUsd - downCostUsd);
  const netUnhedgedShares = Math.abs(upShares - downShares);

  // Priority 1: Share-capped Arbitrage Pair Match (ONLY when UP + DOWN <= $0.985)
  if (upShares > downShares + 4 && upVwap != null) {
    const dnBest = bestAskOf(downAsks);
    if (dnBest != null) {
      const matchShares = Math.min(40, upShares - downShares);
      const matchUsd = Math.min(
        orderSizeUsd,
        Math.max(5.5, matchShares * dnBest * 1.03),
      );
      const downFill = simulateBookBuy(downAsks, matchUsd);
      if (downFill) {
        const pairCost = upVwap + downFill.effectivePrice;
        if (pairCost <= 0.985) {
          return {
            side: "DOWN",
            fill: downFill,
            fairP: fairPDown,
            edge: Number((1 - pairCost).toFixed(4)),
            reason: `ARB_MATCH pair=${(pairCost * 100).toFixed(1)}¢ (<98.5¢)`,
          };
        }
      }
    }
  }

  if (downShares > upShares + 4 && downVwap != null) {
    const upBest = bestAskOf(upAsks);
    if (upBest != null) {
      const matchShares = Math.min(40, downShares - upShares);
      const matchUsd = Math.min(
        orderSizeUsd,
        Math.max(5.5, matchShares * upBest * 1.03),
      );
      const upFill = simulateBookBuy(upAsks, matchUsd);
      if (upFill) {
        const pairCost = downVwap + upFill.effectivePrice;
        if (pairCost <= 0.985) {
          return {
            side: "UP",
            fill: upFill,
            fairP: fairPUp,
            edge: Number((1 - pairCost).toFixed(4)),
            reason: `ARB_MATCH pair=${(pairCost * 100).toFixed(1)}¢ (<98.5¢)`,
          };
        }
      }
    }
  }

  // Priority 2: Share-sized Directional +EV Edge Entry (two-sided book, mid-range odds, capped imbalance)
  const upBest = bestAskOf(upAsks);
  const downBest = bestAskOf(downAsks);
  if (remainingSec < 45 || upBest == null || downBest == null) return null;

  const upFill = simulateBookBuy(
    upAsks,
    Math.min(orderSizeUsd, Math.max(6, targetShares * upBest)),
  );
  const downFill = simulateBookBuy(
    downAsks,
    Math.min(orderSizeUsd, Math.max(6, targetShares * downBest)),
  );
  if (!upFill || !downFill) return null;

  const upEdge =
    upFill.effectivePrice >= 0.2 && upFill.effectivePrice <= 0.86
      ? fairPUp - upFill.effectivePrice
      : -1;
  const downEdge =
    downFill.effectivePrice >= 0.2 && downFill.effectivePrice <= 0.86
      ? fairPDown - downFill.effectivePrice
      : -1;

  if (upEdge >= downEdge && upEdge >= minEdge) {
    if (
      upShares - downShares < maxUnhedgedShares &&
      upCostUsd - downCostUsd < maxUnhedgedUsd &&
      netUnhedgedUsd < maxUnhedgedUsd &&
      netUnhedgedShares < maxUnhedgedShares
    ) {
      return {
        side: "UP",
        fill: upFill,
        fairP: fairPUp,
        edge: Number(upEdge.toFixed(4)),
        reason: `EDGE_BUY +${(upEdge * 100).toFixed(1)}¢ vs FairP`,
      };
    }
  }

  if (downEdge > upEdge && downEdge >= minEdge) {
    if (
      downShares - upShares < maxUnhedgedShares &&
      downCostUsd - upCostUsd < maxUnhedgedUsd &&
      netUnhedgedUsd < maxUnhedgedUsd &&
      netUnhedgedShares < maxUnhedgedShares
    ) {
      return {
        side: "DOWN",
        fill: downFill,
        fairP: fairPDown,
        edge: Number(downEdge.toFixed(4)),
        reason: `EDGE_BUY +${(downEdge * 100).toFixed(1)}¢ vs FairP`,
      };
    }
  }

  return null;
}

module.exports = {
  normCdf,
  logit,
  invLogit,
  LogitKalmanFilter,
  twapDigitalFairP,
  polymarketTakerFeeRate,
  simulateBookBuy,
  evaluatePolymarketStep,
};
