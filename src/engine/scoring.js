"use strict";

/*
 * Dual-Axis Forensics & Quant Alpha Scoring Engine:
 *   Axis 1 — SAFETY (0..100): Anti-rug holder clustering, price-impact dump, fresh/transfer supply,
 *            snipers, concentration, Red Flags (DANGER), Caps (59 RISKY), Guard & Shield, Operator Memory.
 *   Axis 2 — ALPHA & MICROSTRUCTURE (0..100):
 *            Orderflow Imbalance (OFI), Bonding Curve Velocity / Momentum, Wash-Trading Gate (Turnover/Liq),
 *            Exitability & Cost-to-Impact Gate ($1,000 position slippage), Organic Breadth.
 */

const {
  SAFETY_WEIGHTS,
  SAFETY_SCALE,
  ALPHA_WEIGHTS,
  LIMITS,
} = require("../config");
const { clamp, sum } = require("../solana/util");

function linearPart(weight, val, goodThreshold, badThreshold) {
  let q;
  if (goodThreshold <= badThreshold) {
    q =
      val <= goodThreshold
        ? 1
        : val >= badThreshold
          ? 0
          : (badThreshold - val) / (badThreshold - goodThreshold);
  } else {
    q =
      val >= goodThreshold
        ? 1
        : val <= badThreshold
          ? 0
          : (val - badThreshold) / (goodThreshold - badThreshold);
  }
  return Math.round(weight * clamp(q, 0, 1) * 10) / 10;
}

// Constant-product pool sell impact: drop = 1 - (R / (R + q))^2
function priceImpact(qTokens, reserveTokens) {
  if (qTokens <= 0 || !(reserveTokens > 0)) return 0;
  return 1 - Math.pow(reserveTokens / (reserveTokens + qTokens), 2);
}

// USD position exit impact on constant-product pool with pool liquidity L (total USD = 2 * R_usd)
function usdPositionImpact(positionUsd, poolLiquidityUsd) {
  if (!(positionUsd > 0) || !(poolLiquidityUsd > 0)) return null;
  const reserveUsd = poolLiquidityUsd / 2;
  return 1 - Math.pow(reserveUsd / (reserveUsd + positionUsd), 2);
}

function evaluateShield(rec, devAtLaunch, supply = LIMITS.totalPumpSupply) {
  const checks = [];

  if (!rec || rec.launched == null || rec.launched === 0) {
    checks.push({
      k: "history",
      name: "Creator history",
      ok: null,
      text:
        rec && rec.launched === 0
          ? "creator check unavailable (0 launches returned)"
          : "pending traction",
    });
  } else {
    const serial =
      rec.launched >= LIMITS.shieldMinLaunches &&
      rec.graduated * 100 < LIMITS.shieldMaxGradPct * rec.launched;
    checks.push({
      k: "history",
      name: "Creator history",
      ok: !serial,
      text: `${rec.launched} launched, ${rec.graduated} graduated`,
      reason: `serial creator: ${rec.launched} launches, ${rec.graduated} graduated`,
    });
  }

  if (devAtLaunch == null) {
    checks.push({
      k: "dev",
      name: "Dev at launch",
      ok: null,
      text: "dev buy not known",
    });
  } else {
    const share = devAtLaunch / (supply || LIMITS.totalPumpSupply);
    const ok = share < LIMITS.devMaxShare;
    checks.push({
      k: "dev",
      name: "Dev at launch",
      ok,
      text: `dev bought ${(share * 100).toFixed(1)}% at launch`,
      reason: `dev bought ${(share * 100).toFixed(0)}% at launch`,
    });
  }

  const failed = checks.filter((c) => c.ok === false);
  return {
    pass: failed.length === 0,
    reason: failed.length ? failed[0].reason : null,
    checks,
  };
}

