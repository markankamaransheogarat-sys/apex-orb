"use strict";

/*
 * Solana program IDs, derived PDAs, binary account decoders (pump.fun 2026 IDL,
 * PumpSwap, Raydium CPMM, Metaplex, Token-2022), and transaction forensics parser.
 */

const { findPda, u64, pk, b58decode } = require("./util");

const PROGRAMS = {
  SYSTEM: "11111111111111111111111111111111",
  TOKEN: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN22: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ATA: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  METAPLEX: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  PUMP: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PUMP_AMM: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  RAY_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  RAY_CPMM: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  RAY_CLMM: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  RAY_LAUNCHLAB: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
  MET_DLMM: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  MET_DAMM1: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
  MET_DAMM2: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEEm1VG",
  MET_DBC: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  ORCA: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  JUP6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  STREAMFLOW: "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m",
  JUP_LOCK: "LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn",
  RAY_LOCK: "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE",
  MAYHEM: "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e",
};

const WSOL = "So11111111111111111111111111111111111111112";
const BURN = "1nc1nerator11111111111111111111111111111111";
const RAY_V4_AUTH = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const RAY_CPMM_AUTH = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const DEFAULT_PK = "11111111111111111111111111111111";

const MAYHEM_VAULT = findPda(["sol-vault"], PROGRAMS.MAYHEM);

// Known CEX hot wallets, bridges, fee collectors and Jito tip accounts so funding-graph never falsely merges unrelated users
const NON_OPERATOR_FUNDERS = new Set([
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", // Binance 2
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // Binance 3
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S", // Coinbase 1
  "GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE", // Coinbase 2
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS", // Coinbase Commerce / Hot
  "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD", // OKX
  "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2", // Bybit
  "u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w", // Gate.io
  "BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6", // KuCoin
  "FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5", // Kraken
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", // Jito Tip 1
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe", // Jito Tip 2
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", // Jito Tip 3
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49", // Jito Tip 4
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", // Jito Tip 5
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt", // Jito Tip 6
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", // Jito Tip 7
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT", // Jito Tip 8
]);

const JITO_TIP_ACCOUNTS = new Set([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);

const INFRA_PROGRAMS = {
  [PROGRAMS.PUMP]: "bonding curve",
  [PROGRAMS.PUMP_AMM]: "PumpSwap pool",
  [PROGRAMS.RAY_V4]: "Raydium pool",
  [PROGRAMS.RAY_CPMM]: "Raydium CPMM vault",
  [PROGRAMS.RAY_CLMM]: "Raydium CLMM pool",
  [PROGRAMS.RAY_LAUNCHLAB]: "LaunchLab curve",
  [PROGRAMS.MET_DLMM]: "Meteora pool",
  [PROGRAMS.MET_DAMM1]: "Meteora pool",
  [PROGRAMS.MET_DAMM2]: "Meteora pool",
  [PROGRAMS.MET_DBC]: "Meteora curve",
  [PROGRAMS.ORCA]: "Orca pool",
  [PROGRAMS.STREAMFLOW]: "locker",
  [PROGRAMS.JUP_LOCK]: "locker",
  [PROGRAMS.RAY_LOCK]: "LP locker",
};

const INFRA_ADDR = {
  [RAY_V4_AUTH]: "Raydium pool",
  [RAY_CPMM_AUTH]: "Raydium CPMM vault",
  [BURN]: "burn address",
  [MAYHEM_VAULT]: "mayhem agent",
};

const SWAP_PROGRAMS = new Set([
  PROGRAMS.PUMP,
  PROGRAMS.PUMP_AMM,
  PROGRAMS.RAY_V4,
  PROGRAMS.RAY_CPMM,
  PROGRAMS.RAY_CLMM,
  PROGRAMS.RAY_LAUNCHLAB,
  PROGRAMS.MET_DLMM,
  PROGRAMS.MET_DAMM1,
  PROGRAMS.MET_DAMM2,
  PROGRAMS.MET_DBC,
  PROGRAMS.ORCA,
  PROGRAMS.JUP6,
]);

const BONDING_CURVE_DISC = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);

const bondingCurve = (mint) => findPda(["bonding-curve", mint], PROGRAMS.PUMP);
const metadataPda = (mint) =>
  findPda(["metadata", b58decode(PROGRAMS.METAPLEX), mint], PROGRAMS.METAPLEX);

