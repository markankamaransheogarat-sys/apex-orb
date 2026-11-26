"use strict";

/*
 * ApexOrb HTTP + SSE Server:
 *   - Serves the Cyber-Terminal UI from public/
 *   - Streams live pump.fun launches and scan traces via SSE (/api/stream)
 *   - Runs live on-chain Solana forensics (/api/scan)
 *   - Manages SQLite Operator Memory & Paper-Trading Sandbox
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");

const { PORT, HOST, RPC_ENDPOINTS } = require("./config");
const { ApexDb } = require("./db");
const { SolanaRpcPool } = require("./solana/rpc");
const { isAddress } = require("./solana/util");
const { scanToken } = require("./engine/scanner");
const { LaunchRadar } = require("./engine/radar");
const { refreshPaperTrades } = require("./engine/paper");

const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function createApp(opts = {}) {
  const db = opts.db || new ApexDb(opts.dbPath);
  const rpc = opts.rpc || new SolanaRpcPool(opts.rpcEndpoints || RPC_ENDPOINTS);
  const radar = opts.radar !== undefined ? opts.radar : new LaunchRadar({ db });
  const sseClients = new Set();

  function broadcast(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  if (radar) {
    radar.on("launch", (launch) => broadcast("launch", launch));
    radar.on("status", (st) => broadcast("radar_status", st));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/api/health") {
        return sendJson(res, 200, {
          ok: true,
          radarConnected: Boolean(radar && radar.connected),
          radarSeen: radar ? radar.seenCount : 0,
          rpcCount: rpc.endpoints.length,
          stats: db.stats(),
        });
      }

      if (req.method === "GET" && pathname === "/api/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          `event: hello\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`,
        );
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      if (req.method === "GET" && pathname === "/api/radar") {
        const limit = Math.min(
          100,
          Math.max(1, Number(url.searchParams.get("limit") || 40)),
        );
        return sendJson(res, 200, {
          connected: Boolean(radar && radar.connected),
          launches: db.recentLaunches(limit),
        });
      }

      if (req.method === "GET" && pathname === "/api/scans") {
        const limit = Math.min(
          50,
          Math.max(1, Number(url.searchParams.get("limit") || 20)),
        );
        return sendJson(res, 200, { scans: db.recentScans(limit) });
      }

      if (req.method === "GET" && pathname.startsWith("/api/scans/")) {
        const mint = pathname.slice("/api/scans/".length).trim();
        if (!isAddress(mint))
          return sendJson(res, 400, { error: "Invalid mint address" });
        const latest = db.getLatestScan(mint);
        if (!latest) return sendJson(res, 404, { error: "Scan not found" });
        return sendJson(res, 200, latest);
      }

      if (req.method === "POST" && pathname === "/api/scan") {
        const body = await readBody(req);
        const mint = String(body.mint || "").trim();
        if (!isAddress(mint)) {
          return sendJson(res, 400, {
            error: "Invalid Solana mint address (expected 32-44 base58 chars)",
          });
        }
        const report = await scanToken(mint, {
          rpc,
          db,
          onTrace: (entry) => broadcast("scan_trace", { mint, ...entry }),
        });
        broadcast("scan_done", {
          mint,
          symbol: report.token.symbol,
          safety: report.safety.score,
          alpha: report.alpha.score,
          band: report.safety.band,
          quadrant: report.matrix.quadrant,
        });
        return sendJson(res, 200, report);
      }

      if (req.method === "GET" && pathname === "/api/memory") {
        return sendJson(res, 200, {
          operators: db.listOperatorMemory(40),
          creators: db.listCreatorMemory(40),
        });
      }

      if (req.method === "GET" && pathname === "/api/paper") {
        return sendJson(res, 200, { trades: db.listPaperTrades(50) });
      }

      if (req.method === "POST" && pathname === "/api/paper/open") {
        const body = await readBody(req);
        const mint = String(body.mint || "").trim();
        if (!isAddress(mint))
          return sendJson(res, 400, { error: "Invalid mint address" });
        const latest = db.getLatestScan(mint);
        const priceUsd = Number(
          body.priceUsd ||
            (latest && latest.market && latest.market.priceUsd) ||
            0,
        );
        if (!(priceUsd > 0))
          return sendJson(res, 400, {
            error: "Positive USD price required to open paper trade",
          });

        const trade = db.openPaperTrade({
          mint,
          symbol:
            body.symbol ||
            (latest && latest.token && latest.token.symbol) ||
            "TOKEN",
          name:
            body.name ||
            (latest && latest.token && latest.token.name) ||
            "Unknown",
          entryPriceUsd: priceUsd,
          sizeUsd: Math.min(10_000, Math.max(10, Number(body.sizeUsd || 250))),
          slPct: Number(body.slPct ?? -20),
          tpPct: Number(body.tpPct ?? 45),
          safetyScore: latest && latest.safety ? latest.safety.score : null,
          alphaScore: latest && latest.alpha ? latest.alpha.score : null,
        });
        return sendJson(res, 201, { trade });
      }

      if (req.method === "POST" && pathname === "/api/paper/refresh") {
        const updated = await refreshPaperTrades(db);
        return sendJson(res, 200, { updated, trades: db.listPaperTrades(50) });
      }

      if (req.method === "POST" && pathname === "/api/paper/close") {
        const body = await readBody(req);
        const id = Number(body.id);
        const trade = db.listPaperTrades(100).find((t) => t.id === id);
        if (!trade) return sendJson(res, 404, { error: "Trade not found" });
        if (trade.status !== "OPEN")
          return sendJson(res, 400, { error: "Trade already closed" });
        db.updatePaperTrade(id, {
          currentPriceUsd: trade.current_price_usd,
          pnlUsd: trade.pnl_usd,
          pnlPct: trade.pnl_pct,
          status: "CLOSED",
          exitReason: "Manual close",
          closedAt: Date.now(),
        });
        return sendJson(res, 200, { ok: true, trades: db.listPaperTrades(50) });
      }

      // Static files from public/
      if (req.method === "GET") {
        const rel =
          pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        const fullPath = path.resolve(PUBLIC_DIR, rel);
        if (
          !fullPath.startsWith(PUBLIC_DIR + path.sep) &&
          fullPath !== path.join(PUBLIC_DIR, "index.html")
        ) {
          return sendJson(res, 403, { error: "Forbidden" });
        }
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const ext = path.extname(fullPath);
          res.writeHead(200, {
            "Content-Type": MIME[ext] || "application/octet-stream",
          });
          return fs.createReadStream(fullPath).pipe(res);
        }
      }

      return sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      return sendJson(res, 500, { error: err.message || "Internal error" });
    }
  });

  let paperTimer = null;
  let heartbeatTimer = null;

  function start(listenPort = PORT, listenHost = HOST) {
    if (radar) radar.start();
    paperTimer = setInterval(() => {
      refreshPaperTrades(db).catch(() => {});
    }, 45_000);
    heartbeatTimer = setInterval(() => {
      broadcast("heartbeat", { ts: Date.now(), stats: db.stats() });
    }, 15_000);

    return new Promise((resolve) => {
      server.listen(listenPort, listenHost, () => {
        resolve(server.address());
      });
    });
  }

  function stop() {
    if (paperTimer) clearInterval(paperTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (radar) radar.stop();
    for (const res of sseClients) {
      try {
        res.end();
      } catch {}
    }
    sseClients.clear();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, db, rpc, radar, start, stop };
}

if (require.main === module) {
  const app = createApp();
  app.start().then((addr) => {
    console.log(`[ApexOrb] listening on http://${addr.address}:${addr.port}`);
  });
}

module.exports = { createApp };
