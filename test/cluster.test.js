"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { NON_OPERATOR_FUNDERS } = require("../src/solana/layout");
const { buildHolderLinks, clusterOperators } = require("../src/engine/cluster");

test("clusterOperators merges same_funder and transitive transfers while ignoring CEX hot wallets", () => {
  const binanceHot = [...NON_OPERATOR_FUNDERS][0];
  const privateFunder = "PrivateFunderWallet111111111111111111111111";

  const holders = [
    {
      owner: "W0",
      share: 0.12,
      fundingRoot: privateFunder,
      entrySig: "sigA",
      entrySlot: 100,
      virgin: false,
      transferPeers: ["W2"],
    },
    {
      owner: "W1",
      share: 0.11,
      fundingRoot: privateFunder,
      entrySig: "sigB",
      entrySlot: 105,
      virgin: false,
      transferPeers: [],
    },
    {
      owner: "W2",
      share: 0.08,
      fundingRoot: binanceHot,
      entrySig: "sigC",
      entrySlot: 110,
      virgin: false,
      transferPeers: [],
    },
    {
      owner: "W3",
      share: 0.07,
      fundingRoot: binanceHot,
      entrySig: "sigD",
      entrySlot: 120,
      virgin: false,
      transferPeers: [],
    },
  ];

  const links = buildHolderLinks(holders, { launchSlot: 90 });
  const ops = clusterOperators(holders, links);

  // W0 + W1 (same_funder) + W2 (direct_transfer from W0) merge into OP-1; W3 stays independent (binanceHot ignored!)
  assert.equal(ops.length, 2);
  assert.equal(ops[0].id, "OP-1");
  assert.deepEqual(ops[0].wallets, [0, 1, 2]);
  assert.ok(Math.abs(ops[0].share - 0.31) < 1e-9);
  assert.deepEqual(ops[0].fundingRoots, [privateFunder]);

  assert.equal(ops[1].id, null);
  assert.deepEqual(ops[1].wallets, [3]);
});

test("behavioural pack detects 3+ fresh wallets within 5 slots and ±30% size and weights at 60%", () => {
  const holders = [
    {
      owner: "P0",
      share: 0.05,
      virgin: true,
      entrySlot: 500,
      entrySig: "s0",
      transferPeers: [],
    },
    {
      owner: "P1",
      share: 0.055,
      virgin: true,
      entrySlot: 502,
      entrySig: "s1",
      transferPeers: [],
    },
    {
      owner: "P2",
      share: 0.045,
      virgin: true,
      entrySlot: 504,
      entrySig: "s2",
      transferPeers: [],
    },
    {
      owner: "IND",
      share: 0.04,
      virgin: false,
      entrySlot: 700,
      entrySig: "s3",
      transferPeers: [],
    },
  ];

  const links = buildHolderLinks(holders, { launchSlot: 400 });
  const ops = clusterOperators(holders, links);

  const packOp = ops.find((o) => o.level === "pack");
  assert.ok(packOp);
  assert.deepEqual(packOp.wallets, [0, 1, 2]);
  assert.ok(Math.abs(packOp.share - 0.15) < 1e-9);
  assert.ok(Math.abs(packOp.weighted - 0.09) < 1e-9);
});