function evaluateGuard({
  creator,
  history,
  slot0Share,
  devShare,
  ownerPowers,
  creatorMem,
}) {
  const checks = [];

  if (!history || history.unavailable) {
    checks.push({
      k: "history",
      name: "Creator history",
      ok: null,
      text: "chain history unavailable",
    });
  } else {
    const bad =
      history.launched >= LIMITS.shieldMinLaunches &&
      history.graduated * 100 < LIMITS.shieldMaxGradPct * history.launched;
    checks.push({
      k: "history",
      name: "Creator history",
      ok: !bad,
      text: `${history.launched} launched, ${history.graduated} graduated`,
      reason: `serial creator (${history.launched} launches, ${history.graduated} graduated)`,
    });
  }

  if (slot0Share == null) {
    checks.push({
      k: "slot0",
      name: "First-slot buyers",
      ok: null,
      text: "launch slot not read",
    });
  } else {
    checks.push({
      k: "slot0",
      name: "First-slot buyers",
      ok: slot0Share < LIMITS.slot0MaxShare,
      text: `${(slot0Share * 100).toFixed(1)}% bought in launch slot`,
      reason: `${(slot0Share * 100).toFixed(0)}% bought in slot-0`,
    });
  }

  if (devShare == null) {
    checks.push({
      k: "dev",
      name: "Dev holdings",
      ok: null,
      text: "dev balance not read",
    });
  } else {
    checks.push({
      k: "dev",
      name: "Dev holdings",
      ok: devShare < LIMITS.devMaxShare,
      text: `dev holds ${(devShare * 100).toFixed(1)}% now`,
      reason: `dev holds ${(devShare * 100).toFixed(0)}% of supply`,
    });
  }

  if (ownerPowers) {
    const dangerousOwner = Boolean(
      ownerPowers.mintAuthority ||
      ownerPowers.freezeAuthority ||
      (ownerPowers.transferFeeBps && ownerPowers.transferFeeBps > 500),
    );
    checks.push({
      k: "owner",
      name: "Owner powers",
      ok: !dangerousOwner,
      text: dangerousOwner
        ? `active: ${[ownerPowers.mintAuthority && "mint", ownerPowers.freezeAuthority && "freeze", ownerPowers.transferFeeBps > 500 && `fee ${(ownerPowers.transferFeeBps / 100).toFixed(1)}%`].filter(Boolean).join(", ")}`
        : "mint & freeze revoked",
      reason: "mint/freeze authority or high transfer fee active",
    });
  }

  if (creatorMem && creatorMem.danger_count >= 2) {
    checks.push({
      k: "memory",
      name: "Creator memory",
      ok: false,
      text: `${creatorMem.danger_count} prior DANGER tokens in local memory`,
      reason: `repeat offender in Operator Memory (${creatorMem.danger_count} DANGER launches)`,
    });
  }

  const failed = checks.filter((c) => c.ok === false);
  return {
    creator: creator || null,
    pass: failed.length === 0,
    pending: checks.some((c) => c.ok === null),
    reason: failed.length ? failed[0].reason : null,
    checks,
  };
}