function pumpSwapPool(mint, quote = WSOL) {
  const auth = findPda(["pool-authority", mint], PROGRAMS.PUMP);
  const idx = Buffer.alloc(2);
  idx.writeUInt16LE(0);
  return findPda(["pool", idx, auth, mint, quote], PROGRAMS.PUMP_AMM);
}

function decodeCurve(buf) {
  if (!buf || buf.length < 49) return null;
  if (!buf.subarray(0, 8).equals(BONDING_CURVE_DISC)) return null;
  const quoteMint = buf.length >= 115 ? pk(buf, 83) : null;
  const nonSolQuote =
    quoteMint && quoteMint !== DEFAULT_PK && quoteMint !== WSOL
      ? quoteMint
      : null;
  const quoteScale = nonSolQuote ? 1e6 : 1e9;
  const creator = buf.length >= 81 ? pk(buf, 49) : null;
  return {
    vTokens: u64(buf, 8) / 1e6,
    vSol: u64(buf, 16) / quoteScale,
    realTokens: u64(buf, 24) / 1e6,
    realSol: u64(buf, 32) / quoteScale,
    supply: u64(buf, 40) / 1e6,
    complete: buf[48] === 1,
    creator: creator === DEFAULT_PK ? null : creator,
    mayhem: buf.length >= 82 ? buf[81] === 1 : false,
    quoteMint: nonSolQuote,
  };
}

function decodeMetaplex(buf) {
  try {
    let o = 1;
    const updateAuthority = pk(buf, o);
    o += 32;
    const mint = pk(buf, o);
    o += 32;
    const readStr = () => {
      const len = buf.readUInt32LE(o);
      o += 4;
      const val = buf
        .subarray(o, o + len)
        .toString("utf8")
        .replace(/\0+$/, "")
        .trim();
      o += len;
      return val;
    };
    const name = readStr();
    const symbol = readStr();
    const uri = readStr();
    o += 2; // seller_fee_basis_points
    if (buf[o++] === 1) {
      const n = buf.readUInt32LE(o);
      o += 4 + n * 34;
    }
    o += 1; // primary_sale_happened
    const mutable = buf[o] === 1;
    return { updateAuthority, mint, name, symbol, uri, mutable };
  } catch {
    return null;
  }
}

function parseMint(value) {
  if (
    !value ||
    !value.data ||
    !value.data.parsed ||
    value.data.parsed.type !== "mint"
  )
    return null;
  const info = value.data.parsed.info;
  const ext = info.extensions || [];
  const feeExt = ext.find((e) => e.extension === "transferFeeConfig");
  const mdExt = ext.find((e) => e.extension === "tokenMetadata");
  let transferFeeBps = null;
  if (feeExt && feeExt.state) {
    const feeCfg =
      feeExt.state.newerTransferFee || feeExt.state.olderTransferFee;
    transferFeeBps = feeCfg ? Number(feeCfg.transferFeeBasisPoints) : 0;
  }
  return {
    program: value.owner === PROGRAMS.TOKEN22 ? "Token-2022" : "SPL Token",
    programId: value.owner,
    decimals: info.decimals,
    supplyRaw: info.supply,
    supply: Number(info.supply) / Math.pow(10, info.decimals),
    mintAuthority: info.mintAuthority || null,
    freezeAuthority: info.freezeAuthority || null,
    transferFeeBps: feeExt ? transferFeeBps : null,
    transferFeeAuthority:
      feeExt && feeExt.state
        ? feeExt.state.transferFeeConfigAuthority || null
        : null,
    md:
      mdExt && mdExt.state
        ? {
            name: mdExt.state.name || "",
            symbol: mdExt.state.symbol || "",
            uri: mdExt.state.uri || "",
            updateAuthority: mdExt.state.updateAuthority || null,
          }
        : null,
  };
}

