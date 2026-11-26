"use strict";

/*
 * Solana cryptographic & encoding primitives with zero dependencies:
 * Base58 codec, Ed25519 on-curve check, SHA-256 Program Derived Addresses (PDA),
 * little-endian integer/pubkey readers, and bounded TTL cache.
 */

const crypto = require("node:crypto");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
const sum = (arr, fn) =>
  arr.reduce((acc, item) => acc + (fn ? fn(item) : item), 0);

const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = Object.create(null);
for (let i = 0; i < B58_ALPHABET.length; i++)
  B58_MAP[B58_ALPHABET[i]] = BigInt(i);

function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

function b58decode(str) {
  if (typeof str !== "string" || !str.length)
    throw new Error("invalid base58 input");
  let n = 0n;
  for (const c of str) {
    const v = B58_MAP[c];
    if (v === undefined) throw new Error(`invalid base58 char: ${c}`);
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of str) {
    if (c === "1") bytes.unshift(0);
    else break;
  }
  return Buffer.from(bytes);
}

function isAddress(s) {
  if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s))
    return false;
  try {
    return b58decode(s).length === 32;
  } catch {
    return false;
  }
}

// Ed25519 field prime p = 2^255 - 19 and curve parameter d = -121665 / 121666 mod p
const ED_P = 2n ** 255n - 19n;

function mod(a) {
  const r = a % ED_P;
  return r < 0n ? r + ED_P : r;
}

function modPow(base, exp) {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % ED_P;
    b = (b * b) % ED_P;
    e >>= 1n;
  }
  return result;
}

function modInv(a) {
  return modPow(mod(a), ED_P - 2n);
}

const ED_D = mod(-121665n * modInv(121666n));

function isOnCurve(bytes) {
  const b = Buffer.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) + BigInt(b[i]);
  if (y >= ED_P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(ED_D * y2 + 1n);
  if (v === 0n) return u === 0n;
  const x2 = mod(u * modInv(v));
  if (x2 === 0n) return true;
  return modPow(x2, (ED_P - 1n) / 2n) === 1n;
}

function sha256(...parts) {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

function seedBuf(s) {
  if (Buffer.isBuffer(s)) return s;
  if (typeof s === "string" && isAddress(s) && s.length >= 32)
    return b58decode(s);
  return Buffer.from(s);
}

function findPda(seeds, programId) {
  const prog = b58decode(programId);
  const sb = seeds.map(seedBuf);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(
      ...sb,
      Buffer.from([bump]),
      prog,
      Buffer.from("ProgramDerivedAddress"),
    );
    if (!isOnCurve(h)) return b58encode(h);
  }
  throw new Error("PDA derivation failed");
}

const u64 = (buf, off) => Number(buf.readBigUInt64LE(off));
const i64 = (buf, off) => Number(buf.readBigInt64LE(off));
const pk = (buf, off) => b58encode(buf.subarray(off, off + 32));

class TTLCache {
  constructor(ttlMs = 60000, maxEntries = 5000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  async wrap(key, fn, ttlMs = this.ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const inflightKey = `\u0000${key}`;
    const inflight = this.map.get(inflightKey);
    if (inflight) return inflight.value;
    const promise = Promise.resolve()
      .then(fn)
      .then((val) => {
        this.map.delete(inflightKey);
        if (val !== undefined) this.set(key, val, ttlMs);
        return val;
      })
      .catch((err) => {
        this.map.delete(inflightKey);
        throw err;
      });
    this.map.set(inflightKey, {
      value: promise,
      expiresAt: Date.now() + 60000,
    });
    return promise;
  }
}

module.exports = {
  sleep,
  clamp,
  sum,
  b58encode,
  b58decode,
  isAddress,
  isOnCurve,
  findPda,
  sha256,
  u64,
  i64,
  pk,
  TTLCache,
};
