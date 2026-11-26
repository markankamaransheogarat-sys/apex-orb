"use strict";

/*
 * Live Polymarket 5m Statistical Arbitrage & Fair-P Paper Engine:
 *   - Streams real-time Binance spot bookTicker (BTC, ETH, SOL, XRP)
 *   - Discovers active 5-minute markets via Gamma API ({asset}-updown-5m-{slotTs})
 *   - Polls real L2 orderbooks via POST https://clob.polymarket.com/books
 *   - Runs TWAP + Logit-Kalman Fair-P + Pair-Match Arbitrage ("Never Sell, Flip & Match")
 *   - Auto-settles expired 5m windows against official Polymarket Chainlink outcomes
 */

const { EventEmitter } = require("node:events");
const {
  LogitKalmanFilter,
  twapDigitalFairP,
  evaluatePolymarketStep,
} = require("./fairp");

const ASSETS = [
  {
    asset: "BTC",
    slugPrefix: "btc",
    binanceSym: "BTCUSDT",
    defaultSigma: 0.00018,
  },
  {
    asset: "ETH",
    slugPrefix: "eth",
    binanceSym: "ETHUSDT",
    defaultSigma: 0.00024,
  },
  {
    asset: "SOL",
    slugPrefix: "sol",
    binanceSym: "SOLUSDT",
    defaultSigma: 0.00032,
  },
  {
    asset: "XRP",
    slugPrefix: "xrp",
    binanceSym: "XRPUSDT",
    defaultSigma: 0.0003,
  },
];

const BINANCE_WS =
  "wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker/solusdt@bookTicker/xrpusdt@bookTicker";

