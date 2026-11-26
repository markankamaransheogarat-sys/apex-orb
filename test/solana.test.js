"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  b58encode,
  b58decode,
  isAddress,
  isOnCurve,
} = require("../src/solana/util");
const {
  PROGRAMS,
  USDC,
  BONDING_CURVE_DISC,
  bondingCurve,
  decodeCurve,
  parseMint,
} = require("../src/solana/layout");

test("base58 roundtrip and address validation", () => {
  const raw = b58decode(PROGRAMS.PUMP);
  assert.equal(raw.length, 32);
  assert.equal(b58encode(raw), PROGRAMS.PUMP);
  assert.equal(isAddress(PROGRAMS.PUMP), true);
  assert.equal(isAddress("not-a-valid-address!"), false);
  assert.equal(isAddress("1111"), false);
});

test("bondingCurve PDA is valid and never lies on ed25519 curve", () => {
  const mint = "So11111111111111111111111111111111111111112";
  const pda = bondingCurve(mint);
  assert.equal(isAddress(pda), true);
  assert.equal(isOnCurve(b58decode(pda)), false);
});

test("decodeCurve decodes SOL and USDC-quoted bonding curves", () => {
  const buf = Buffer.alloc(115);
  BONDING_CURVE_DISC.copy(buf, 0);
  buf.writeBigUInt64LE(1_000_000_000_000n, 8); // 1M vTokens
  buf.writeBigUInt64LE(30_000_000_000n, 16); // 30 vSOL (9 decimals)
  buf.writeBigUInt64LE(793_100_000_000_000n, 24);
  buf.writeBigUInt64LE(5_000_000_000n, 32);
  buf.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  buf[48] = 0; // not complete
  b58decode(PROGRAMS.SYSTEM).copy(buf, 49);
  buf[81] = 0;
  b58decode(PROGRAMS.SYSTEM).copy(buf, 83);

  const solCurve = decodeCurve(buf);
  assert.equal(solCurve.vTokens, 1_000_000);
  assert.equal(solCurve.vSol, 30);
  assert.equal(solCurve.complete, false);
  assert.equal(solCurve.quoteMint, null);

  // Now quote in USDC (6 decimals)
  b58decode(USDC).copy(buf, 83);
  buf.writeBigUInt64LE(5_000_000_000n, 16); // 5,000 USDC
  const usdcCurve = decodeCurve(buf);
  assert.equal(usdcCurve.vSol, 5000);
  assert.equal(usdcCurve.quoteMint, USDC);
});

test("parseMint handles Token-2022 transferFeeConfig", () => {
  const parsed = parseMint({
    owner: PROGRAMS.TOKEN22,
    data: {
      parsed: {
        type: "mint",
        info: {
          decimals: 6,
          supply: "1000000000000",
          mintAuthority: null,
          freezeAuthority: null,
          extensions: [
            {
              extension: "transferFeeConfig",
              state: { newerTransferFee: { transferFeeBasisPoints: 250 } },
            },
          ],
        },
      },
    },
  });
  assert.equal(parsed.program, "Token-2022");
  assert.equal(parsed.supply, 1_000_000);
  assert.equal(parsed.transferFeeBps, 250);
  assert.equal(parsed.mintAuthority, null);
});
