"use strict";

/*
 * ApexOrb Configuration: RPC endpoints, scan budget, Safety & Alpha scoring thresholds.
 * Zero external dependencies — runs purely on Node 22+ built-ins.
 */

const PORT = Number(process.env.PORT || 8792);
const HOST = process.env.HOST || "127.0.0.1";
const DB_PATH =
  process.env.APEXORB_DB ||
  require("node:path").join(__dirname, "..", "data", "apexorb.db");

const RPC_ENDPOINTS = process.env.SOLANA_RPC_URLS
  ? process.env.SOLANA_RPC_URLS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : [
      process.env.SOLANA_RPC_URL,
      "https://api.mainnet-beta.solana.com",
      "https://solana-rpc.publicnode.com",
    ].filter(Boolean);

const PUMPPORTAL_WS =
  process.env.PUMPPORTAL_WS || "wss://pumpportal.fun/api/data";

const BUDGET = {
  maxRpcCallsPerScan: Number(process.env.MAX_RPC_CALLS || 85),
  scanTimeoutMs: Number(process.env.SCAN_TIMEOUT_MS || 28000),
  holderHistoryLimit: 18, // signatures fetched per holder for age/virgin/funding check
  deepMinShare: 0.002, // 0.2% of float: below this, unread wallets don't trigger PARTIAL
  maxHoldersToInspect: 20,
  firstBuyersCount: 20,
  rpcConcurrency: 4,
};

const SAFETY_WEIGHTS = {
  operator: 35,
  virgin: 25,
  transfer: 20,
  sniper: 10,
  concentration: 10,
};

const SAFETY_SCALE = {
  operator: [0.1, 0.6], // price drop from biggest operator sell
  virgin: [0.1, 0.8], // share of fresh wallets among read top holders
  transfer: [0.01, 0.1], // share of float received via transfer instead of buy
  sniper: [0.01, 0.15], // unsold snipers within first 30s / slot-0
  concentration: [0.25, 0.7], // top-20 total float share
};

const ALPHA_WEIGHTS = {
  orderflow: 30, // 5m/1h buy pressure & net buyer imbalance
  velocity: 25, // bonding curve velocity / graduation proximity or pool momentum
  washCleanliness: 20, // Turnover/Liquidity anti-wash-trading hygiene
  exitability: 15, // Cost-to-Impact gate for $1,000 trade size
  organicBreadth: 10, // independent operators / total holders ratio + clean memory
};

const LIMITS = {
  minHolders: 10,
  lowLiquidityUsd: 1000,
  establishedDays: 30,
  establishedLiq: 500000,
  establishedMcap: 10000000,
  shieldMinLaunches: 10,
  shieldMaxGradPct: 10,
  devMaxShare: 0.15,
  slot0MaxShare: 0.3,
  washRatioSoft: 12.0, // inspired by Jarvis Cost/OI hygiene: >12x turnover/liq gets penalized
  washRatioHard: 40.0, // >40x turnover/liq -> wash-trade warning
  exitPositionUsd: 1000, // reference position size for Exitability Gate
  maxExitImpactPct: 0.12, // >12% round-trip slippage+fee -> illiquid exit warning
  totalPumpSupply: 1e9,
  initialRealTokenReserves: 793_100_000,
};

module.exports = {
  PORT,
  HOST,
  DB_PATH,
  RPC_ENDPOINTS,
  PUMPPORTAL_WS,
  BUDGET,
  SAFETY_WEIGHTS,
  SAFETY_SCALE,
  ALPHA_WEIGHTS,
  LIMITS,
};
