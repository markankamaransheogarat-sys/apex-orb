"use strict";

/*
 * SQLite persistence (Node 22+ built-in node:sqlite, WAL mode):
 *   - launches: live pump.fun feed from PumpPortal WebSocket
 *   - scans: full dual-axis forensics reports
 *   - creator_memory: cross-token reputation of dev signers
 *   - operator_memory: cross-token memory of funding roots & sybil clusters
 *   - paper_trades: virtual execution sandbox with live PnL tracking
 */

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { DB_PATH } = require("./config");

class ApexDb {
  constructor(dbPath = DB_PATH) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS launches (
        mint TEXT PRIMARY KEY,
        name TEXT,
        symbol TEXT,
        creator TEXT,
        uri TEXT,
        market_cap_sol REAL,
        v_tokens REAL,
        v_sol REAL,
        initial_buy REAL,
        dev_share REAL,
        shield_pass INTEGER,
        shield_reason TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        symbol TEXT,
        name TEXT,
        safety_score INTEGER,
        alpha_score INTEGER,
        band TEXT,
        matrix_quadrant TEXT,
        state TEXT,
        liquidity_usd REAL,
        mcap_usd REAL,
        creator TEXT,
        payload_json TEXT NOT NULL,
        scanned_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scans_mint_time ON scans(mint, scanned_at DESC);

      CREATE TABLE IF NOT EXISTS creator_memory (
        creator TEXT PRIMARY KEY,
        seen_launches INTEGER NOT NULL DEFAULT 0,
        danger_count INTEGER NOT NULL DEFAULT 0,
        clean_count INTEGER NOT NULL DEFAULT 0,
        last_mint TEXT,
        last_symbol TEXT,
        last_seen INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operator_memory (
        root_addr TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        seen_tokens INTEGER NOT NULL DEFAULT 0,
        danger_tokens INTEGER NOT NULL DEFAULT 0,
        clean_tokens INTEGER NOT NULL DEFAULT 0,
        last_mint TEXT,
        last_symbol TEXT,
        last_seen INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paper_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        symbol TEXT,
        name TEXT,
        side TEXT NOT NULL DEFAULT 'LONG',
        status TEXT NOT NULL DEFAULT 'OPEN',
        entry_price_usd REAL NOT NULL,
        current_price_usd REAL NOT NULL,
        size_usd REAL NOT NULL,
        sl_pct REAL NOT NULL,
        tp_pct REAL NOT NULL,
        safety_score INTEGER,
        alpha_score INTEGER,
        pnl_usd REAL NOT NULL DEFAULT 0,
        pnl_pct REAL NOT NULL DEFAULT 0,
        exit_reason TEXT,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS pm_windows (
        slug TEXT PRIMARY KEY,
        asset TEXT NOT NULL,
        title TEXT,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        open_spot REAL,
        up_token_id TEXT NOT NULL,
        down_token_id TEXT NOT NULL,
        up_shares REAL NOT NULL DEFAULT 0,
        up_cost_usd REAL NOT NULL DEFAULT 0,
        down_shares REAL NOT NULL DEFAULT 0,
        down_cost_usd REAL NOT NULL DEFAULT 0,
        matched_shares REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'OPEN',
        winner TEXT,
        payout_usd REAL NOT NULL DEFAULT 0,
        realized_pnl_usd REAL NOT NULL DEFAULT 0,
        settled_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS pm_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        window_slug TEXT NOT NULL,
        asset TEXT NOT NULL,
        side TEXT NOT NULL,
        shares REAL NOT NULL,
        price REAL NOT NULL,
        fee_usd REAL NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL,
        fair_p REAL NOT NULL,
        edge REAL NOT NULL,
        reason TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pm_trades_ts ON pm_trades(ts DESC);
    `);
  }

  upsertLaunch(l) {
    this.db
      .prepare(
        `
      INSERT INTO launches (
        mint, name, symbol, creator, uri, market_cap_sol, v_tokens, v_sol,
        initial_buy, dev_share, shield_pass, shield_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mint) DO UPDATE SET
        market_cap_sol = COALESCE(excluded.market_cap_sol, launches.market_cap_sol),
        shield_pass = COALESCE(excluded.shield_pass, launches.shield_pass),
        shield_reason = COALESCE(excluded.shield_reason, launches.shield_reason)
    `,
      )
      .run(
        l.mint,
        l.name || null,
        l.symbol || null,
        l.creator || null,
        l.uri || null,
        l.marketCapSol ?? null,
        l.vTokens ?? null,
        l.vSol ?? null,
        l.initialBuy ?? null,
        l.devShare ?? null,
        l.shieldPass == null ? null : l.shieldPass ? 1 : 0,
        l.shieldReason || null,
        l.createdAt || Date.now(),
      );
  }

  recentLaunches(limit = 60) {
    return this.db
      .prepare(
        `
      SELECT * FROM launches ORDER BY created_at DESC LIMIT ?
    `,
      )
      .all(limit);
  }

  recordScan(scan) {
    const now = scan.scannedAt || Date.now();
    this.db
      .prepare(
        `
      INSERT INTO scans (
        mint, symbol, name, safety_score, alpha_score, band, matrix_quadrant,
        state, liquidity_usd, mcap_usd, creator, payload_json, scanned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        scan.mint,
        scan.token?.symbol || null,
        scan.token?.name || null,
        scan.safety?.score ?? null,
        scan.alpha?.score ?? null,
        scan.safety?.band || null,
        scan.matrix?.quadrant || null,
        scan.safety?.state || null,
        scan.market?.liquidityUsd ?? null,
        scan.market?.mcap ?? null,
        scan.guard?.creator || null,
        JSON.stringify(scan),
        now,
      );

    const isDanger =
      scan.safety?.band === "DANGER" ||
      (scan.guard && scan.guard.pass === false);
    const isClean = scan.safety?.band === "CLEAN";

    if (scan.guard?.creator) {
      this.db
        .prepare(
          `
        INSERT INTO creator_memory (creator, seen_launches, danger_count, clean_count, last_mint, last_symbol, last_seen)
        VALUES (?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT(creator) DO UPDATE SET
          seen_launches = seen_launches + 1,
          danger_count = danger_count + ?,
          clean_count = clean_count + ?,
          last_mint = excluded.last_mint,
          last_symbol = excluded.last_symbol,
          last_seen = excluded.last_seen
      `,
        )
        .run(
          scan.guard.creator,
          isDanger ? 1 : 0,
          isClean ? 1 : 0,
          scan.mint,
          scan.token?.symbol || null,
          now,
          isDanger ? 1 : 0,
          isClean ? 1 : 0,
        );
    }

    const rootsSeen = new Set();
    for (const op of scan.operators || []) {
      if (op.wallets.length > 1 && op.fundingRoots?.length) {
        for (const root of op.fundingRoots) {
          if (rootsSeen.has(root)) continue;
          rootsSeen.add(root);
          this.db
            .prepare(
              `
            INSERT INTO operator_memory (root_addr, kind, seen_tokens, danger_tokens, clean_tokens, last_mint, last_symbol, last_seen)
            VALUES (?, 'funding_root', 1, ?, ?, ?, ?, ?)
            ON CONFLICT(root_addr) DO UPDATE SET
              seen_tokens = seen_tokens + 1,
              danger_tokens = danger_tokens + ?,
              clean_tokens = clean_tokens + ?,
              last_mint = excluded.last_mint,
              last_symbol = excluded.last_symbol,
              last_seen = excluded.last_seen
          `,
            )
            .run(
              root,
              isDanger ? 1 : 0,
              isClean ? 1 : 0,
              scan.mint,
              scan.token?.symbol || null,
              now,
              isDanger ? 1 : 0,
              isClean ? 1 : 0,
            );
        }
      }
    }
  }

  getLatestScan(mint) {
    const row = this.db
      .prepare(
        `
      SELECT * FROM scans WHERE mint = ? ORDER BY scanned_at DESC LIMIT 1
    `,
      )
      .get(mint);
    if (!row) return null;
    return JSON.parse(row.payload_json);
  }

  recentScans(limit = 25) {
    return this.db
      .prepare(
        `
      SELECT id, mint, symbol, name, safety_score, alpha_score, band, matrix_quadrant, state, liquidity_usd, mcap_usd, creator, scanned_at
      FROM scans ORDER BY scanned_at DESC LIMIT ?
    `,
      )
      .all(limit);
  }

  getCreatorMemory(creator) {
    if (!creator) return null;
    return (
      this.db
        .prepare("SELECT * FROM creator_memory WHERE creator = ?")
        .get(creator) || null
    );
  }

  getOperatorMemory(roots) {
    if (!roots || !roots.length) return [];
    const placeholders = roots.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM operator_memory WHERE root_addr IN (${placeholders})`,
      )
      .all(...roots);
  }

  listOperatorMemory(limit = 50) {
    return this.db
      .prepare(
        `
      SELECT * FROM operator_memory ORDER BY danger_tokens DESC, seen_tokens DESC, last_seen DESC LIMIT ?
    `,
      )
      .all(limit);
  }

  listCreatorMemory(limit = 50) {
    return this.db
      .prepare(
        `
      SELECT * FROM creator_memory ORDER BY danger_count DESC, seen_launches DESC, last_seen DESC LIMIT ?
    `,
      )
      .all(limit);
  }

  openPaperTrade(trade) {
    const info = this.db
      .prepare(
        `
      INSERT INTO paper_trades (
        mint, symbol, name, side, status, entry_price_usd, current_price_usd,
        size_usd, sl_pct, tp_pct, safety_score, alpha_score, pnl_usd, pnl_pct, opened_at
      ) VALUES (?, ?, ?, 'LONG', 'OPEN', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
    `,
      )
      .run(
        trade.mint,
        trade.symbol || "TOKEN",
        trade.name || trade.symbol || "Unknown",
        trade.entryPriceUsd,
        trade.entryPriceUsd,
        trade.sizeUsd || 250,
        trade.slPct ?? -20,
        trade.tpPct ?? 45,
        trade.safetyScore ?? null,
        trade.alphaScore ?? null,
        Date.now(),
      );
    return this.db
      .prepare("SELECT * FROM paper_trades WHERE id = ?")
      .get(info.lastInsertRowid);
  }

  updatePaperTrade(id, fields) {
    this.db
      .prepare(
        `
      UPDATE paper_trades
      SET current_price_usd = ?, pnl_usd = ?, pnl_pct = ?, status = ?, exit_reason = ?, closed_at = ?
      WHERE id = ?
    `,
      )
      .run(
        fields.currentPriceUsd,
        fields.pnlUsd,
        fields.pnlPct,
        fields.status,
        fields.exitReason || null,
        fields.closedAt || null,
        id,
      );
  }

  listPaperTrades(limit = 50) {
    return this.db
      .prepare("SELECT * FROM paper_trades ORDER BY opened_at DESC LIMIT ?")
      .all(limit);
  }

  upsertPmWindow(w) {
    this.db
      .prepare(
        `
      INSERT INTO pm_windows (
        slug, asset, title, start_ts, end_ts, open_spot, up_token_id, down_token_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        open_spot = COALESCE(pm_windows.open_spot, excluded.open_spot),
        title = COALESCE(excluded.title, pm_windows.title)
    `,
      )
      .run(
        w.slug,
        w.asset,
        w.title || null,
        w.startTs,
        w.endTs,
        w.openSpot ?? null,
        w.upTokenId,
        w.downTokenId,
      );
    return this.db
      .prepare("SELECT * FROM pm_windows WHERE slug = ?")
      .get(w.slug);
  }

  getPmWindow(slug) {
    return (
      this.db.prepare("SELECT * FROM pm_windows WHERE slug = ?").get(slug) ||
      null
    );
  }

  getOpenPmWindows() {
    return this.db
      .prepare(
        "SELECT * FROM pm_windows WHERE status = 'OPEN' ORDER BY end_ts ASC",
      )
      .all();
  }

  listPmWindows(limit = 40) {
    return this.db
      .prepare("SELECT * FROM pm_windows ORDER BY start_ts DESC LIMIT ?")
      .all(limit);
  }

  recordPmFill(fill) {
    const win = this.getPmWindow(fill.windowSlug);
    if (!win || win.status !== "OPEN") return null;

    this.db
      .prepare(
        `
      INSERT INTO pm_trades (
        window_slug, asset, side, shares, price, fee_usd, cost_usd, fair_p, edge, reason, ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        fill.windowSlug,
        fill.asset,
        fill.side,
        fill.shares,
        fill.price,
        fill.feeUsd,
        fill.costUsd,
        fill.fairP,
        fill.edge,
        fill.reason,
        fill.ts || Date.now(),
      );

    const upShares = win.up_shares + (fill.side === "UP" ? fill.shares : 0);
    const upCost = win.up_cost_usd + (fill.side === "UP" ? fill.costUsd : 0);
    const downShares =
      win.down_shares + (fill.side === "DOWN" ? fill.shares : 0);
    const downCost =
      win.down_cost_usd + (fill.side === "DOWN" ? fill.costUsd : 0);
    const matched = Math.min(upShares, downShares);

    this.db
      .prepare(
        `
      UPDATE pm_windows
      SET up_shares = ?, up_cost_usd = ?, down_shares = ?, down_cost_usd = ?, matched_shares = ?
      WHERE slug = ?
    `,
      )
      .run(upShares, upCost, downShares, downCost, matched, fill.windowSlug);

    return this.getPmWindow(fill.windowSlug);
  }

  settlePmWindow(slug, winner) {
    const win = this.getPmWindow(slug);
    if (!win || win.status === "SETTLED") return win;
    const payout = winner === "UP" ? win.up_shares : win.down_shares;
    const totalCost = win.up_cost_usd + win.down_cost_usd;
    const pnl = payout - totalCost;
    const now = Date.now();
    this.db
      .prepare(
        `
      UPDATE pm_windows
      SET status = 'SETTLED', winner = ?, payout_usd = ?, realized_pnl_usd = ?, settled_at = ?
      WHERE slug = ?
    `,
      )
      .run(
        winner,
        Number(payout.toFixed(4)),
        Number(pnl.toFixed(4)),
        now,
        slug,
      );
    return this.getPmWindow(slug);
  }

  listPmTrades(limit = 60) {
    return this.db
      .prepare("SELECT * FROM pm_trades ORDER BY ts DESC LIMIT ?")
      .all(limit);
  }

  pmStats() {
    const agg = this.db
      .prepare(
        `
      SELECT
        COUNT(*) AS windows,
        SUM(CASE WHEN status = 'SETTLED' THEN 1 ELSE 0 END) AS settled,
        SUM(CASE WHEN status = 'SETTLED' AND realized_pnl_usd > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN status = 'SETTLED' AND (up_shares > 0 OR down_shares > 0) THEN 1 ELSE 0 END) AS traded_settled,
        COALESCE(SUM(realized_pnl_usd), 0) AS realized_pnl,
        COALESCE(SUM(up_shares + down_shares), 0) AS total_shares,
        COALESCE(SUM(matched_shares * 2), 0) AS matched_total_shares,
        COALESCE(SUM(up_cost_usd + down_cost_usd), 0) AS total_volume
      FROM pm_windows
    `,
      )
      .get();
    const tradesCount = this.db
      .prepare("SELECT COUNT(*) AS c FROM pm_trades")
      .get().c;
    const matchedPct =
      agg.total_shares > 0
        ? (agg.matched_total_shares / agg.total_shares) * 100
        : 0;
    const winRatePct =
      agg.traded_settled > 0 ? (agg.wins / agg.traded_settled) * 100 : 0;
    return {
      windows: agg.windows || 0,
      settled: agg.settled || 0,
      tradedSettled: agg.traded_settled || 0,
      wins: agg.wins || 0,
      winRatePct: Number(winRatePct.toFixed(1)),
      matchedPct: Number(matchedPct.toFixed(2)),
      realizedPnlUsd: Number((agg.realized_pnl || 0).toFixed(2)),
      totalVolumeUsd: Number((agg.total_volume || 0).toFixed(2)),
      tradesCount,
    };
  }

  resetPmData() {
    this.db.exec("DELETE FROM pm_trades; DELETE FROM pm_windows;");
  }

  stats() {
    const launches = this.db
      .prepare("SELECT COUNT(*) AS c FROM launches")
      .get().c;
    const scans = this.db.prepare("SELECT COUNT(*) AS c FROM scans").get().c;
    const dangerScans = this.db
      .prepare("SELECT COUNT(*) AS c FROM scans WHERE band = 'DANGER'")
      .get().c;
    const operatorsTracked = this.db
      .prepare("SELECT COUNT(*) AS c FROM operator_memory")
      .get().c;
    const creatorsTracked = this.db
      .prepare("SELECT COUNT(*) AS c FROM creator_memory")
      .get().c;
    const trades = this.db
      .prepare(
        "SELECT COUNT(*) AS c, COALESCE(SUM(pnl_usd), 0) AS pnl FROM paper_trades",
      )
      .get();
    return {
      launches,
      scans,
      dangerScans,
      operatorsTracked,
      creatorsTracked,
      paperTrades: trades.c,
      paperPnlUsd: Number(trades.pnl.toFixed(2)),
    };
  }
}

module.exports = { ApexDb };
