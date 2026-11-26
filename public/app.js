"use strict";

const state = {
  currentScan: null,
  activeTab: "scans",
  radarFeed: "trending",
  sphere: {
    rotY: 0.4,
    rotX: 0.25,
    dragging: false,
    lastX: 0,
    lastY: 0,
    projected: [],
    pulse: 0,
  },
  radarLaunches: [],
  trendingTokens: [],
};

const $ = (id) => document.getElementById(id);

function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return "N/A";
  const a = Math.abs(v);
  const s = v < 0 ? "-$" : "$";
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + "K";
  if (a >= 1) return s + a.toFixed(2);
  return s + a.toPrecision(3);
}

function shortAddr(a) {
  return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "—";
}

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function appendTrace(msg, level = "info") {
  const box = $("traceLog");
  const div = document.createElement("div");
  div.className = `trace-line ${level}`;
  div.textContent = msg;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function renderRadar() {
  const box = $("radarList");
  if (state.radarFeed === "trending") {
    if (!state.trendingTokens.length) {
      box.innerHTML =
        '<div class="empty">Загрузка активных токенов DexScreener...</div>';
      return;
    }
    box.innerHTML = state.trendingTokens
      .map(
        (t) => `
      <div class="radar-item" data-mint="${esc(t.mint)}">
        <div>
          <div class="sym">${shortAddr(t.mint)} <span class="badge good">ACTIVE</span></div>
          <div class="meta">${esc(t.description || "Trending Solana pool")}</div>
        </div>
        <button class="btn-mini" type="button">SCAN</button>
      </div>
    `,
      )
      .join("");
    box.querySelectorAll(".radar-item").forEach((el) => {
      el.addEventListener("click", () => runScan(el.dataset.mint));
    });
    return;
  }

  if (!state.radarLaunches.length) {
    box.innerHTML =
      '<div class="empty">Ожидание новых запусков с PumpPortal WebSocket...</div>';
    return;
  }
  box.innerHTML = state.radarLaunches
    .slice(0, 35)
    .map((l) => {
      const shieldClass = l.shield_pass === 0 ? "bad" : "good";
      const shieldTxt = l.shield_pass === 0 ? "HELD" : "SHIELD OK";
      const mcSol =
        l.market_cap_sol != null
          ? `${Number(l.market_cap_sol).toFixed(1)} SOL`
          : "—";
      return `
      <div class="radar-item" data-mint="${esc(l.mint)}">
        <div>
          <div class="sym">$${esc(l.symbol || "?")} <span class="muted">${esc((l.name || "").slice(0, 18))}</span></div>
          <div class="meta">${shortAddr(l.mint)} · MC ${mcSol} · <span class="${shieldClass === "bad" ? "c-bad" : "c-good"}">${shieldTxt}</span></div>
        </div>
        <button class="btn-mini" type="button">SCAN</button>
      </div>
    `;
    })
    .join("");

  box.querySelectorAll(".radar-item").forEach((el) => {
    el.addEventListener("click", () => runScan(el.dataset.mint));
  });
}

function renderChecks(scan) {
  const s = scan.safety;
  const a = scan.alpha;
  const t = scan.token;
  const m = s.metrics;

  const rows = [
    {
      k: "Biggest Operator Impact",
      v: `-${(m.impact * 100).toFixed(1)}% (${s.parts.operator}/35)`,
      cls: m.impact >= 0.5 ? "bad" : m.impact >= 0.25 ? "warn" : "ok",
    },
    {
      k: "Fresh Wallets",
      v: `${(m.virgin * 100).toFixed(0)}% (${s.parts.virgin}/25)`,
      cls: m.virgin >= 0.6 ? "bad" : m.virgin >= 0.3 ? "warn" : "ok",
    },
    {
      k: "Received by Transfer",
      v: `${(m.transfer * 100).toFixed(1)}% (${s.parts.transfer}/20)`,
      cls: m.transfer >= 0.1 ? "bad" : "ok",
    },
    {
      k: "Unsold Snipers",
      v: `${(m.sniper * 100).toFixed(1)}% (${s.parts.sniper}/10)`,
      cls: m.sniper >= 0.1 ? "warn" : "ok",
    },
    {
      k: "Top-20 Float Share",
      v: `${(m.concentration * 100).toFixed(1)}% (${s.parts.concentration}/10)`,
      cls: m.concentration >= 0.6 ? "warn" : "ok",
    },
    {
      k: "Orderflow Buy Ratio (5m)",
      v: `${a.microstructure.buyRatioPct}% (OFI ${a.microstructure.ofi5m ?? "N/A"})`,
      cls: a.microstructure.buyRatioPct >= 55 ? "ok" : "warn",
    },
    {
      k: "Owner Powers",
      v: `${t.mintAuthority ? "MINT LIVE" : "Mint Revoked"} · ${t.freezeAuthority ? "FREEZE LIVE" : "No Freeze"}`,
      cls: t.mintAuthority || t.freezeAuthority ? "bad" : "ok",
    },
  ];

  $("checksBox").innerHTML = rows
    .map(
      (r) => `
    <div class="check-row">
      <span class="lbl">${esc(r.k)}</span>
      <span class="val ${r.cls}">${esc(r.v)}</span>
    </div>
  `,
    )
    .join("");

  const gb = $("guardBadge");
  gb.textContent = scan.guard.pass ? "GUARD PASS" : "GUARD HELD";
  gb.className = `badge ${scan.guard.pass ? "good" : "bad"}`;
}

function renderVerdict(scan) {
  const s = scan.safety;
  const a = scan.alpha;
  const m = scan.market;

  $("tokenHeader").textContent =
    `$${scan.token.symbol} · ${shortAddr(scan.mint)}`;
  $("safetyScore").textContent = s.score == null ? "N/A" : s.score;
  $("safetyScore").className =
    `sc-val ${s.band === "CLEAN" ? "c-good" : s.band === "OK" ? "" : s.band === "RISKY" ? "c-warn" : "c-bad"}`;
  $("safetyBand").textContent =
    `${s.band}${s.state === "partial" ? " · PARTIAL" : ""}`;

  $("alphaScore").textContent = a.score;
  $("alphaScore").className =
    `sc-val ${a.score >= 65 ? "c-good" : a.score >= 45 ? "c-warn" : "c-bad"}`;
  $("alphaSub").textContent = a.matrix.quadrant.replace(/_/g, " ");

  const ab = $("actionBadge");
  ab.textContent = a.matrix.action;
  ab.className = `badge ${a.matrix.action === "PAPER_ENTER" ? "good" : a.matrix.action === "WATCH" ? "warn" : "bad"}`;

  $("matrixBadge").textContent = a.matrix.quadrant;
  $("rpcBadge").textContent = `${scan.rpcCallsUsed} RPC · ${scan.elapsedMs}ms`;

  $("marketStrip").innerHTML = `
    <div class="mkt-cell"><span class="k">PRICE USD</span><span class="v">${m.priceUsd ? fmtUsd(m.priceUsd) : "N/A"}</span></div>
    <div class="mkt-cell"><span class="k">LIQUIDITY</span><span class="v">${fmtUsd(m.liquidityUsd)}</span></div>
    <div class="mkt-cell"><span class="k">MCAP / FDV</span><span class="v">${fmtUsd(m.mcap || m.fdv)}</span></div>
    <div class="mkt-cell"><span class="k">24H VOL</span><span class="v">${fmtUsd(m.vol24Usd)}</span></div>
    <div class="mkt-cell"><span class="k">CURVE %</span><span class="v">${a.microstructure.curveProgressPct != null ? a.microstructure.curveProgressPct + "%" : scan.curve && scan.curve.complete ? "100% MIGRATED" : "N/A"}</span></div>
    <div class="mkt-cell"><span class="k">OPERATORS</span><span class="v">${scan.operators.length} (${scan.holders.length}W)</span></div>
  `;

  const allGates = [
    ...(s.gates || []),
    ...(a.warnings || []).map((w) => ({ hard: false, text: w })),
  ];
  $("gatesBox").innerHTML = allGates
    .map(
      (g) => `
    <div class="gate-pill ${g.hard ? "hard" : g.note ? "note" : ""}">${esc(g.text)}</div>
  `,
    )
    .join("");

  $("paperOpenBtn").disabled = !(m.priceUsd > 0);
  const dl = $("dexLink");
  dl.href = `https://dexscreener.com/solana/${scan.mint}`;
  dl.classList.remove("hidden");

  updateExitSimulator();
}

function updateExitSimulator() {
  const scan = state.currentScan;
  const posUsd = Number($("simSlider").value);
  $("simUsdLbl").textContent = `$${posUsd.toLocaleString()}`;
  if (!scan) return;

  const liqUsd = scan.market.liquidityUsd;
  const resUsd = liqUsd > 0 ? liqUsd / 2 : 0;
  const slip =
    resUsd > 0 ? (1 - Math.pow(resUsd / (resUsd + posUsd), 2)) * 100 : null;
  const totalCost = slip != null ? slip + 1.2 : null;
  const wash = scan.alpha.microstructure.turnoverToLiq;

  const wb = $("washBadge");
  wb.textContent = wash != null ? `TURNOVER/LIQ ${wash}x` : "N/A";
  wb.className = `badge ${wash != null && wash > 12 ? "bad" : "good"}`;

  const scen = scan.safety.scenario;
  $("simMetrics").innerHTML = `
    <div class="mkt-cell"><span class="k">YOUR SLIPPAGE</span><span class="v ${slip > 10 ? "c-bad" : "c-good"}">${slip != null ? slip.toFixed(2) + "%" : "N/A"}</span></div>
    <div class="mkt-cell"><span class="k">ROUND-TRIP COST</span><span class="v ${totalCost > 12 ? "c-bad" : "c-good"}">${totalCost != null ? totalCost.toFixed(2) + "%" : "N/A"}</span></div>
    <div class="mkt-cell"><span class="k">SUSPECT DUMP</span><span class="v c-bad">${scen ? "-" + Math.round(scen.drop * 100) + "% (" + (scen.share * 100).toFixed(1) + "%)" : "LOW"}</span></div>
    <div class="mkt-cell"><span class="k">SL / TP PLAN</span><span class="v">${scan.matrix.suggestedSlPct}% / +${scan.matrix.suggestedTpPct}%</span></div>
  `;
}

function renderHolders(scan) {
  $("opCountBadge").textContent = `${scan.operators.length} OPS`;
  $("holdersList").innerHTML = scan.holders
    .map(
      (h) => `
    <div class="holder-row">
      <div>
        <span>${shortAddr(h.owner)}</span>
        ${h.op ? `<span class="tag op">${esc(h.op)}</span>` : ""}
        ${h.dev ? '<span class="tag dev">DEV</span>' : ""}
        ${h.virgin ? '<span class="tag fresh">FRESH</span>' : ""}
        ${h.sniper ? '<span class="tag sniper">SNIPER</span>' : ""}
        ${h.kind === "transfer" ? '<span class="tag dev">XFER</span>' : ""}
      </div>
      <div><strong>${(h.share * 100).toFixed(2)}%</strong></div>
    </div>
  `,
    )
    .join("");
}

function drawMatrix(scan) {
  const canvas = $("matrixCanvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 320;
  const h = 190;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  ctx.fillStyle = "#070b10";
  ctx.fillRect(0, 0, w, h);

  // Quadrants
  const midX = w * 0.65; // Safety 65 threshold
  const midY = h * (1 - 0.62); // Alpha 62 threshold

  ctx.fillStyle = "rgba(16,185,129,0.08)";
  ctx.fillRect(midX, 0, w - midX, midY);
  ctx.fillStyle = "rgba(239,68,68,0.08)";
  ctx.fillRect(0, midY, midX, h - midY);

  ctx.strokeStyle = "#1f2e40";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(midX, 0);
  ctx.lineTo(midX, h);
  ctx.moveTo(0, midY);
  ctx.lineTo(w, midY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = "9px monospace";
  ctx.fillStyle = "#10b981";
  ctx.fillText("SNIPER GEM", midX + 6, 14);
  ctx.fillStyle = "#f59e0b";
  ctx.fillText("TRAP / BUNDLE", 8, 14);
  ctx.fillStyle = "#6e839b";
  ctx.fillText("SAFE SLOW", midX + 6, h - 8);
  ctx.fillStyle = "#ef4444";
  ctx.fillText("TOXIC AVOID", 8, h - 8);

  if (scan && scan.safety.score != null) {
    const px = (scan.safety.score / 100) * (w - 20) + 10;
    const py = h - ((scan.alpha.score / 100) * (h - 20) + 10);
    ctx.beginPath();
    ctx.arc(px, py, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#22d3ee";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.fillText(
      `$${scan.token.symbol} (${scan.safety.score},${scan.alpha.score})`,
      Math.min(w - 110, px + 10),
      Math.max(14, py - 6),
    );
  }
}

function renderSphereFrame() {
  const canvas = $("sphereCanvas");
  const wrap = canvas.parentElement;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = wrap.clientWidth || 500;
  const h = wrap.clientHeight || 390;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!state.sphere.dragging) state.sphere.rotY += 0.0028;
  state.sphere.pulse = (state.sphere.pulse + 0.025) % (Math.PI * 2);

  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.37;

  const cosY = Math.cos(state.sphere.rotY),
    sinY = Math.sin(state.sphere.rotY);
  const cosX = Math.cos(state.sphere.rotX),
    sinX = Math.sin(state.sphere.rotX);

  const project = (x0, y0, z0) => {
    const x1 = x0 * cosY - z0 * sinY;
    const z1 = x0 * sinY + z0 * cosY;
    const y2 = y0 * cosX - z1 * sinX;
    const z2 = y0 * sinX + z1 * cosX;
    const scale = 340 / (340 + z2);
    return { sx: cx + x1 * scale, sy: cy + y2 * scale, z: z2, scale };
  };

  // Core radial glow
  const coreGlow = ctx.createRadialGradient(cx, cy, 4, cx, cy, radius * 1.15);
  coreGlow.addColorStop(0, "rgba(34, 211, 238, 0.16)");
  coreGlow.addColorStop(0.45, "rgba(245, 158, 11, 0.05)");
  coreGlow.addColorStop(1, "rgba(5, 8, 12, 0)");
  ctx.fillStyle = coreGlow;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.15, 0, Math.PI * 2);
  ctx.fill();

  // Starburst 3D neural filaments (140 background Fibonacci rays)
  const RAY_COUNT = 140;
  for (let i = 0; i < RAY_COUNT; i++) {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / RAY_COUNT);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const rOut = radius * (0.86 + ((i * 37) % 15) * 0.014);
    const x0 = rOut * Math.sin(phi) * Math.cos(theta);
    const y0 = rOut * Math.sin(phi) * Math.sin(theta);
    const z0 = rOut * Math.cos(phi);
    const pt = project(x0, y0, z0);
    const isWarm = x0 < 0;
    const alpha = pt.z > 0 ? 0.09 : 0.24;
    ctx.strokeStyle = isWarm
      ? `rgba(251, 191, 36, ${alpha})`
      : `rgba(148, 163, 184, ${alpha * 0.85})`;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(pt.sx, pt.sy);
    ctx.stroke();

    ctx.fillStyle = isWarm
      ? `rgba(251, 191, 36, ${alpha * 1.7})`
      : `rgba(203, 213, 225, ${alpha * 1.5})`;
    ctx.fillRect(pt.sx - 0.8, pt.sy - 0.8, 1.6, 1.6);
  }

  // Outer orbital scan rings
  ctx.strokeStyle = "rgba(34, 211, 238, 0.14)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.04, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, cy, radius * 1.04, radius * 0.34, 0.15, 0, Math.PI * 2);
  ctx.stroke();

  const nodes =
    (state.currentScan &&
      state.currentScan.graph &&
      state.currentScan.graph.nodes) ||
    [];
  const edges =
    (state.currentScan &&
      state.currentScan.graph &&
      state.currentScan.graph.edges) ||
    [];
  $("sphereMeta").textContent = `${nodes.length} NODES · ${edges.length} LINKS`;

  if (!nodes.length) {
    requestAnimationFrame(renderSphereFrame);
    return;
  }

  const posMap = new Map();
  const projected = [];

  nodes.forEach((node, idx) => {
    const phi = Math.acos(1 - (2 * (idx + 0.5)) / nodes.length);
    const theta = Math.PI * (1 + Math.sqrt(5)) * idx;
    const r = node.isRoot ? radius * 0.42 : radius * 0.96;
    const x0 = r * Math.sin(phi) * Math.cos(theta);
    const y0 = r * Math.sin(phi) * Math.sin(theta);
    const z0 = r * Math.cos(phi);
    const pt = { node, ...project(x0, y0, z0) };
    posMap.set(node.id, pt);
    projected.push(pt);
  });

  // Draw curved cluster arcs
  for (const e of edges) {
    const a = posMap.get(e.source);
    const b = posMap.get(e.target);
    if (!a || !b) continue;
    const midX = (a.sx + b.sx) / 2 + (cy - (a.sy + b.sy) / 2) * 0.14;
    const midY = (a.sy + b.sy) / 2 + ((a.sx + b.sx) / 2 - cx) * 0.14;
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.quadraticCurveTo(midX, midY, b.sx, b.sy);
    ctx.strokeStyle =
      e.kind === "funded_by"
        ? "rgba(239, 68, 68, 0.72)"
        : e.level === "pack"
          ? "rgba(245, 158, 11, 0.65)"
          : "rgba(217, 70, 239, 0.8)";
    ctx.lineWidth = e.level === "proven" ? 1.8 : 1.1;
    ctx.stroke();
  }

  // Draw holder & root nodules back-to-front with halos
  projected.sort((a, b) => b.z - a.z);
  state.sphere.projected = projected;

  for (const pt of projected) {
    const n = pt.node;
    const baseR = n.isRoot
      ? 7
      : Math.max(4, Math.min(14, 4 + (n.share || 0) * 55));
    const r = baseR * pt.scale;
    const color =
      n.isRoot || n.dev
        ? "#ef4444"
        : n.op
          ? "#d946ef"
          : n.virgin
            ? "#f59e0b"
            : "#10b981";

    // Luminous ray from core to major holders
    if (!n.isRoot) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(pt.sx, pt.sy);
      ctx.strokeStyle = color;
      ctx.globalAlpha = pt.z > 0 ? 0.14 : 0.35;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Outer halo
    ctx.beginPath();
    ctx.arc(pt.sx, pt.sy, r * 1.8, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = pt.z > 0 ? 0.12 : 0.22;
    ctx.fill();

    // Solid nodule
    ctx.beginPath();
    ctx.arc(pt.sx, pt.sy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = pt.z > 0 ? 0.65 : 0.98;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#ffffff";
    ctx.globalAlpha = pt.z > 0 ? 0.25 : 0.65;
    ctx.stroke();

    ctx.globalAlpha = 1;
    if (n.isRoot || n.share > 0.03 || nodes.length <= 15) {
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "9px monospace";
      const pctTxt = n.isRoot ? "" : ` ${(n.share * 100).toFixed(1)}%`;
      ctx.fillText(`${n.label}${pctTxt}`, pt.sx + r + 4, pt.sy + 3);
    }
  }

  requestAnimationFrame(renderSphereFrame);
}

async function runScan(mint) {
  const clean = String(mint || $("mintInput").value).trim();
  if (!clean) return;
  $("mintInput").value = clean;
  $("scanBtn").disabled = true;
  $("traceLog").innerHTML = "";
  appendTrace(`[INIT] Запуск полного скана ${clean}...`);

  try {
    const report = await api("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mint: clean }),
    });
    state.currentScan = report;
    renderChecks(report);
    renderVerdict(report);
    renderHolders(report);
    drawMatrix(report);
    await Promise.all([loadHealth(), loadTabData()]);
  } catch (err) {
    appendTrace(`[ERROR] ${err.message}`, "danger");
  } finally {
    $("scanBtn").disabled = false;
  }
}

async function loadHealth() {
  try {
    const h = await api("/api/health");
    $("statLaunches").textContent = h.stats.launches;
    $("statScans").textContent = h.stats.scans;
    $("statMemory").textContent =
      h.stats.operatorsTracked + h.stats.creatorsTracked;
    $("statPnl").textContent = fmtUsd(h.stats.paperPnlUsd);
    $("statPnl").className =
      `v ${h.stats.paperPnlUsd >= 0 ? "c-good" : "c-bad"}`;
    $("radarDot").className = `pulse-dot ${h.radarConnected ? "live" : ""}`;
    $("radarStatus").textContent = h.radarConnected
      ? `LIVE (${h.radarSeen})`
      : "RECONNECTING";
  } catch {}
}

async function loadTabData() {
  const body = $("tabBody");
  if (state.activeTab === "scans") {
    const { scans } = await api("/api/scans?limit=20");
    if (!scans.length) {
      body.innerHTML = '<div class="empty">Сканов пока нет</div>';
      return;
    }
    body.innerHTML = `
      <table>
        <thead><tr><th>TOKEN</th><th>MINT</th><th>SAFETY</th><th>ALPHA</th><th>QUADRANT</th><th>LIQUIDITY</th><th>MCAP</th><th></th></tr></thead>
        <tbody>
          ${scans
            .map(
              (s) => `
            <tr>
              <td><strong>$${esc(s.symbol || "?")}</strong></td>
              <td class="muted">${shortAddr(s.mint)}</td>
              <td class="${s.band === "CLEAN" ? "c-good" : s.band === "DANGER" ? "c-bad" : "c-warn"}">${s.safety_score} (${esc(s.band)})</td>
              <td>${s.alpha_score}</td>
              <td>${esc(s.matrix_quadrant)}</td>
              <td>${fmtUsd(s.liquidity_usd)}</td>
              <td>${fmtUsd(s.mcap_usd)}</td>
              <td><button class="btn-mini open-scan" data-mint="${esc(s.mint)}">OPEN</button></td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    `;
    body.querySelectorAll(".open-scan").forEach((b) => {
      b.addEventListener("click", async () => {
        const full = await api(`/api/scans/${b.dataset.mint}`);
        state.currentScan = full;
        renderChecks(full);
        renderVerdict(full);
        renderHolders(full);
        drawMatrix(full);
      });
    });
  } else if (state.activeTab === "memory") {
    const { operators, creators } = await api("/api/memory");
    body.innerHTML = `
      <table>
        <thead><tr><th>TYPE</th><th>ADDRESS</th><th>SEEN TOKENS</th><th>DANGER HITS</th><th>CLEAN HITS</th><th>LAST TOKEN</th></tr></thead>
        <tbody>
          ${operators.map((o) => `<tr><td><span class="tag op">FUNDING ROOT</span></td><td>${esc(o.root_addr)}</td><td>${o.seen_tokens}</td><td class="${o.danger_tokens ? "c-bad" : ""}">${o.danger_tokens}</td><td class="c-good">${o.clean_tokens}</td><td>$${esc(o.last_symbol || "?")}</td></tr>`).join("")}
          ${creators.map((c) => `<tr><td><span class="tag dev">DEV CREATOR</span></td><td>${esc(c.creator)}</td><td>${c.seen_launches}</td><td class="${c.danger_count ? "c-bad" : ""}">${c.danger_count}</td><td class="c-good">${c.clean_count}</td><td>$${esc(c.last_symbol || "?")}</td></tr>`).join("")}
        </tbody>
      </table>
    `;
  } else if (state.activeTab === "paper") {
    const { trades } = await api("/api/paper");
    if (!trades.length) {
      body.innerHTML =
        '<div class="empty">Paper-сделок пока нет. Откройте скан любого токена и нажмите PAPER LONG $250.</div>';
      return;
    }
    body.innerHTML = `
      <table>
        <thead><tr><th>TOKEN</th><th>STATUS</th><th>ENTRY</th><th>CURRENT</th><th>SIZE</th><th>PNL</th><th>SL/TP</th><th>REASON</th><th></th></tr></thead>
        <tbody>
          ${trades
            .map(
              (t) => `
            <tr>
              <td><strong>$${esc(t.symbol)}</strong></td>
              <td>${esc(t.status)}</td>
              <td>${fmtUsd(t.entry_price_usd)}</td>
              <td>${fmtUsd(t.current_price_usd)}</td>
              <td>$${t.size_usd}</td>
              <td class="${t.pnl_usd >= 0 ? "c-good" : "c-bad"}">${fmtUsd(t.pnl_usd)} (${t.pnl_pct.toFixed(1)}%)</td>
              <td>${t.sl_pct}% / +${t.tp_pct}%</td>
              <td class="muted">${esc(t.exit_reason || "—")}</td>
              <td>${t.status === "OPEN" ? `<button class="btn-mini close-paper" data-id="${t.id}">CLOSE</button>` : ""}</td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    `;
    body.querySelectorAll(".close-paper").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api("/api/paper/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: Number(btn.dataset.id) }),
        });
        await Promise.all([loadHealth(), loadTabData()]);
      });
    });
  }
}