function scoreSafety(holders, operators, ctx) {
  if (!holders || holders.length === 0) {
    return {
      score: null,
      band: "UNAVAILABLE",
      state: "unavailable",
      parts: {
        operator: 0,
        virgin: 0,
        transfer: 0,
        sniper: 0,
        concentration: 0,
      },
      metrics: {
        impact: 0,
        operatorShare: 0,
        virgin: 0,
        transfer: 0,
        sniper: 0,
        concentration: 0,
        unread: 0,
      },
      gates: [
        {
          hard: false,
          note: true,
          text: "Holders unavailable (RPC rate limit) — no silent pass",
        },
      ],
      scenario: null,
      headline: "Holders could not be read from Solana RPC",
    };
  }
  const F = ctx.floatTokens || 1;
  const R = ctx.reserveTokens || 0;
  const unread = ctx.unread || 0;
  const realOps = operators.filter((o) => o.wallets.length > 1);
  const big = operators[0];
  const imp =
    big && R > 0
      ? priceImpact(big.weighted * F, R)
      : big
        ? Math.min(1, big.weighted * 1.4)
        : 0;

  const nonDev = holders.filter((h) => !h.dev);
  const readW = nonDev.filter((h) => !h.unread);
  const top20Share = sum(holders, (h) => h.share);

  const metrics = {
    impact: imp,
    operatorShare: big ? big.weighted : 0,
    virgin: readW.length
      ? readW.filter((h) => h.virgin).length / readW.length
      : 0,
    transfer: sum(
      holders.filter((h) => h.kind === "transfer"),
      (h) => h.share,
    ),
    sniper: sum(
      nonDev.filter((h) => h.sniper && !h.sold),
      (h) => h.share,
    ),
    concentration: top20Share,
    unread,
  };

  const parts = {
    operator: linearPart(
      SAFETY_WEIGHTS.operator,
      metrics.impact,
      SAFETY_SCALE.operator[0],
      SAFETY_SCALE.operator[1],
    ),
    virgin: linearPart(
      SAFETY_WEIGHTS.virgin,
      metrics.virgin,
      SAFETY_SCALE.virgin[0],
      SAFETY_SCALE.virgin[1],
    ),
    transfer: linearPart(
      SAFETY_WEIGHTS.transfer,
      metrics.transfer,
      SAFETY_SCALE.transfer[0],
      SAFETY_SCALE.transfer[1],
    ),
    sniper: linearPart(
      SAFETY_WEIGHTS.sniper,
      metrics.sniper,
      SAFETY_SCALE.sniper[0],
      SAFETY_SCALE.sniper[1],
    ),
    concentration: linearPart(
      SAFETY_WEIGHTS.concentration,
      metrics.concentration,
      SAFETY_SCALE.concentration[0],
      SAFETY_SCALE.concentration[1],
    ),
  };

  let total = Math.round(
    parts.operator +
      parts.virgin +
      parts.transfer +
      parts.sniper +
      parts.concentration,
  );
  const gates = [];

  if (big && metrics.impact >= 0.5 && big.wallets.length > 1) {
    gates.push({
      hard: true,
      text: `biggest operator (${big.wallets.length} linked wallets, ${(big.share * 100).toFixed(1)}% float) could dump −${Math.round(metrics.impact * 100)}%`,
    });
  }
  if (metrics.virgin >= 0.8 && readW.length) {
    gates.push({
      hard: true,
      text: `${Math.round(metrics.virgin * 100)}% of top wallets are fresh (no prior trading history)`,
    });
  }
  if (metrics.transfer >= 0.1) {
    gates.push({
      hard: true,
      text: `${(metrics.transfer * 100).toFixed(1)}% of float arrived by transfer, not bought`,
    });
  }
  if (ctx.recidivistRoots && ctx.recidivistRoots.length > 0) {
    gates.push({
      hard: true,
      text: `Operator Memory match: ${ctx.recidivistRoots.length} funding root(s) linked to prior DANGER/rug launches`,
    });
  }

  for (const op of realOps) {
    if (op.level === "pack" || op.wallets.length >= 3) {
      gates.push({
        hard: false,
        text: `${op.level === "pack" ? "fresh pack" : "proven operator"} of ${op.wallets.length} wallets holds ${(op.share * 100).toFixed(1)}%`,
      });
    }
  }
  if (big && metrics.impact >= 0.5 && big.wallets.length === 1) {
    gates.push({
      hard: false,
      text: `single whale could impact price −${Math.round(metrics.impact * 100)}% (thin liquidity)`,
    });
  }
  if (ctx.liquidityUsd != null && ctx.liquidityUsd < LIMITS.lowLiquidityUsd) {
    gates.push({
      hard: false,
      text: `liquidity is only $${Math.round(ctx.liquidityUsd)} · capped at RISKY`,
    });
  }
  if (unread >= 3) {
    gates.push({
      hard: false,
      text: `${unread} of ${holders.length} wallets unread (PARTIAL) · capped at RISKY`,
    });
  } else if (unread > 0) {
    gates.push({
      hard: false,
      note: true,
      text: `${unread} wallet(s) unread · not counted as evidence`,
    });
  }

  const hasHard = gates.some((g) => g.hard);
  const hasCap = gates.some((g) => !g.hard && !g.note);
  if (hasCap) total = Math.min(total, 59);
  if (hasHard) total = Math.min(total, 38);

  const band = hasHard
    ? "DANGER"
    : total >= 80
      ? "CLEAN"
      : total >= 60
        ? "OK"
        : total >= 40
          ? "RISKY"
          : "DANGER";

  let scenario = null;
  const realIds = new Set(realOps.map((o) => o.id));
  const sus = holders.filter(
    (h) =>
      (h.op && realIds.has(h.op)) ||
      h.kind === "transfer" ||
      h.virgin ||
      (h.bundle && !h.sold),
  );
  const susShare = sum(sus, (h) => h.share);
  const susDrop =
    R > 0 ? priceImpact(susShare * F, R) : Math.min(1, susShare * 1.4);
  if (susDrop > 0.05) {
    scenario = {
      drop: susDrop,
      share: susShare,
      wallets: sus.length,
    };
  }

  return {
    score: total,
    band,
    state: unread >= 3 ? "partial" : "ok",
    parts,
    metrics,
    gates,
    scenario,
    headline: `${holders.length} holders → ${operators.length} operators · biggest ${(big ? big.share * 100 : 0).toFixed(1)}% float`,
  };
}

