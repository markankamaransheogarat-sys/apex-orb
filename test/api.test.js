"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../src/server");
const {
  PROGRAMS,
  BONDING_CURVE_DISC,
  bondingCurve,
} = require("../src/solana/layout");
const { b58decode, b58encode } = require("../src/solana/util");

function makeMockRpc(mint, holders) {
  const bcAddr = bondingCurve(mint);
  const curveBuf = Buffer.alloc(115);
  BONDING_CURVE_DISC.copy(curveBuf, 0);
  curveBuf.writeBigUInt64LE(1_000_000_000_000n, 8);
  curveBuf.writeBigUInt64LE(45_000_000_000n, 16);
  curveBuf.writeBigUInt64LE(500_000_000_000_000n, 24);
  curveBuf.writeBigUInt64LE(20_000_000_000n, 32);
  curveBuf.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  curveBuf[48] = 0;
  b58decode(holders[0].owner).copy(curveBuf, 49);

  return {
    endpoints: ["mock://rpc"],
    async getAccountInfo(addr) {
      if (addr === mint) {
        return {
          value: {
            owner: PROGRAMS.TOKEN,
            data: {
              parsed: {
                type: "mint",
                info: {
                  decimals: 6,
                  supply: "1000000000000000",
                  mintAuthority: null,
                  freezeAuthority: null,
                },
              },
            },
          },
        };
      }
      return { value: null };
    },
    async getMultipleAccounts(addrs) {
      if (addrs[0] === bcAddr) {
        return {
          value: [{ data: [curveBuf.toString("base64"), "base64"] }, null],
        };
      }
      if (addrs.every((a) => a.startsWith("TA_"))) {
        return {
          value: addrs.map((a, i) => ({
            owner: PROGRAMS.TOKEN,
            data: {
              parsed: { type: "account", info: { owner: holders[i].owner } },
            },
          })),
        };
      }
      return { value: addrs.map(() => ({ owner: PROGRAMS.SYSTEM })) };
    },
    async getTokenLargestAccounts() {
      return {
        value: holders.map((h, i) => ({
          address: `TA_${i}`,
          uiAmount: h.amount,
        })),
      };
    },
    async getSignaturesForAddress(addr) {
      if (addr === mint)
        return [{ signature: "CREATE_SIG", slot: 1000, blockTime: 1790000000 }];
      return [{ signature: `SIG_${addr}`, slot: 1005, blockTime: 1790000005 }];
    },
    async getTransaction(sig) {
      const owner = sig.startsWith("SIG_") ? sig.slice(4) : holders[0].owner;
      return {
        slot: sig === "CREATE_SIG" ? 1000 : 1005,
        blockTime: 1790000005,
        meta: {
          err: null,
          preBalances: [2_000_000_000, 0],
          postBalances: [1_900_000_000, 100_000_000],
          preTokenBalances: [],
          postTokenBalances: [
            {
              mint,
              owner,
              uiTokenAmount: { amount: "10000000000", decimals: 6 },
            },
          ],
          innerInstructions: [],
          logMessages: [],
        },
        transaction: {
          signatures: [sig],
          message: {
            accountKeys: [
              {
                pubkey: "CommonFunder111111111111111111111111111111",
                signer: true,
              },
              { pubkey: owner, signer: false },
            ],
            instructions: [
              { programId: PROGRAMS.PUMP, accounts: [mint, bcAddr] },
              {
                programId: PROGRAMS.SYSTEM,
                parsed: {
                  type: "transfer",
                  info: {
                    source: "CommonFunder111111111111111111111111111111",
                    destination: owner,
                    lamports: 100_000_000,
                  },
                },
              },
            ],
          },
        },
      };
    },
  };
}

test("HTTP API scans mocked token, updates Operator Memory and manages paper trades", async () => {
  const mint = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
  const holders = Array.from({ length: 12 }, (_, i) => ({
    owner: b58encode(Buffer.alloc(32, i + 10)),
    amount: 30_000_000 - i * 1_000_000,
  }));

  const app = createApp({
    dbPath: ":memory:",
    radar: null,
    rpc: makeMockRpc(mint, holders),
  });

  const addr = await app.start(0, "127.0.0.1");
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const hRes = await fetch(`${base}/api/health`).then((r) => r.json());
    assert.equal(hRes.ok, true);

    const badRes = await fetch(`${base}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mint: "invalid" }),
    });
    assert.equal(badRes.status, 400);

    const scanRes = await fetch(`${base}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mint }),
    }).then((r) => r.json());

    assert.equal(scanRes.mint, mint);
    assert.ok(scanRes.operators.length >= 1);
    assert.equal(typeof scanRes.safety.score, "number");
    assert.equal(typeof scanRes.alpha.score, "number");

    const memRes = await fetch(`${base}/api/memory`).then((r) => r.json());
    assert.ok(memRes.operators.length >= 1);

    const openPaper = await fetch(`${base}/api/paper/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mint,
        symbol: "MOCK",
        priceUsd: 0.001,
        sizeUsd: 250,
      }),
    }).then((r) => r.json());
    assert.equal(openPaper.trade.status, "OPEN");

    const closePaper = await fetch(`${base}/api/paper/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: openPaper.trade.id }),
    }).then((r) => r.json());
    assert.equal(closePaper.ok, true);
    assert.equal(closePaper.trades[0].status, "CLOSED");
  } finally {
    await app.stop();
  }
});
