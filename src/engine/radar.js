"use strict";

/*
 * Live Pump.fun Launch Radar via PumpPortal WebSocket:
 *   - Streams real-time token creation events
 *   - Runs instant Shield screening (devAtLaunch + SQLite Creator Memory)
 *   - Emits live events to Server-Sent Events (SSE) subscribers
 */

const { EventEmitter } = require("node:events");
const { PUMPPORTAL_WS, LIMITS } = require("../config");
const { evaluateShield } = require("./scoring");

class LaunchRadar extends EventEmitter {
  constructor({ db, wsUrl = PUMPPORTAL_WS } = {}) {
    super();
    this.db = db;
    this.wsUrl = wsUrl;
    this.ws = null;
    this.stopped = false;
    this.reconnectDelayMs = 2000;
    this.connected = false;
    this.seenCount = 0;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  _connect() {
    if (this.stopped) return;
    try {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.reconnectDelayMs = 2000;
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
        this.emit("status", { connected: true, seenCount: this.seenCount });
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (!msg || !msg.mint) return;
          this._handleLaunch(msg);
        } catch {}
      };

      ws.onerror = () => {
        this.connected = false;
      };

      ws.onclose = () => {
        this.connected = false;
        this.emit("status", { connected: false, seenCount: this.seenCount });
        if (!this.stopped) {
          setTimeout(() => this._connect(), this.reconnectDelayMs);
          this.reconnectDelayMs = Math.min(30_000, this.reconnectDelayMs * 1.5);
        }
      };
    } catch {
      if (!this.stopped) {
        setTimeout(() => this._connect(), this.reconnectDelayMs);
      }
    }
  }

  _handleLaunch(msg) {
    this.seenCount += 1;
    const creator = msg.traderPublicKey || null;
    const initialBuy = Number(msg.initialBuy || 0);
    const devShare = initialBuy > 0 ? initialBuy / LIMITS.totalPumpSupply : 0;

    const mem = this.db && creator ? this.db.getCreatorMemory(creator) : null;
    const shieldRec = mem
      ? { launched: mem.seen_launches, graduated: mem.clean_count }
      : null;
    const shield = evaluateShield(
      shieldRec,
      initialBuy,
      LIMITS.totalPumpSupply,
    );

    const launch = {
      mint: msg.mint,
      name: msg.name || "Unnamed",
      symbol: msg.symbol || "?",
      creator,
      uri: msg.uri || null,
      marketCapSol: msg.marketCapSol != null ? Number(msg.marketCapSol) : null,
      vTokens:
        msg.vTokensInBondingCurve != null
          ? Number(msg.vTokensInBondingCurve)
          : null,
      vSol:
        msg.vSolInBondingCurve != null ? Number(msg.vSolInBondingCurve) : null,
      initialBuy,
      devShare,
      shieldPass: shield.pass,
      shieldReason: shield.reason,
      createdAt: Date.now(),
    };

    if (this.db) {
      this.db.upsertLaunch(launch);
    }
    this.emit("launch", launch);
  }
}

module.exports = { LaunchRadar };
