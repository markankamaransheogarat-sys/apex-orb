"use strict";

/*
 * Multi-endpoint Solana JSON-RPC client with automatic endpoint rotation,
 * rate-limit backoff, TTL response caching, and per-scan RPC call budget accounting.
 */

const { RPC_ENDPOINTS } = require("../config");
const { TTLCache, sleep } = require("./util");

class RpcBudgetError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "RpcBudgetError";
  }
}

class SolanaRpcPool {
  constructor(endpoints = RPC_ENDPOINTS) {
    this.endpoints = endpoints.length
      ? endpoints
      : ["https://api.mainnet-beta.solana.com"];
    this.cursor = 0;
    this.cache = new TTLCache(25_000, 4000);
    this.cooldownUntil = new Map();
  }

  _nextEndpoint() {
    const now = Date.now();
    for (let i = 0; i < this.endpoints.length; i++) {
      const idx = (this.cursor + i) % this.endpoints.length;
      const url = this.endpoints[idx];
      if ((this.cooldownUntil.get(url) || 0) <= now) {
        this.cursor = (idx + 1) % this.endpoints.length;
        return url;
      }
    }
    const url = this.endpoints[this.cursor % this.endpoints.length];
    this.cursor = (this.cursor + 1) % this.endpoints.length;
    return url;
  }

  async call(method, params, opts = {}) {
    const cacheKey = opts.cacheMs
      ? `${method}:${JSON.stringify(params)}`
      : null;
    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit !== undefined) return hit;
    }

    if (opts.budget) {
      if (opts.budget.used >= opts.budget.max) {
        throw new RpcBudgetError(
          `RPC budget exhausted (${opts.budget.used}/${opts.budget.max})`,
        );
      }
      opts.budget.used += 1;
    }

    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    let lastErr = null;

    for (
      let attempt = 0;
      attempt < Math.max(2, this.endpoints.length * 2);
      attempt++
    ) {
      const url = this._nextEndpoint();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 9000);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: ctrl.signal,
        });
        clearTimeout(timer);

        if (res.status === 429 || res.status >= 500) {
          this.cooldownUntil.set(url, Date.now() + 3000 * (attempt + 1));
          lastErr = new Error(`RPC HTTP ${res.status} from ${url}`);
          await sleep(160 * (attempt + 1));
          continue;
        }

        const json = await res.json();
        if (json.error) {
          const msg = json.error.message || JSON.stringify(json.error);
          if (/429|rate|limit|too many/i.test(msg)) {
            this.cooldownUntil.set(url, Date.now() + 4000);
            lastErr = new Error(msg);
            await sleep(200 * (attempt + 1));
            continue;
          }
          throw new Error(`RPC error (${method}): ${msg}`);
        }

        if (cacheKey) this.cache.set(cacheKey, json.result, opts.cacheMs);
        return json.result;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        await sleep(120 * (attempt + 1));
      }
    }

    throw lastErr || new Error(`RPC failed for ${method}`);
  }

  getAccountInfo(pubkey, encoding = "base64", opts = {}) {
    return this.call("getAccountInfo", [pubkey, { encoding }], {
      cacheMs: 15_000,
      ...opts,
    });
  }

  getMultipleAccounts(pubkeys, encoding = "jsonParsed", opts = {}) {
    if (!pubkeys.length) return Promise.resolve({ value: [] });
    return this.call("getMultipleAccounts", [pubkeys, { encoding }], {
      cacheMs: 15_000,
      ...opts,
    });
  }

  getTokenSupply(mint, opts = {}) {
    return this.call("getTokenSupply", [mint], { cacheMs: 20_000, ...opts });
  }

  getTokenLargestAccounts(mint, opts = {}) {
    return this.call("getTokenLargestAccounts", [mint], {
      cacheMs: 15_000,
      ...opts,
    });
  }

  getSignaturesForAddress(address, limit = 20, opts = {}) {
    return this.call("getSignaturesForAddress", [address, { limit }], {
      cacheMs: 20_000,
      ...opts,
    });
  }

  getTransaction(sig, opts = {}) {
    return this.call(
      "getTransaction",
      [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
      { cacheMs: 120_000, ...opts },
    );
  }

  getProgramAccounts(programId, filters, dataSlice = null, opts = {}) {
    const cfg = { encoding: "base64", filters };
    if (dataSlice) cfg.dataSlice = dataSlice;
    return this.call("getProgramAccounts", [programId, cfg], {
      cacheMs: 60_000,
      ...opts,
    });
  }
}

module.exports = { SolanaRpcPool, RpcBudgetError };