function scoreAlphaAndMicrostructure({
  market,
  curve,
  holders,
  operators,
  safety,
}) {
  const m5 = market && market.m5;
  const h1 = market && market.h1;
  const liqUsd = market && market.liquidityUsd;
  const turnoverToLiq = market && market.turnoverToLiq;

  // 1. Orderflow Imbalance (OFI): combine 5m & 1h buy/sell pressure
  let ofi = 0;
  let buyRatio = 0.5;
  if (m5 && m5.txs >= 4) {
    ofi = m5.ofi;
    buyRatio = m5.buys / m5.txs;
  } else if (h1 && h1.txs >= 4) {
    ofi = h1.ofi;
    buyRatio = h1.buys / h1.txs;
  }
  const orderflowScore = linearPart(ALPHA_WEIGHTS.orderflow, ofi, 0.35, -0.35);

  // 2. Curve Velocity / Momentum
  let velocityRaw = 0.35;
  let curveProgressPct = null;
  if (
    curve &&
    !curve.complete &&
    !curve.mayhem &&
    curve.realTokens <= LIMITS.initialRealTokenReserves
  ) {
    curveProgressPct = clamp(
      (1 - curve.realTokens / LIMITS.initialRealTokenReserves) * 100,
      0,
      100,
    );
    // Sweet spot: 15%..92% bonding curve progress + positive 5m/1h price change
    const progScore =
      curveProgressPct >= 15 && curveProgressPct <= 92
        ? 0.85
        : curveProgressPct / 100;
    const momBonus =
      m5 && m5.changePct != null ? clamp(m5.changePct / 40, -0.3, 0.3) : 0;
    velocityRaw = clamp(progScore + momBonus, 0, 1);
  } else if (m5 && m5.changePct != null) {
    velocityRaw = clamp(0.5 + m5.changePct / 50, 0, 1);
  }
  const velocityScore =
    Math.round(ALPHA_WEIGHTS.velocity * velocityRaw * 10) / 10;

  // 3. Wash-Trading Gate (Turnover / Liquidity ratio, adapted from Jarvis Turnover/OI hygiene)
  const washScore =
    turnoverToLiq == null
      ? Math.round(ALPHA_WEIGHTS.washCleanliness * 0.6 * 10) / 10
      : linearPart(
          ALPHA_WEIGHTS.washCleanliness,
          turnoverToLiq,
          LIMITS.washRatioSoft,
          LIMITS.washRatioHard,
        );

  // 4. Exitability & Cost-to-Impact Gate for $1,000 trade
  const exitImp1k = usdPositionImpact(LIMITS.exitPositionUsd, liqUsd);
  const roundTripCostPct = exitImp1k != null ? exitImp1k + 0.012 : null; // pool slippage + ~1.2% DEX/Jito priority fees
  const exitScore =
    roundTripCostPct == null
      ? Math.round(ALPHA_WEIGHTS.exitability * 0.4 * 10) / 10
      : linearPart(
          ALPHA_WEIGHTS.exitability,
          roundTripCostPct,
          0.03,
          LIMITS.maxExitImpactPct * 1.5,
        );

  // 5. Organic Breadth (independent operators / top holders)
  const breadthRatio = holders.length ? operators.length / holders.length : 0.5;
  const breadthScore = linearPart(
    ALPHA_WEIGHTS.organicBreadth,
    breadthRatio,
    0.9,
    0.4,
  );

  let total = Math.round(
    orderflowScore + velocityScore + washScore + exitScore + breadthScore,
  );
  const warnings = [];
  if (turnoverToLiq != null && turnoverToLiq > LIMITS.washRatioSoft) {
    warnings.push(
      `Elevated Turnover/Liq (${turnoverToLiq.toFixed(1)}x) — possible wash-trading bot churn`,
    );
  }
  if (roundTripCostPct != null && roundTripCostPct > LIMITS.maxExitImpactPct) {
    warnings.push(
      `Exit Cost-Gate FAIL: $1K exit costs ${(roundTripCostPct * 100).toFixed(1)}% (>12% cap)`,
    );
    total = Math.min(total, 55);
  }
  if (safety && safety.band === "DANGER") {
    total = Math.min(total, 45);
  }

  const exitTiers = [250, 1000, 5000].map((usd) => {
    const imp = usdPositionImpact(usd, liqUsd);
    return {
      usd,
      slippagePct: imp != null ? Number((imp * 100).toFixed(2)) : null,
      roundTripCostPct:
        imp != null ? Number(((imp + 0.012) * 100).toFixed(2)) : null,
    };
  });

  // Matrix classification: Safety x Alpha
  const safeScoreVal = safety && safety.score != null ? safety.score : 0;
  const safeHigh = safeScoreVal >= 65;
  const alphaHigh = total >= 62;
  let quadrant = "TOXIC_AVOID";
  let action = "SKIP";
  if (safety && safety.score == null) {
    quadrant = "UNAVAILABLE";
    action = "RETRY_RPC";
  } else if (safeHigh && alphaHigh) {
    quadrant = "SNIPER_GEM";
    action = "PAPER_ENTER";
  } else if (safeHigh && !alphaHigh) {
    quadrant = "SAFE_SLOW";
    action = "WATCH";
  } else if (!safeHigh && alphaHigh) {
    quadrant = "HIGH_RISK_TRAP";
    action = "AVOID_TRAP";
  }

  return {
    score: total,
    parts: {
      orderflow: orderflowScore,
      velocity: velocityScore,
      washCleanliness: washScore,
      exitability: exitScore,
      organicBreadth: breadthScore,
    },
    microstructure: {
      ofi5m: m5 ? Number(m5.ofi.toFixed(3)) : null,
      buyRatioPct: Number((buyRatio * 100).toFixed(1)),
      turnoverToLiq:
        turnoverToLiq != null ? Number(turnoverToLiq.toFixed(2)) : null,
      curveProgressPct:
        curveProgressPct != null ? Number(curveProgressPct.toFixed(1)) : null,
      exitCost1kPct:
        roundTripCostPct != null
          ? Number((roundTripCostPct * 100).toFixed(2))
          : null,
      exitTiers,
    },
    warnings,
    matrix: {
      quadrant,
      action,
      safety: safety ? safety.score : null,
      alpha: total,
      suggestedSlPct: -20,
      suggestedTpPct: safeHigh && alphaHigh ? 50 : 30,
    },
  };
}

module.exports = {
  linearPart,
  priceImpact,
  usdPositionImpact,
  evaluateShield,
  evaluateGuard,
  scoreSafety,
  scoreAlphaAndMicrostructure,
};
