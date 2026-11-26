# ApexOrb — Solana On-Chain Forensics, Microstructure & Alpha Terminal

**ApexOrb** is a zero-dependency full-stack Solana memecoin scanner, wallet-cluster forensics engine, and paper-trading terminal built purely on Node.js 22+ built-ins (`node:http`, `node:sqlite`, `node:crypto`, native `WebSocket` & `fetch`).

Unlike public rule-only repositories (such as `QuantumOrb/QuantOrb`, which open-sources ~10% of its scoring formulas while keeping wallet linking, RPC traversal, and launch streams closed), **ApexOrb implements the entire end-to-end stack** — and augments it with quantitative microstructure gates inspired by institutional perp trading systems.

## Key Features

1. **Full Closed-Loop Wallet Graph Engine ([`src/engine/cluster.js`](src/engine/cluster.js)):**
   - Resolves Top-20 real float holders (filtering out bonding curves, PumpSwap/Raydium/Meteora/Orca pools, lockers, and burn addresses).
   - Traces entry transactions, buy-vs-transfer origin, Jito/slot-0 bundles, and **SOL funding roots** (while excluding CEX hot wallets & Jito tip accounts).
   - Merges proven links (`same_tx`, `same_funder`, `direct_transfer`, `slot_bundle`) via Union-Find and detects behavioural `pack` clusters.
2. **Dual-Axis Verdict (`SAFETY 0–100` × `ALPHA 0–100`):**
   - **Safety Score:** 5 weighted anti-rug metrics, constant-product price-impact model, hard `DANGER` red flags, soft `59` (`RISKY`) caps, and `Guard`/`Shield` authority checks.
   - **Alpha & Microstructure Score:** 5m/1h Orderflow Imbalance (`OFI`), bonding curve velocity, **Wash-Trading Gate** (`Turnover / Liquidity`), **Exitability Cost-Gate** (`$1,000` round-trip slippage + fee cap), and organic operator breadth.
3. **Cross-Token SQLite `Operator Memory` ([`src/db.js`](src/db.js)):**
   - Persists every scanned dev creator and funding root in SQLite WAL (`data/apexorb.db`).
   - Automatically flags repeat offenders (`KNOWN_SYBIL_ROOT`) on future token scans.
4. **Live `pump.fun` WebSocket Radar ([`src/engine/radar.js`](src/engine/radar.js)):**
   - Real-time stream from `wss://pumpportal.fun/api/data` with instant `Shield` screening and SSE push to the UI.
5. **Interactive Cyber-Terminal UI ([`public/`](public/index.html)) & Paper-Trading Sandbox ([`src/engine/paper.js`](src/engine/paper.js)):**
   - Draggable 3D Canvas Operator Sphere, `Safety × Alpha` quadrant matrix, interactive Exit Simulator slider, live `Life of a Scan` trace log, and Paper Long PnL tracker.

## Quick Start

```bash
git clone https://github.com/markankamaransheogarat-sys/apex-orb
cd apex-orb
npm test        # runs unit + integration tests (Node >= 22, zero dependencies)
npm start       # starts server on http://127.0.0.1:8792
```

### Optional Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8792` | HTTP / SSE listening port |
| `HOST` | `127.0.0.1` | Bind host |
| `SOLANA_RPC_URLS` | Public mainnet + PublicNode | Comma-separated Solana RPC pool |
| `MAX_RPC_CALLS` | `85` | Per-scan RPC budget cap |
| `APEXORB_DB` | `./data/apexorb.db` | SQLite database path |

## Documentation

See [`docs/AUDIT_AND_ARCHITECTURE.md`](docs/AUDIT_AND_ARCHITECTURE.md) for the complete mathematical and architectural breakdown.
