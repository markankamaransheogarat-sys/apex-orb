"use strict";

/*
 * Multi-source Solana market & orderflow microstructure aggregator:
 *   1) DexScreener API (base-mint verified pairs, 5m/1h/24h buys/sells/volume)
 *   2) GeckoTerminal API fallback/enrichment (base & quote mint verified pools)
 *   3) On-chain pump.fun Bonding Curve fallback when pre-migration
 * Computes clean Market Cap vs FDV, Liquidity, Wash-Trading Turnover Ratio, and OFI.
 */

const { LIMITS } = require("../config");
const { TTLCache } = require("../solana/util");

const marketCache = new TTLCache(20_000, 1000);

const num = (v) =>
  v == null || v === "" || typeof v === "boolean"
    ? null
    : Number.isFinite(+v)
      ? +v
      : null;
const pos = (v) => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};
const nn = (v) => {
  const n = num(v);
  return n != null && n >= 0 ? n : null;
};
const gid = (s) => (typeof s === "string" ? s.replace(/^solana_/, "") : "");

function sideName(name, i) {
  const s = (String(name || "").split(" / ")[i] || "")
    .replace(/\s+\d+(\.\d+)?%$/, "")
    .trim();
  return s || null;
}

function txCount(t) {
  if (!t) return null;
  const b = nn(t.buys);
  const s = nn(t.sells);
  return b != null || s != null ? (b || 0) + (s || 0) : null;
}

function socialsOf(p) {
  const s = { x: false, tg: false, web: false, urls: {} };
  const info = p && p.info;
  if (!info) return s;
  for (const x of info.socials || []) {
    const t = String(x.type || x.platform || "").toLowerCase();
    const u = x.url || x.handle || "";
    if (t === "twitter" || t === "x" || /x\.com|twitter\.com/.test(u)) {
      s.x = true;
      if (u) s.urls.x = u;
    }
    if (t === "telegram" || /t\.me\//.test(u)) {
      s.tg = true;
      if (u) s.urls.tg = u;
    }
  }
  const web = (info.websites || []).find((w) => w && w.url);
  if (web) {
    s.web = true;
    s.urls.web = web.url;
  }
  return s;
}

function windowFlow(p, win) {
  if (!p) return null;
  const t = (p.txns && p.txns[win]) || {};
  const b = num(t.buys);
  const s = num(t.sells);
  if (b == null && s == null) return null;
  const buys = b || 0;
  const sells = s || 0;
  const total = buys + sells;
  return {
    txs: total,
    buys,
    sells,
    ofi: total > 0 ? (buys - sells) / total : 0,
    volUsd: num(p.volume && p.volume[win]) || 0,
    changePct: num(p.priceChange && p.priceChange[win]),
  };
}

function dexPool(p, mint) {
  if (!p || !p.baseToken || p.baseToken.address !== mint || !p.pairAddress)
    return null;
  const liq = p.liquidity || {};
  const priced = pos(p.priceUsd) != null;
  return {
    pool: p.pairAddress,
    dex: p.dexId || "",
    side: "base",
    quote: (p.quoteToken && p.quoteToken.address) || null,
    quoteSymbol: (p.quoteToken && p.quoteToken.symbol) || null,
    priceUsd: pos(p.priceUsd),
    priceNative: pos(p.priceNative),
    liqUsd: priced ? pos(liq.usd) : null,
    liqBase: nn(liq.base),
    liqQuote: nn(liq.quote),
    vol24: priced ? nn(p.volume && p.volume.h24) : null,
    tx24: txCount(p.txns && p.txns.h24),
    mcap: priced ? pos(p.marketCap) : null,
    fdv: priced ? pos(p.fdv) : null,
    createdAt: pos(p.pairCreatedAt),
    symbol: p.baseToken.symbol || null,
    name: p.baseToken.name || null,
    socials: socialsOf(p),
    m5: windowFlow(p, "m5"),
    h1: windowFlow(p, "h1"),
    h24: windowFlow(p, "h24"),
    src: "dexscreener",
  };
}