function readTx(tx, mint) {
  if (
    !tx ||
    !tx.meta ||
    tx.meta.err ||
    !tx.transaction ||
    !tx.transaction.message
  )
    return null;
  const ak = tx.transaction.message.accountKeys || [];
  const keys = ak.map((k) => (typeof k === "string" ? k : k.pubkey));
  const signers = ak
    .filter((k) => typeof k !== "string" && k.signer)
    .map((k) => k.pubkey);
  const progs = new Set();
  const topIxs = tx.transaction.message.instructions || [];
  const innerIxs = (tx.meta.innerInstructions || []).flatMap(
    (g) => g.instructions || [],
  );
  for (const ix of [...topIxs, ...innerIxs]) {
    if (ix.programId) progs.add(ix.programId);
  }

  const bal = Object.create(null);
  let decimals = 6;
  const accum = (list, sign) => {
    for (const b of list || []) {
      if (b.mint !== mint || !b.owner) continue;
      decimals = b.uiTokenAmount.decimals;
      bal[b.owner] =
        (bal[b.owner] || 0) + sign * Number(b.uiTokenAmount.amount);
    }
  };
  accum(tx.meta.preTokenBalances, -1);
  accum(tx.meta.postTokenBalances, 1);

  const delta = Object.create(null);
  for (const owner of Object.keys(bal)) {
    if (bal[owner]) delta[owner] = bal[owner] / Math.pow(10, decimals);
  }

  const sol = Object.create(null);
  keys.forEach((key, idx) => {
    const d =
      ((tx.meta.postBalances[idx] || 0) - (tx.meta.preBalances[idx] || 0)) /
      1e9;
    if (d) sol[key] = d;
  });

  const wsol = Object.create(null);
  for (const b of tx.meta.preTokenBalances || []) {
    if (b.mint === WSOL && b.owner)
      wsol[b.owner] = (wsol[b.owner] || 0) - Number(b.uiTokenAmount.amount);
  }
  for (const b of tx.meta.postTokenBalances || []) {
    if (b.mint === WSOL && b.owner)
      wsol[b.owner] = (wsol[b.owner] || 0) + Number(b.uiTokenAmount.amount);
  }
  for (const owner of Object.keys(wsol)) {
    if (wsol[owner]) sol[owner] = (sol[owner] || 0) + wsol[owner] / 1e9;
  }

  const jitoTip = keys.some((k) => JITO_TIP_ACCOUNTS.has(k));
  const swap = [...progs].some((p) => SWAP_PROGRAMS.has(p));
  const logs = tx.meta.logMessages || [];

  // Extract direct system SOL transfers (for funding-source detection)
  const solTransfers = [];
  for (const ix of [...topIxs, ...innerIxs]) {
    if (
      ix.programId === PROGRAMS.SYSTEM &&
      ix.parsed &&
      ix.parsed.type === "transfer" &&
      ix.parsed.info
    ) {
      const info = ix.parsed.info;
      solTransfers.push({
        from: info.source,
        to: info.destination,
        sol: (Number(info.lamports) || 0) / 1e9,
      });
    }
  }

  return {
    sig: tx.transaction.signatures[0],
    slot: tx.slot,
    time: (tx.blockTime || 0) * 1000,
    feePayer: keys[0],
    signers,
    delta,
    sol,
    solTransfers,
    progs,
    swap,
    jitoTip,
    burn: logs.some((l) => /Instruction: Burn/i.test(l)),
  };
}

function createSigner(raw, mint, bc) {
  if (
    !raw ||
    !raw.meta ||
    raw.meta.err ||
    !raw.transaction ||
    !raw.transaction.message
  )
    return null;
  const ak = raw.transaction.message.accountKeys || [];
  const keys = ak.map((k) => (typeof k === "string" ? k : k.pubkey));
  const signers = ak
    .filter((k) => typeof k !== "string" && k.signer)
    .map((k) => k.pubkey)
    .filter((k) => k !== mint);
  const ixs = (raw.transaction.message.instructions || []).concat(
    ...(raw.meta.innerInstructions || []).map((g) => g.instructions || []),
  );
  const createIx = ixs.find(
    (ix) =>
      ix.programId === PROGRAMS.PUMP &&
      Array.isArray(ix.accounts) &&
      ix.accounts.includes(mint) &&
      ix.accounts.includes(bc),
  );
  if (!createIx) return null;
  const inIx = signers.filter((s) => createIx.accounts.includes(s));
  if (!inIx.length) return null;
  return inIx.includes(keys[0]) ? keys[0] : inIx[0];
}

module.exports = {
  PROGRAMS,
  WSOL,
  USDC,
  USDT,
  BURN,
  DEFAULT_PK,
  MAYHEM_VAULT,
  NON_OPERATOR_FUNDERS,
  JITO_TIP_ACCOUNTS,
  INFRA_PROGRAMS,
  INFRA_ADDR,
  SWAP_PROGRAMS,
  BONDING_CURVE_DISC,
  bondingCurve,
  metadataPda,
  pumpSwapPool,
  decodeCurve,
  decodeMetaplex,
  parseMint,
  readTx,
  createSigner,
};
