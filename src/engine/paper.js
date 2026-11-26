"use strict";

/*
 * Paper-Trading Sandbox (inspired by Jarvis Lab):
 *   Lets operators forward-test ApexOrb's Dual-Axis signals in real time
 *   against live DexScreener/GeckoTerminal prices without risking capital.
 */

const { fetchMarketSnapshot } = require("./market");

async function refreshPaperTrades(db) {
  const openTrades = db.listPaperTrades(100).filter((t) => t.status === "OPEN");
  const updated = [];

  for (const t of openTrades) {
    try {
      const mkt = await fetchMarketSnapshot(t.mint);
      const px = mkt && mkt.priceUsd;
      if (!(px > 0)) continue;

      const pnlPct = ((px - t.entry_price_usd) / t.entry_price_usd) * 100;
      const pnlUsd = (t.size_usd * pnlPct) / 100;

      let status = "OPEN";
      let exitReason = null;
      let closedAt = null;

      if (pnlPct <= t.sl_pct) {
        status = "CLOSED";
        exitReason = `SL hit (${pnlPct.toFixed(1)}%)`;
        closedAt = Date.now();
      } else if (pnlPct >= t.tp_pct) {
        status = "CLOSED";
        exitReason = `TP hit (+${pnlPct.toFixed(1)}%)`;
        closedAt = Date.now();
      }

      db.updatePaperTrade(t.id, {
        currentPriceUsd: px,
        pnlUsd: Number(pnlUsd.toFixed(2)),
        pnlPct: Number(pnlPct.toFixed(2)),
        status,
        exitReason,
        closedAt,
      });
      updated.push({ id: t.id, status, pnlPct });
    } catch {}
  }

  return updated;
}

module.exports = { refreshPaperTrades };