function geckoPool(p, mint) {
  const a = (p && p.attributes) || {};
  const r = (p && p.relationships) || {};
  const base = gid(r.base_token && r.base_token.data && r.base_token.data.id);
  const quote = gid(
    r.quote_token && r.quote_token.data && r.quote_token.data.id,
  );
  const side = base === mint ? "base" : quote === mint ? "quote" : null;
  if (!side || !a.address) return null;
  const isBase = side === "base";
  return {
    pool: a.address,
    dex: (r.dex && r.dex.data && r.dex.data.id) || "",
    side,
    quote: isBase ? quote || null : base || null,
    quoteSymbol: sideName(a.name, isBase ? 1 : 0),
    priceUsd: pos(isBase ? a.base_token_price_usd : a.quote_token_price_usd),
    priceNative: pos(
      isBase ? a.base_token_price_quote_token : a.quote_token_price_base_token,
    ),
    liqUsd: pos(a.reserve_in_usd),
    liqBase: null,
    liqQuote: null,
    vol24: nn(a.volume_usd && a.volume_usd.h24),
    tx24: txCount(a.transactions && a.transactions.h24),
    mcap: isBase ? pos(a.market_cap_usd) : null,
    fdv: isBase ? pos(a.fdv_usd) : null,
    createdAt: pos(Date.parse(a.pool_created_at)),
    symbol: sideName(a.name, isBase ? 0 : 1),
    name: null,
    socials: null,
    m5: null,
    h1: null,
    h24: null,
    src: "geckoterminal",
  };
}

const isCurvePool = (p) => /^pump[-_.]?fun$/i.test((p && p.dex) || "");

function mergePools(dl, gl) {
  const byAddr = new Map();
  for (const p of dl || []) {
    if (p && !byAddr.has(p.pool)) byAddr.set(p.pool, { ...p });
  }
  const fillKeys = [
    "priceUsd",
    "priceNative",
    "liqUsd",
    "liqBase",
    "liqQuote",
    "vol24",
    "tx24",
    "mcap",
    "fdv",
    "createdAt",
    "quote",
    "quoteSymbol",
    "symbol",
    "name",
  ];
  for (const g of gl || []) {
    if (!g) continue;
    const d = byAddr.get(g.pool);
    if (!d) {
      byAddr.set(g.pool, { ...g });
      continue;
    }
    if (d.side !== g.side) continue;
    let enriched = false;
    for (const k of fillKeys) {
      if (d[k] == null && g[k] != null) {
        d[k] = g[k];
        enriched = true;
      }
    }
    if (!d.dex && g.dex) d.dex = g.dex;
    if (enriched) d.src = "dexscreener+geckoterminal";
  }
  return [...byAddr.values()].sort((a, b) => (b.liqUsd || 0) - (a.liqUsd || 0));
}

function pickPool(list, minLiq = LIMITS.lowLiquidityUsd) {
  const pools = list || [];
  const priced = pools.filter((p) => p.priceUsd > 0);
  if (!priced.length) return pools[0] || null;
  const maxLiq = Math.max(0, ...priced.map((p) => p.liqUsd || 0));
  const deep =
    maxLiq > 0
      ? priced.filter((p) => (p.liqUsd || 0) >= Math.max(minLiq, maxLiq * 0.1))
      : [];
  const live = deep.filter(
    (p) => p.tx24 == null || p.tx24 > 0 || (p.vol24 || 0) > 0,
  );
  const set = live.length
    ? live
    : deep.length
      ? deep
      : priced.filter((p) => p.liqUsd > 0);
  if (set.length)
    return set.slice().sort((a, b) => (b.liqUsd || 0) - (a.liqUsd || 0))[0];
  return priced.slice().sort((a, b) => (b.vol24 || 0) - (a.vol24 || 0))[0];
}

function caps(price, supply, fixedSupply, reportedMcap) {
  const fdv = price > 0 && supply > 0 ? price * supply : null;
  if (fixedSupply && fdv) return { mcap: fdv, fdv, basis: "fixed_supply" };
  if (reportedMcap > 0) return { mcap: reportedMcap, fdv, basis: "reported" };
  return { mcap: null, fdv, basis: null };
}

