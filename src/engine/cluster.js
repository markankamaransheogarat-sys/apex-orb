"use strict";

/*
 * Wallet-Graph Forensics & Operator Clustering Engine (the "closed" core built in full):
 *   - Discovers links between top token holders:
 *       1. same_tx (proven): bought or received in the exact same transaction signature
 *       2. same_funder (proven): funded with SOL by the same non-CEX/non-bridge wallet
 *       3. direct_transfer (proven): direct token transfer between two holders
 *       4. slot0_bundle (proven): both entered in the token creation slot (or Jito-bundled same slot)
 *       5. pack (behavioural, 60% weight): 3+ fresh wallets entering within 5 slots & ±30% size
 *   - Union-Find merges proven clusters into Operators and tracks fundingRoots for Operator Memory.
 */

const { sum } = require("../solana/util");
const { NON_OPERATOR_FUNDERS } = require("../solana/layout");

function buildHolderLinks(holders, opts = {}) {
  const links = [];
  const seenLink = new Set();
  const launchSlot = opts.launchSlot || null;

  const pushLink = (a, b, kind, level, detail) => {
    if (a === b) return;
    const x = Math.min(a, b);
    const y = Math.max(a, b);
    const key = `${x}:${y}:${kind}`;
    if (seenLink.has(key)) return;
    seenLink.add(key);
    links.push({ a: x, b: y, kind, level, detail: detail || kind });
  };

  // 1. Same entry transaction signature
  const bySig = new Map();
  holders.forEach((h, idx) => {
    if (!h.entrySig) return;
    if (!bySig.has(h.entrySig)) bySig.set(h.entrySig, []);
    bySig.get(h.entrySig).push(idx);
  });
  for (const [sig, idxs] of bySig.entries()) {
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        pushLink(
          idxs[i],
          idxs[j],
          "same_tx",
          "proven",
          `same tx ${sig.slice(0, 8)}…`,
        );
      }
    }
  }

  // 2. Shared SOL funding root (excluding CEX/Jito/bridges)
  const byFunder = new Map();
  holders.forEach((h, idx) => {
    if (!h.fundingRoot || NON_OPERATOR_FUNDERS.has(h.fundingRoot)) return;
    if (!byFunder.has(h.fundingRoot)) byFunder.set(h.fundingRoot, []);
    byFunder.get(h.fundingRoot).push(idx);
  });
  for (const [funder, idxs] of byFunder.entries()) {
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        pushLink(
          idxs[i],
          idxs[j],
          "same_funder",
          "proven",
          `common funder ${funder.slice(0, 4)}…${funder.slice(-4)}`,
        );
      }
    }
  }

  // 3. Direct token transfers between top holders
  const idxByOwner = new Map();
  holders.forEach((h, idx) => idxByOwner.set(h.owner, idx));
  holders.forEach((h, idx) => {
    for (const peer of h.transferPeers || []) {
      const peerIdx = idxByOwner.get(peer);
      if (peerIdx != null && peerIdx !== idx) {
        pushLink(
          idx,
          peerIdx,
          "direct_transfer",
          "proven",
          "direct token transfer",
        );
      }
    }
  });

  // 4. Slot-0 / Jito same-slot bundles
  const byBundleSlot = new Map();
  holders.forEach((h, idx) => {
    if (!h.entrySlot) return;
    const isSlot0 = launchSlot != null && h.entrySlot === launchSlot;
    if (isSlot0 || h.jitoTip) {
      if (!byBundleSlot.has(h.entrySlot)) byBundleSlot.set(h.entrySlot, []);
      byBundleSlot.get(h.entrySlot).push(idx);
    }
  });
  for (const [slot, idxs] of byBundleSlot.entries()) {
    if (idxs.length < 2) continue;
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        pushLink(
          idxs[i],
          idxs[j],
          "slot_bundle",
          "proven",
          `coordinated slot #${slot}`,
        );
      }
    }
  }

  // 5. Behavioural "pack": 3+ fresh wallets entering within 5 slots & ±30% token share
  const freshIndices = holders
    .map((h, i) => ({ h, i }))
    .filter((x) => x.h.virgin && x.h.entrySlot && x.h.share > 0);

  for (let i = 0; i < freshIndices.length; i++) {
    const anchor = freshIndices[i];
    const peers = [anchor.i];
    for (let j = 0; j < freshIndices.length; j++) {
      if (i === j) continue;
      const cand = freshIndices[j];
      const slotGap = Math.abs(cand.h.entrySlot - anchor.h.entrySlot);
      const ratio = cand.h.share / anchor.h.share;
      if (slotGap <= 5 && ratio >= 0.7 && ratio <= 1.3) {
        peers.push(cand.i);
      }
    }
    if (peers.length >= 3) {
      for (let p = 1; p < peers.length; p++) {
        pushLink(
          peers[0],
          peers[p],
          "pack",
          "pack",
          "fresh wallet pack (±30% size, ≤5 slots)",
        );
      }
    }
  }

  return links;
}

