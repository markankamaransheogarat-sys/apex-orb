"use strict";

/*
 * ALPHA_WHALES Smart-Money Discovery Engine (Solana):
 *   Inverts Operator Memory into a White-List of consistently profitable early holders.
 *   Discovers top gaining / liquid Solana tokens from DexScreener and indexes their
 *   non-pool organic top holders into SQLite `alpha_whales`.
 */

const { LIMITS } = require("../config");
const { INFRA_ADDR, INFRA_PROGRAMS } = require("../solana/layout");
const { fetchMarketSnapshot } = require("./market");

async function fetchJson(url, timeoutMs = 5500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "ApexOrb-Whale-Indexer/1.0",
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverAlphaWhales({ db, rpc, maxTokens = 6 } = {}) {
  const boosts = await fetchJson(
    "https://api.dexscreener.com/token-boosts/top/v1",
  );
  const candidates = (Array.isArray(boosts) ? boosts : [])
    .filter((x) => x.chainId === "solana" && x.tokenAddress)
    .slice(0, 14);

  const indexed = [];
  let walletsCredited = 0;

  for (const item of candidates) {
    if (indexed.length >= maxTokens) break;
    const mint = item.tokenAddress;

    const mkt = await fetchMarketSnapshot(mint).catch(() => null);
    if (!mkt || (mkt.liquidityUsd || 0) < 18_000) continue;
    if (mkt.turnoverToLiq != null && mkt.turnoverToLiq > 28) continue; // skip obvious wash-traded pools
    const h1Change = mkt.h1 && mkt.h1.changePct != null ? mkt.h1.changePct : 0;
    const h24Change =
      mkt.h24 && mkt.h24.changePct != null ? mkt.h24.changePct : 0;
    if (h1Change < 0 && h24Change <= 5) continue; // focus on actual winners

    const rc = await fetchJson(
      `https://api.rugcheck.xyz/v1/tokens/${mint}/report`,
    );
    if (!rc || !Array.isArray(rc.topHolders) || rc.rugged) continue;

    const knownPools = new Set(
      (mkt.pools || []).map((p) => p.pool).filter(Boolean),
    );
    for (const mk of rc.markets || []) {
      if (mk.pubkey) knownPools.add(mk.pubkey);
      if (mk.lp && mk.lp.lpMint) knownPools.add(mk.lp.lpMint);
      if (mk.lp && mk.lp.base) knownPools.add(mk.lp.base);
      if (mk.lp && mk.lp.quote) knownPools.add(mk.lp.quote);
    }

    const rawOwners = [];
    for (const h of rc.topHolders) {
      const owner = h.owner;
      if (
        !owner ||
        INFRA_ADDR[owner] ||
        knownPools.has(owner) ||
        owner === rc.creator
      )
        continue;
      if (h.pct != null && h.pct > 18) continue; // ignore single-whale monopolies
      rawOwners.push(owner);
    }

    const checkList = rawOwners.slice(0, 15);
    if (checkList.length && rpc) {
      const accRes = await rpc
        .getMultipleAccounts(checkList, "base64")
        .catch(() => ({ value: [] }));
      const cleanOwners = [];
      (accRes.value || []).forEach((acc, idx) => {
        if (acc && INFRA_PROGRAMS[acc.owner]) return;
        cleanOwners.push(checkList[idx]);
      });

      for (const w of cleanOwners.slice(0, 10)) {
        db.creditAlphaWhale({
          wallet: w,
          role: "WHALE",
          symbol: mkt.symbol || "SOL",
          mint,
          isWin: true,
        });
        walletsCredited += 1;
      }
      indexed.push({
        mint,
        symbol: mkt.symbol || "?",
        liqUsd: Math.round(mkt.liquidityUsd),
        wallets: cleanOwners.length,
      });
    }
  }

  return {
    tokensIndexed: indexed.length,
    walletsCredited,
    tokens: indexed,
    topWhales: db.listAlphaWhales(30),
  };
}

module.exports = { discoverAlphaWhales };