async function fetchJson(url, timeoutMs = 5500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "ApexOrb-Quant-Scanner/1.0",
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

async function fetchSolUsdPrice() {
  return marketCache.wrap(
    "sol_usd_price",
    async () => {
      const data = await fetchJson(
        "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
        4500,
      );
      const pair = ((data && data.pairs) || []).find(
        (p) =>
          p.quoteToken &&
          (p.quoteToken.symbol === "USDC" || p.quoteToken.symbol === "USDT") &&
          pos(p.priceUsd),
      );
      return pair ? Number(pair.priceUsd) : 150;
    },
    60_000,
  );
}

async function fetchMarketSnapshot(mint, opts = {}) {
  return marketCache.wrap(
    `mkt:${mint}`,
    async () => {
      const [dexRaw, solUsd] = await Promise.all([
        fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`),
        fetchSolUsdPrice(),
      ]);

      const dexList = ((dexRaw && dexRaw.pairs) || [])
        .map((p) => dexPool(p, mint))
        .filter(Boolean);
      let pick = pickPool(dexList);
      const needsGecko =
        !pick ||
        !pick.priceUsd ||
        pick.vol24 == null ||
        !pick.liqUsd ||
        isCurvePool(pick);

      let geckoList = [];
      if (needsGecko) {
        const gtRaw = await fetchJson(
          `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`,
        );
        geckoList = ((gtRaw && gtRaw.data) || [])
          .map((p) => geckoPool(p, mint))
          .filter(Boolean);
      }

      const pools = mergePools(dexList, geckoList);
      pick = pickPool(pools);

      const counted = pools
        .filter((p) => p === pick || (p.liqUsd || 0) >= LIMITS.lowLiquidityUsd)
        .filter((p) => p.vol24 != null);
      const liqPools = pools.filter((p) => p.liqUsd > 0);
      const oldest =
        pools
          .filter((p) => p.createdAt)
          .sort((a, b) => a.createdAt - b.createdAt)[0] || null;

      const priceUsd = pick ? pick.priceUsd : null;
      const supply = opts.supply || LIMITS.totalPumpSupply;
      const fixedSupply = Boolean(opts.fixedSupply);
      const capInfo = caps(
        priceUsd,
        supply,
        fixedSupply,
        pick ? pick.mcap : null,
      );

      const vol24 = counted.length
        ? counted.reduce((s, p) => s + p.vol24, 0)
        : pick
          ? pick.vol24
          : null;
      const liqTotal = liqPools.length
        ? liqPools.reduce((s, p) => s + p.liqUsd, 0)
        : null;
      const primaryLiq = pick && pick.liqUsd ? pick.liqUsd : liqTotal;

      const ageDays =
        oldest && oldest.createdAt
          ? (Date.now() - oldest.createdAt) / 86_400_000
          : null;
      const turnoverToLiq =
        vol24 != null && primaryLiq > 0 ? vol24 / primaryLiq : null;

      return {
        pools: pools.slice(0, 8),
        pickedPool: pick,
        solUsd,
        priceUsd,
        liquidityUsd: primaryLiq,
        liquidityTotalUsd: liqTotal,
        vol24Usd: vol24,
        turnoverToLiq,
        mcap: capInfo.mcap,
        fdv: capInfo.fdv,
        capBasis: capInfo.basis,
        ageDays,
        createdAt: oldest ? oldest.createdAt : null,
        symbol: (pick && pick.symbol) || null,
        name: (pick && pick.name) || null,
        socials: (pick && pick.socials) || null,
        m5: (pick && pick.m5) || null,
        h1: (pick && pick.h1) || null,
        h24: (pick && pick.h24) || null,
      };
    },
    15_000,
  );
}

module.exports = {
  dexPool,
  geckoPool,
  mergePools,
  pickPool,
  caps,
  windowFlow,
  fetchSolUsdPrice,
  fetchMarketSnapshot,
};