function clusterOperators(holders, links) {
  const parent = holders.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));

  for (const l of links) {
    if (l.level === "proven") {
      parent[find(l.a)] = find(l.b);
    }
  }

  const groups = Object.create(null);
  holders.forEach((_, i) => {
    const root = find(i);
    if (!groups[root]) groups[root] = [];
    groups[root].push(i);
  });

  const rawOps = [];
  for (const g of Object.values(groups)) {
    if (g.length > 1) rawOps.push({ wallets: g, level: "proven" });
  }

  const inProven = new Set(rawOps.flatMap((o) => o.wallets));
  const packBuckets = Object.create(null);
  for (const l of links) {
    if (l.level !== "pack") continue;
    if (!packBuckets[l.a]) packBuckets[l.a] = new Set([l.a]);
    packBuckets[l.a].add(l.b);
  }
  for (const bucket of Object.values(packBuckets)) {
    const cleaned = [...bucket].filter((i) => !inProven.has(i));
    if (cleaned.length >= 2) {
      rawOps.push({ wallets: cleaned, level: "pack" });
      cleaned.forEach((i) => inProven.add(i));
    }
  }

  const assigned = new Set(rawOps.flatMap((o) => o.wallets));
  holders.forEach((_, i) => {
    if (!assigned.has(i)) rawOps.push({ wallets: [i], level: null });
  });

  for (const op of rawOps) {
    op.share = sum(op.wallets, (idx) => holders[idx].share);
    op.weighted = op.share * (op.level === "pack" ? 0.6 : 1.0);
    const roots = new Set();
    const kinds = new Set();
    for (const idx of op.wallets) {
      if (
        holders[idx].fundingRoot &&
        !NON_OPERATOR_FUNDERS.has(holders[idx].fundingRoot)
      ) {
        roots.add(holders[idx].fundingRoot);
      }
    }
    const walletSet = new Set(op.wallets);
    for (const l of links) {
      if (walletSet.has(l.a) && walletSet.has(l.b)) kinds.add(l.kind);
    }
    op.fundingRoots = [...roots];
    op.linkKinds = [...kinds];
  }

  rawOps.sort((a, b) => b.weighted - a.weighted);

  let opNum = 0;
  return rawOps.map((op) => {
    const id = op.wallets.length > 1 ? `OP-${++opNum}` : null;
    if (id) {
      for (const idx of op.wallets) holders[idx].op = id;
    }
    return {
      id,
      wallets: op.wallets.slice().sort((a, b) => a - b),
      share: op.share,
      weighted: op.weighted,
      level: op.wallets.length > 1 ? op.level : null,
      fundingRoots: op.fundingRoots,
      linkKinds: op.linkKinds,
    };
  });
}

module.exports = {
  buildHolderLinks,
  clusterOperators,
};