async function fetchJson(url, opts = {}, timeoutMs = 4500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      headers: {
        "User-Agent": "ApexOrb-PM-Engine/1.0",
        ...(opts.headers || {}),
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

class PolymarketPaperEngine extends EventEmitter {
  constructor({ db } = {}) {
    super();
    this.db = db;
    this.enabled = true;
    this.running = false;
    this.binanceConnected = false;
    this.ws = null;
    this.tickTimer = null;
    this.settleTimer = null;
    this.lastTradeAt = new Map(); // throttle fills per asset/side (min 4s cooldown)

    // Per-asset live runtime state
    this.state = new Map();
    for (const a of ASSETS) {
      this.state.set(a.asset, {
        asset: a.asset,
        slugPrefix: a.slugPrefix,
        binanceSym: a.binanceSym,
        spot: null,
        bid: null,
        ask: null,
        lastSpotTs: 0,
        lastSecSpot: null,
        lastSecTs: 0,
        sigma: a.defaultSigma,
        kalman: new LogitKalmanFilter(),
        fairPUp: 0.5,
        window: null,
        twapSum: 0,
        twapCount: 0,
        upBestAsk: null,
        upBestBid: null,
        downBestAsk: null,
        downBestBid: null,
        history: [], // up to 80 recent points for Fair-P oscillator chart
      });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._connectBinance();
    this._bootstrapSpots().then(() => this._syncWindows());
    this.tickTimer = setInterval(() => this._stepLoop(), 1500);
    this.settleTimer = setInterval(() => this._settleExpiredWindows(), 15_000);
  }

  stop() {
    this.running = false;
    this.binanceConnected = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.settleTimer) clearInterval(this.settleTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  setEnabled(flag) {
    this.enabled = Boolean(flag);
    this.emit("status", this.snapshot());
    return this.enabled;
  }

  async _bootstrapSpots() {
    await Promise.all(
      ASSETS.map(async (a) => {
        const data = await fetchJson(
          `https://api.binance.com/api/v3/ticker/bookTicker?symbol=${a.binanceSym}`,
        );
        if (!data) return;
        const bid = Number(data.bidPrice);
        const ask = Number(data.askPrice);
        if (bid > 0 && ask > 0) {
          const st = this.state.get(a.asset);
          st.bid = bid;
          st.ask = ask;
          st.spot = (bid + ask) / 2;
          st.lastSpotTs = Date.now();
        }
      }),
    );
  }

  _connectBinance() {
    if (!this.running) return;
    try {
      const ws = new WebSocket(BINANCE_WS);
      this.ws = ws;

      ws.onopen = () => {
        this.binanceConnected = true;
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          const d = msg && msg.data;
          if (!d || !d.s) return;
          const match = ASSETS.find((a) => a.binanceSym === d.s);
          if (!match) return;
          const bid = Number(d.b);
          const ask = Number(d.a);
          if (!(bid > 0) || !(ask > 0)) return;
          const mid = (bid + ask) / 2;
          const st = this.state.get(match.asset);
          const now = Date.now();
          st.bid = bid;
          st.ask = ask;
          st.spot = mid;
          st.lastSpotTs = now;

          // Update 1-second EWMA volatility & running TWAP
          if (now - st.lastSecTs >= 1000) {
            if (st.lastSecSpot > 0) {
              const dtSec = Math.max(1, (now - st.lastSecTs) / 1000);
              const ret = Math.log(mid / st.lastSecSpot);
              const instVarPerSec = (ret * ret) / dtSec;
              const prevVar = st.sigma * st.sigma;
              const ewmaVar = 0.96 * prevVar + 0.04 * instVarPerSec;
              st.sigma = Math.min(0.002, Math.max(0.00005, Math.sqrt(ewmaVar)));
            }
            st.lastSecSpot = mid;
            st.lastSecTs = now;
            if (
              st.window &&
              now >= st.window.start_ts &&
              now <= st.window.end_ts
            ) {
              st.twapSum += mid;
              st.twapCount += 1;
            }
          }
        } catch {}
      };

      ws.onerror = () => {
        this.binanceConnected = false;
      };
      ws.onclose = () => {
        this.binanceConnected = false;
        if (this.running) setTimeout(() => this._connectBinance(), 3000);
      };
    } catch {
      if (this.running) setTimeout(() => this._connectBinance(), 4000);
    }
  }

  async _syncWindows() {
    const slotSec = Math.floor(Date.now() / 1000 / 300) * 300;
    const startTs = slotSec * 1000;
    const endTs = (slotSec + 300) * 1000;

    await Promise.all(
      ASSETS.map(async (a) => {
        const st = this.state.get(a.asset);
        const slug = `${a.slugPrefix}-updown-5m-${slotSec}`;
        if (st.window && st.window.slug === slug) return;

        const arr = await fetchJson(
          `https://gamma-api.polymarket.com/events?slug=${slug}`,
        );
        const ev = Array.isArray(arr) && arr[0];
        const m = ev && Array.isArray(ev.markets) && ev.markets[0];
        if (!m || !m.clobTokenIds) return;

        let ids;
        try {
          ids =
            typeof m.clobTokenIds === "string"
              ? JSON.parse(m.clobTokenIds)
              : m.clobTokenIds;
        } catch {
          return;
        }
        if (!Array.isArray(ids) || ids.length < 2) return;

        let openSpot = st.spot;
        let initTwapSum = st.spot ? st.spot : 0;
        let initTwapCount = st.spot ? 1 : 0;

        if (Date.now() - startTs > 4000) {
          const klines = await fetchJson(
            `https://api.binance.com/api/v3/klines?symbol=${a.binanceSym}&interval=1m&startTime=${startTs}&limit=5`,
          );
          if (Array.isArray(klines) && klines.length > 0) {
            openSpot = Number(klines[0][1]);
            const closes = klines
              .map((k) => (Number(k[1]) + Number(k[4])) / 2)
              .filter(Number.isFinite);
            if (closes.length) {
              initTwapSum = closes.reduce((s, v) => s + v, 0);
              initTwapCount = closes.length;
            }
          } else {
            openSpot = null; // do not guess mid-window openSpot if klines unavailable
          }
        }

        const row = this.db.upsertPmWindow({
          slug,
          asset: a.asset,
          title: ev.title || slug,
          startTs,
          endTs,
          openSpot,
          upTokenId: String(ids[0]),
          downTokenId: String(ids[1]),
        });

        st.window = row;
        st.kalman = new LogitKalmanFilter();
        st.twapSum = initTwapSum;
        st.twapCount = initTwapCount;
        st.history = [];
      }),
    );
  }

  async _stepLoop() {
    if (!this.running) return;
    const now = Date.now();
    const currentSlotSec = Math.floor(now / 1000 / 300) * 300;

    // Check if 5m slot rolled over
    const needSync = ASSETS.some((a) => {
      const w = this.state.get(a.asset).window;
      return !w || w.slug !== `${a.slugPrefix}-updown-5m-${currentSlotSec}`;
    });
    if (needSync) {
      await this._syncWindows();
    }

    const tokenReq = [];
    const assetByToken = new Map();

    for (const a of ASSETS) {
      const st = this.state.get(a.asset);
      if (!st.window) continue;
      if (
        !st.window.open_spot &&
        st.spot > 0 &&
        now - st.window.start_ts <= 5000
      ) {
        st.window = this.db.upsertPmWindow({
          slug: st.window.slug,
          asset: a.asset,
          title: st.window.title,
          startTs: st.window.start_ts,
          endTs: st.window.end_ts,
          openSpot: st.spot,
          upTokenId: st.window.up_token_id,
          downTokenId: st.window.down_token_id,
        });
      }
      tokenReq.push({ token_id: st.window.up_token_id });
      tokenReq.push({ token_id: st.window.down_token_id });
      assetByToken.set(st.window.up_token_id, { asset: a.asset, side: "UP" });
      assetByToken.set(st.window.down_token_id, {
        asset: a.asset,
        side: "DOWN",
      });
    }

    if (!tokenReq.length) return;

    const books = await fetchJson(
      "https://clob.polymarket.com/books",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tokenReq),
      },
      3500,
    );

    if (!Array.isArray(books)) return;

    const booksByAsset = new Map();
    for (const b of books) {
      const meta = assetByToken.get(b.asset_id);
      if (!meta) continue;
      if (!booksByAsset.has(meta.asset)) booksByAsset.set(meta.asset, {});
      booksByAsset.get(meta.asset)[meta.side] = b;
    }

    for (const a of ASSETS) {
      const st = this.state.get(a.asset);
      const bk = booksByAsset.get(a.asset);
      if (
        !st.window ||
        !bk ||
        !bk.UP ||
        !bk.DOWN ||
        !(st.spot > 0) ||
        !(st.window.open_spot > 0)
      )
        continue;

      const upAsks = bk.UP.asks || [];
      const upBids = bk.UP.bids || [];
      const downAsks = bk.DOWN.asks || [];
      const downBids = bk.DOWN.bids || [];

      const bestAsk = (arr) =>
        arr.length
          ? Math.min(...arr.map((x) => Number(x.price)).filter(Number.isFinite))
          : null;
      const bestBid = (arr) =>
        arr.length
          ? Math.max(...arr.map((x) => Number(x.price)).filter(Number.isFinite))
          : null;

      st.upBestAsk = bestAsk(upAsks);
      st.upBestBid = bestBid(upBids);
      st.downBestAsk = bestAsk(downAsks);
      st.downBestBid = bestBid(downBids);

      const elapsedSec = Math.max(0, (now - st.window.start_ts) / 1000);
      const remainingSec = Math.max(0, (st.window.end_ts - now) / 1000);
      const twapAvg = st.twapCount > 0 ? st.twapSum / st.twapCount : st.spot;

      const rawFairP = twapDigitalFairP({
        spot: st.spot,
        openSpot: st.window.open_spot,
        twapAvg,
        elapsedSec,
        totalSec: 300,
        sigmaPerSqrtSec: st.sigma,
      });

      const spread =
        st.upBestAsk != null && st.upBestBid != null
          ? Math.max(0, st.upBestAsk - st.upBestBid)
          : 0.02;
      st.fairPUp = st.kalman.update(rawFairP, spread * 1.5);

      st.history.push({
        t: now,
        fairP: Number(st.fairPUp.toFixed(4)),
        upAsk: st.upBestAsk,
        downAsk: st.downBestAsk,
      });
      if (st.history.length > 80) st.history.shift();

      if (this.enabled) {
        const decision = evaluatePolymarketStep({
          fairPUp: st.fairPUp,
          upAsks,
          downAsks,
          upShares: st.window.up_shares,
          upCostUsd: st.window.up_cost_usd,
          downShares: st.window.down_shares,
          downCostUsd: st.window.down_cost_usd,
          remainingSec,
        });

        if (decision) {
          const throttleKey = `${a.asset}:${decision.side}`;
          const lastAt = this.lastTradeAt.get(throttleKey) || 0;
          if (now - lastAt >= 4500) {
            this.lastTradeAt.set(throttleKey, now);
            const updatedWin = this.db.recordPmFill({
              windowSlug: st.window.slug,
              asset: a.asset,
              side: decision.side,
              shares: decision.fill.shares,
              price: decision.fill.effectivePrice,
              feeUsd: decision.fill.feeUsd,
              costUsd: decision.fill.costUsd,
              fairP: Number(decision.fairP.toFixed(4)),
              edge: decision.edge,
              reason: decision.reason,
              ts: now,
            });
            if (updatedWin) {
              st.window = updatedWin;
              this.emit("pm_fill", {
                windowSlug: st.window.slug,
                asset: a.asset,
                side: decision.side,
                shares: decision.fill.shares,
                price: decision.fill.effectivePrice,
                costUsd: decision.fill.costUsd,
                fairP: decision.fairP,
                edge: decision.edge,
                reason: decision.reason,
                ts: now,
              });
            }
          }
        }
      }
    }

    this.emit("pm_tick", this.snapshot());
  }

  async _settleExpiredWindows() {
    if (!this.running) return;
    const now = Date.now();
    const open = this.db.getOpenPmWindows();
    for (const win of open) {
      if (now < win.end_ts + 12_000) continue;

      const arr = await fetchJson(
        `https://gamma-api.polymarket.com/events?slug=${win.slug}`,
      );
      const ev = Array.isArray(arr) && arr[0];
      const m = ev && Array.isArray(ev.markets) && ev.markets[0];
      let winner = null;

      if (m && m.closed && m.outcomePrices) {
        try {
          const prices =
            typeof m.outcomePrices === "string"
              ? JSON.parse(m.outcomePrices)
              : m.outcomePrices;
          if (Number(prices[0]) >= 0.99) winner = "UP";
          else if (Number(prices[1]) >= 0.99) winner = "DOWN";
        } catch {}
      }

      // Fallback only if Gamma resolution lags > 4 minutes after close
      if (!winner && now > win.end_ts + 240_000) {
        const st = this.state.get(win.asset);
        const refSpot = st && st.spot > 0 ? st.spot : win.open_spot;
        winner = win.open_spot && refSpot >= win.open_spot ? "UP" : "DOWN";
      }

      if (winner) {
        const settled = this.db.settlePmWindow(win.slug, winner);
        if (settled) {
          this.emit("pm_settled", settled);
        }
      }
    }
  }

  snapshot() {
    const now = Date.now();
    const markets = ASSETS.map((a) => {
      const st = this.state.get(a.asset);
      const w = st.window;
      const totalSh = w ? w.up_shares + w.down_shares : 0;
      const imbalPct =
        totalSh > 0
          ? (Math.abs(w.up_shares - w.down_shares) / totalSh) * 100
          : 0;
      return {
        asset: a.asset,
        spot: st.spot,
        sigma: st.sigma,
        fairPUp: Number(st.fairPUp.toFixed(4)),
        fairPDown: Number((1 - st.fairPUp).toFixed(4)),
        upBestAsk: st.upBestAsk,
        upBestBid: st.upBestBid,
        downBestAsk: st.downBestAsk,
        downBestBid: st.downBestBid,
        twapAvg: st.twapCount > 0 ? st.twapSum / st.twapCount : st.spot,
        remainingSec: w ? Math.max(0, Math.round((w.end_ts - now) / 1000)) : 0,
        window: w,
        imbalancePct: Number(imbalPct.toFixed(1)),
        history: st.history,
      };
    });

    return {
      enabled: this.enabled,
      binanceConnected: this.binanceConnected,
      stats: this.db.pmStats(),
      markets,
      recentTrades: this.db.listPmTrades(30),
      recentWindows: this.db.listPmWindows(24),
    };
  }
}

module.exports = { PolymarketPaperEngine, ASSETS };
