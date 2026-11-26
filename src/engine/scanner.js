"use strict";

/*
 * Full On-Chain Solana Token Scanner Orchestrator:
 *   1. Reads Mint (SPL / Token-2022), BondingCurve PDA, Metaplex PDA, and Market Pools
 *   2. Resolves Top-20 real float holders (excluding curves, DEX pools, lockers, burn)
 *   3. Traces holder history, buy-vs-transfer, Jito/slot-0 bundles, and SOL funding roots
 *   4. Clusters holders into Operators and checks SQLite Operator Memory
 *   5. Computes Dual-Axis Verdict (Safety 0-100 x Alpha 0-100) + Exit Simulator graph
 */

const { BUDGET, LIMITS } = require("../config");
const { isAddress, clamp } = require("../solana/util");
const {
  PROGRAMS,
  INFRA_PROGRAMS,
  INFRA_ADDR,
  NON_OPERATOR_FUNDERS,
  bondingCurve,
  metadataPda,
  decodeCurve,
  decodeMetaplex,
  parseMint,
  readTx,
  createSigner,
} = require("../solana/layout");
const { fetchMarketSnapshot } = require("./market");
const { buildHolderLinks, clusterOperators } = require("./cluster");
const {
  evaluateGuard,
  scoreSafety,
  scoreAlphaAndMicrostructure,
} = require("./scoring");

async function mapLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