function initEvents() {
  $("scanForm").addEventListener("submit", (e) => {
    e.preventDefault();
    runScan();
  });

  $("simSlider").addEventListener("input", updateExitSimulator);

  $("paperOpenBtn").addEventListener("click", async () => {
    const s = state.currentScan;
    if (!s || !(s.market.priceUsd > 0)) return;
    await api("/api/paper/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mint: s.mint,
        symbol: s.token.symbol,
        name: s.token.name,
        priceUsd: s.market.priceUsd,
        sizeUsd: 250,
        slPct: s.matrix.suggestedSlPct,
        tpPct: s.matrix.suggestedTpPct,
      }),
    });
    state.activeTab = "paper";
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.toggle("active", t.dataset.tab === "paper"));
    await Promise.all([loadHealth(), loadTabData()]);
  });

  $("refreshPaperBtn").addEventListener("click", async () => {
    await api("/api/paper/refresh", { method: "POST" });
    await Promise.all([loadHealth(), loadTabData()]);
  });

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      document
        .querySelectorAll(".tab")
        .forEach((t) => t.classList.toggle("active", t === btn));
      loadTabData();
    });
  });

  const canvas = $("sphereCanvas");
  canvas.addEventListener("mousedown", (e) => {
    state.sphere.dragging = true;
    state.sphere.lastX = e.clientX;
    state.sphere.lastY = e.clientY;
  });
  window.addEventListener("mouseup", () => {
    state.sphere.dragging = false;
  });
  window.addEventListener("mousemove", (e) => {
    if (!state.sphere.dragging) return;
    state.sphere.rotY += (e.clientX - state.sphere.lastX) * 0.008;
    state.sphere.rotX += (e.clientY - state.sphere.lastY) * 0.008;
    state.sphere.lastX = e.clientX;
    state.sphere.lastY = e.clientY;
  });

  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = state.sphere.projected.find(
      (pt) => Math.hypot(pt.sx - x, pt.sy - y) <= 12,
    );
    const insp = $("nodeInspector");
    if (!hit) {
      insp.classList.add("hidden");
      return;
    }
    const n = hit.node;
    insp.innerHTML = `
      <div><strong>${esc(n.label)}</strong></div>
      <div class="muted">${esc(n.owner)}</div>
      ${
        n.isRoot
          ? '<div class="c-bad">SOL Funding Root</div>'
          : `
        <div>Share: <strong>${(n.share * 100).toFixed(2)}%</strong></div>
        <div>Operator: <strong>${esc(n.op || "Independent")}</strong></div>
        <div>Flags: ${[n.dev && "DEV", n.virgin && "FRESH", n.sniper && "SNIPER", n.kind === "transfer" && "TRANSFER"].filter(Boolean).join(", ") || "Clean"}</div>
      `
      }
    `;
    insp.classList.remove("hidden");
  });

  document.querySelectorAll(".feed-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.radarFeed = btn.dataset.feed;
      document
        .querySelectorAll(".feed-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      renderRadar();
    });
  });

  // SSE stream
  const es = new EventSource("/api/stream");
  es.addEventListener("launch", (ev) => {
    const launch = JSON.parse(ev.data);
    state.radarLaunches.unshift(launch);
    state.radarLaunches = state.radarLaunches.slice(0, 60);
    if (state.radarFeed === "launches") renderRadar();
    loadHealth();
  });
  es.addEventListener("scan_trace", (ev) => {
    const d = JSON.parse(ev.data);
    appendTrace(`[+${d.t}ms] ${d.msg}`, d.level);
  });
  es.addEventListener("radar_status", () => loadHealth());
  es.addEventListener("heartbeat", () => loadHealth());
}

async function bootstrap() {
  initEvents();
  drawMatrix(null);
  requestAnimationFrame(renderSphereFrame);

  const [radarRes, trendingRes, scansRes] = await Promise.all([
    api("/api/radar?limit=40"),
    api("/api/trending").catch(() => ({ tokens: [] })),
    api("/api/scans?limit=15").catch(() => ({ scans: [] })),
    loadHealth(),
    loadTabData(),
  ]);
  state.radarLaunches = radarRes.launches || [];
  state.trendingTokens = trendingRes.tokens || [];
  renderRadar();

  const preferred =
    (scansRes.scans || []).find((s) => s.safety_score != null) ||
    (scansRes.scans || [])[0];
  if (preferred) {
    try {
      const full = await api(`/api/scans/${preferred.mint}`);
      state.currentScan = full;
      renderChecks(full);
      renderVerdict(full);
      renderHolders(full);
      drawMatrix(full);
      $("traceLog").innerHTML = (full.trace || [])
        .map(
          (t) =>
            `<div class="trace-line ${esc(t.level || "info")}">[+${t.t}ms] ${esc(t.msg)}</div>`,
        )
        .join("");
    } catch {}
  }
}

bootstrap();