async function scanToken(mint, { rpc, db, onTrace } = {}) {
  if (!isAddress(mint)) {
    throw new Error("Invalid Solana mint address");
  }

  const startedAt = Date.now();
  const trace = [];
  const budget = { used: 0, max: BUDGET.maxRpcCallsPerScan };

  const logStep = (msg, level = "info") => {
    const entry = { t: Date.now() - startedAt, level, msg };
    trace.push(entry);
    if (onTrace) onTrace(entry);
  };

  const bcAddr = bondingCurve(mint);
  const mdAddr = metadataPda(mint);
  logStep(
    `Derived PDAs: curve=${bcAddr.slice(0, 6)}… meta=${mdAddr.slice(0, 6)}…`,
  );

  // Step 1: Parallel fetch of mint account, curve/metadata PDAs, largest token accounts, and market pools
  const [mintAccRes, pdaRes, largestRes, mktBase] = await Promise.all([
    rpc
      .getAccountInfo(mint, "jsonParsed", { budget })
      .catch((e) => ({ error: e.message })),
    rpc
      .getMultipleAccounts([bcAddr, mdAddr], "base64", { budget })
      .catch(() => ({ value: [] })),
    rpc
      .getTokenLargestAccounts(mint, { budget })
      .catch((e) => ({ error: e.message })),
    fetchMarketSnapshot(mint, {
      supply: LIMITS.totalPumpSupply,
      fixedSupply: true,
    }).catch(() => null),
  ]);

  const mintInfo =
    mintAccRes && mintAccRes.value ? parseMint(mintAccRes.value) : null;
  if (!mintInfo) {
    throw new Error("Mint account not found or unreadable on Solana");
  }

  const pdaValues = (pdaRes && pdaRes.value) || [];
  const curveBuf =
    pdaValues[0] && pdaValues[0].data && pdaValues[0].data[0]
      ? Buffer.from(pdaValues[0].data[0], "base64")
      : null;
  const metaBuf =
    pdaValues[1] && pdaValues[1].data && pdaValues[1].data[0]
      ? Buffer.from(pdaValues[1].data[0], "base64")
      : null;

  const curve = decodeCurve(curveBuf);
  const meta = metaBuf ? decodeMetaplex(metaBuf) : null;
  const totalSupply = mintInfo.supply || LIMITS.totalPumpSupply;
  const fixedSupply = !mintInfo.mintAuthority;

  const symbol =
    (mktBase && mktBase.symbol) ||
    (meta && meta.symbol) ||
    (mintInfo.md && mintInfo.md.symbol) ||
    "TOKEN";
  const name =
    (mktBase && mktBase.name) ||
    (meta && meta.name) ||
    (mintInfo.md && mintInfo.md.name) ||
    symbol;

  logStep(
    `Mint decoded: $${symbol} (${mintInfo.program}) · supply ${Math.round(totalSupply).toLocaleString()}`,
  );
  if (curve) {
    logStep(
      `Pump.fun curve: complete=${curve.complete} · vSol=${curve.vSol.toFixed(2)} · creator=${curve.creator ? curve.creator.slice(0, 6) + "…" : "none"}`,
    );
  }

  // Enrich market snapshot if pre-migration on bonding curve
  const market = mktBase || { pools: [], pickedPool: null, solUsd: 150 };
  if (
    curve &&
    !curve.complete &&
    (!market.liquidityUsd || market.liquidityUsd === 0)
  ) {
    const curvePriceSol = curve.vTokens > 0 ? curve.vSol / curve.vTokens : 0;
    const solUsd = market.solUsd || 150;
    const priceUsd = curvePriceSol * solUsd;
    market.priceUsd = market.priceUsd || priceUsd;
    market.liquidityUsd = curve.vSol * 2 * solUsd;
    market.mcap = fixedSupply ? priceUsd * totalSupply : market.mcap;
    market.fdv = priceUsd * totalSupply;
  }

  // Check TOO ESTABLISHED early exit
  if (
    market.ageDays != null &&
    market.ageDays > LIMITS.establishedDays &&
    market.liquidityUsd > LIMITS.establishedLiq &&
    (market.mcap || market.fdv || 0) > LIMITS.establishedMcap
  ) {
    logStep(
      "Token classified as TOO ESTABLISHED (age >30d, liq >$500K, MC >$10M)",
      "warn",
    );
  }

  // Step 2: Resolve largest token accounts -> owners -> filter infrastructure
  const rawLargest = (largestRes && largestRes.value) || [];
  const tokenAccountAddrs = rawLargest.map((a) => a.address).filter(Boolean);
  const accDetails = tokenAccountAddrs.length
    ? await rpc
        .getMultipleAccounts(tokenAccountAddrs, "jsonParsed", { budget })
        .catch(() => ({ value: [] }))
    : { value: [] };

  const ownerBalances = new Map();
  let infraTokens = 0;

  (accDetails.value || []).forEach((acc, idx) => {
    const entry = rawLargest[idx];
    const uiAmount = entry ? Number(entry.uiAmount || 0) : 0;
    if (!acc || !acc.data || !acc.data.parsed || uiAmount <= 0) return;
    const owner = acc.data.parsed.info && acc.data.parsed.info.owner;
    if (!owner) return;

    const isInfraAddr =
      Boolean(INFRA_ADDR[owner]) ||
      owner === bcAddr ||
      (market.pickedPool && owner === market.pickedPool.pool);
    const isInfraProg = Boolean(INFRA_PROGRAMS[acc.owner]);
    if (isInfraAddr || isInfraProg) {
      infraTokens += uiAmount;
      return;
    }
    ownerBalances.set(owner, (ownerBalances.get(owner) || 0) + uiAmount);
  });

  // Check if owners themselves are PDA / program-owned pools
  const candidateOwners = [...ownerBalances.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, BUDGET.maxHoldersToInspect);

  if (candidateOwners.length) {
    const ownerAccRes = await rpc
      .getMultipleAccounts(
        candidateOwners.map((x) => x[0]),
        "base64",
        { budget },
      )
      .catch(() => ({ value: [] }));
    (ownerAccRes.value || []).forEach((acc, idx) => {
      if (!acc) return;
      const [owner, amt] = candidateOwners[idx];
      if (INFRA_PROGRAMS[acc.owner]) {
        infraTokens += amt;
        ownerBalances.delete(owner);
      }
    });
  }

  const floatTokens = Math.max(1, totalSupply - infraTokens);
  const sortedHolders = [...ownerBalances.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, BUDGET.maxHoldersToInspect)
    .map(([owner, tokens], i) => ({
      i,
      owner,
      tokens,
      share: clamp(tokens / floatTokens, 0, 1),
      kind: "buy",
      virgin: false,
      unread: false,
      sniper: false,
      bundle: false,
      jitoTip: false,
      dev: Boolean(curve && curve.creator && owner === curve.creator),
      sold: false,
      entrySlot: null,
      entrySig: null,
      fundingRoot: null,
      txCount: null,
      transferPeers: [],
      op: null,
    }));

  logStep(
    `Float resolved: ${sortedHolders.length} real holders · ${((floatTokens / totalSupply) * 100).toFixed(1)}% of supply outside pools`,
  );

  // Step 3: Inspect mint earliest signatures for launch slot & creator verification
  let launchSlot = null;
  let launchTimeMs = market.createdAt || null;
  let creator = (curve && curve.creator) || null;
  let slot0Share = null;

  try {
    const mintSigs = await rpc.getSignaturesForAddress(mint, 20, { budget });
    if (Array.isArray(mintSigs) && mintSigs.length) {
      const oldest = mintSigs[mintSigs.length - 1];
      launchSlot = oldest.slot || null;
      if (oldest.blockTime) launchTimeMs = oldest.blockTime * 1000;

      const createRaw = await rpc
        .getTransaction(oldest.signature, { budget })
        .catch(() => null);
      if (createRaw) {
        const signer = createSigner(createRaw, mint, bcAddr);
        if (signer) creator = signer;
        const parsedCreate = readTx(createRaw, mint);
        if (parsedCreate) {
          let slot0Bought = 0;
          for (const [acct, d] of Object.entries(parsedCreate.delta)) {
            if (acct !== bcAddr && d > 0) slot0Bought += d;
          }
          slot0Share = clamp(slot0Bought / totalSupply, 0, 1);
        }
      }
    }
  } catch (e) {
    logStep(`Launch-slot lookup limited: ${e.message}`, "warn");
  }

  if (creator) {
    for (const h of sortedHolders) {
      if (h.owner === creator) h.dev = true;
    }
  }

  // Step 4: Deep wallet forensics under RPC budget
  const holdersToRead = sortedHolders
    .filter((h) => h.share >= BUDGET.deepMinShare)
    .slice(0, 14);
  logStep(
    `Running deep wallet forensics on ${holdersToRead.length} holders (≥0.2% float)…`,
  );

  await mapLimit(holdersToRead, BUDGET.rpcConcurrency, async (holder) => {
    if (
      Date.now() - startedAt > BUDGET.scanTimeoutMs ||
      budget.used >= budget.max - 2
    ) {
      holder.unread = true;
      return;
    }

    try {
      const sigs = await rpc.getSignaturesForAddress(
        holder.owner,
        BUDGET.holderHistoryLimit,
        { budget },
      );
      if (!Array.isArray(sigs) || !sigs.length) {
        holder.unread = true;
        return;
      }

      holder.txCount = sigs.length;
      holder.virgin = sigs.length <= 4;

      // Inspect up to 2 key transactions: newest (for token acquisition) and oldest (for SOL funding root)
      const newestSig = sigs[0].signature;
      const oldestSig = sigs[sigs.length - 1].signature;
      const sigsToFetch =
        newestSig === oldestSig ? [newestSig] : [newestSig, oldestSig];

      for (const sig of sigsToFetch) {
        if (budget.used >= budget.max) break;
        const rawTx = await rpc
          .getTransaction(sig, { budget })
          .catch(() => null);
        if (!rawTx) continue;
        const parsed = readTx(rawTx, mint);
        if (!parsed) continue;

        const tokDelta = parsed.delta[holder.owner] || 0;
        const solDelta = parsed.sol[holder.owner] || 0;

        if (tokDelta > 0 && !holder.entrySig) {
          holder.entrySig = parsed.sig;
          holder.entrySlot = parsed.slot;
          holder.jitoTip = parsed.jitoTip;

          if (!parsed.swap && Math.abs(solDelta) < 0.002) {
            holder.kind = "transfer";
            for (const [peer, d] of Object.entries(parsed.delta)) {
              if (peer !== holder.owner && d < 0)
                holder.transferPeers.push(peer);
            }
          } else {
            holder.kind = "buy";
          }

          if (launchSlot != null && parsed.slot <= launchSlot + 75) {
            holder.sniper = true;
          }
          if (launchSlot != null && parsed.slot === launchSlot) {
            holder.bundle = true;
          }
        }

        // SOL funding root detection (who funded this holder wallet?)
        if (!holder.fundingRoot) {
          const directFund = parsed.solTransfers.find(
            (t) =>
              t.to === holder.owner && t.from !== holder.owner && t.sol >= 0.01,
          );
          if (directFund && !NON_OPERATOR_FUNDERS.has(directFund.from)) {
            holder.fundingRoot = directFund.from;
          } else if (
            parsed.feePayer &&
            parsed.feePayer !== holder.owner &&
            !NON_OPERATOR_FUNDERS.has(parsed.feePayer)
          ) {
            holder.fundingRoot = parsed.feePayer;
          }
        }
      }
    } catch {
      holder.unread = true;
    }
  });

  // Step 5: Cluster links -> Operators
  const links = buildHolderLinks(sortedHolders, { launchSlot });
  const operators = clusterOperators(sortedHolders, links);
  const multiOps = operators.filter((o) => o.wallets.length > 1);

  logStep(
    `Clustered into ${operators.length} operators (${multiOps.length} multi-wallet groups, ${links.length} proven/pack links)`,
  );

  // Step 6: Cross-token Operator & Creator Memory check
  const allRoots = [...new Set(operators.flatMap((o) => o.fundingRoots || []))];
  const memRoots = db ? db.getOperatorMemory(allRoots) : [];
  const recidivistRoots = memRoots.filter((r) => r.danger_tokens >= 1);
  const creatorMem = db && creator ? db.getCreatorMemory(creator) : null;

  if (recidivistRoots.length) {
    logStep(
      `ALERT: Operator Memory hit on ${recidivistRoots.length} funding root(s)!`,
      "danger",
    );
  }

  // Step 7: Dual-Axis Scoring (Safety + Alpha/Microstructure + Guard)
  const reserveTokens =
    curve && !curve.complete
      ? curve.vTokens
      : (market.pickedPool && market.pickedPool.liqBase) ||
        Math.max(
          1,
          (market.liquidityUsd || 0) /
            2 /
            Math.max(1e-9, market.priceUsd || 0.0001),
        );

  const unreadCount = sortedHolders.filter(
    (h) => h.unread && h.share >= BUDGET.deepMinShare,
  ).length;
  const safety = scoreSafety(sortedHolders, operators, {
    floatTokens,
    reserveTokens,
    liquidityUsd: market.liquidityUsd ?? null,
    unread: unreadCount,
    recidivistRoots,
  });

  const devHolder = sortedHolders.find((h) => h.dev);
  const devShareNow = devHolder ? devHolder.share : creator ? 0 : null;

  const guard = evaluateGuard({
    creator,
    history: creatorMem
      ? {
          launched: creatorMem.seen_launches,
          graduated: creatorMem.clean_count,
        }
      : { unavailable: true },
    slot0Share,
    devShare: devShareNow,
    ownerPowers: mintInfo,
    creatorMem,
  });

  const alpha = scoreAlphaAndMicrostructure({
    market,
    curve,
    holders: sortedHolders,
    operators,
    safety,
  });

  logStep(
    `Verdict: SAFETY ${safety.score}/100 (${safety.band}) · ALPHA ${alpha.score}/100 · Quadrant ${alpha.matrix.quadrant} (${budget.used} RPC calls, ${Date.now() - startedAt}ms)`,
  );

  // Build interactive graph payload for frontend 3D/Canvas visualizer
  const graphNodes = sortedHolders.map((h) => ({
    id: `H${h.i}`,
    label: `${h.owner.slice(0, 4)}…${h.owner.slice(-4)}`,
    owner: h.owner,
    share: h.share,
    op: h.op,
    kind: h.kind,
    virgin: h.virgin,
    sniper: h.sniper,
    dev: h.dev,
    unread: h.unread,
    fundingRoot: h.fundingRoot,
  }));

  for (const root of allRoots) {
    graphNodes.push({
      id: `R:${root}`,
      label: `ROOT ${root.slice(0, 4)}…${root.slice(-4)}`,
      owner: root,
      isRoot: true,
      recidivist: recidivistRoots.some((r) => r.root_addr === root),
    });
  }

  const graphEdges = links.map((l) => ({
    source: `H${l.a}`,
    target: `H${l.b}`,
    kind: l.kind,
    level: l.level,
    detail: l.detail,
  }));

  for (const h of sortedHolders) {
    if (h.fundingRoot && allRoots.includes(h.fundingRoot)) {
      graphEdges.push({
        source: `R:${h.fundingRoot}`,
        target: `H${h.i}`,
        kind: "funded_by",
        level: "proven",
        detail: "SOL funding root",
      });
    }
  }

  const result = {
    mint,
    scannedAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    rpcCallsUsed: budget.used,
    token: {
      mint,
      name,
      symbol,
      program: mintInfo.program,
      supply: totalSupply,
      fixedSupply,
      mintAuthority: mintInfo.mintAuthority,
      freezeAuthority: mintInfo.freezeAuthority,
      transferFeeBps: mintInfo.transferFeeBps,
      mutableMetadata: meta ? meta.mutable : null,
    },
    curve,
    market,
    safety,
    alpha,
    matrix: alpha.matrix,
    guard,
    holders: sortedHolders,
    operators,
    links,
    memoryHits: {
      creator: creatorMem,
      operatorRoots: memRoots,
    },
    graph: {
      nodes: graphNodes,
      edges: graphEdges,
    },
    trace,
  };

  if (db) {
    db.recordScan(result);
  }

  return result;
}

module.exports = { scanToken };
