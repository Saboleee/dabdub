# DupDub Stellar Contracts

> Soroban smart contracts powering the DupDub crypto-to-fiat settlement platform on Stellar.

## Overview

This repository contains the Soroban (Stellar smart contract platform) contracts that back DupDub's on-chain settlement flow — payment escrow, merchant registry, fee handling, and related infrastructure. It does **not** contain the backend API or frontend application; those live in their own repositories:

- **Backend (Settlement API)** — `dupdap-backend`
- **Frontend (Merchant & Customer Portal)** — `dupdap-frontend`

API work tracked in this repository is implemented in the backend; see [the backend API implementation note](docs/backend-api-implementation.md).

## Contracts

All contracts live under [`dupdapp_contract/contracts/`](dupdapp_contract/contracts/):

| Contract | Purpose |
|---|---|
| `admin_timelock` | Timelocked admin actions |
| `batch_payments` | Batched payment processing |
| `fee_calculator` | Fee computation logic |
| `fee_distributor` | Fee distribution to recipients |
| `liquidity_router` | Liquidity routing for settlements |
| `merchant_registry` | Merchant registration and metadata |
| `multisig_admin` | Multi-signature admin control |
| `payment_escrow` | Escrow for customer payments (approve → deposit → settle) |
| `payment_request` | Payment request lifecycle |
| `rbac_access` | Role-based access control |
| `reconciliation` | Settlement reconciliation |
| `settlement_ledger` | On-chain settlement record-keeping |
| `slippage_protection` | Slippage guards for conversions |
| `stellar_confirmations` | Confirmation tracking for Stellar transactions |

## Development

### Prerequisites

- Rust with the `wasm32v1-none` target
- [`stellar-cli`](https://developers.stellar.org/docs/tools/developer-tools) (for deployment)
- `wasm-opt` (binaryen), for optimised release builds

```bash
rustup target add wasm32v1-none
```

### Build & test

```bash
make build              # debug build of all contracts
make build-optimised    # release build + wasm-opt -Oz
make check-wasm-size    # enforce the 64 KB per-contract WASM limit
make test               # cargo test across the workspace
```

Or directly with cargo, from `dupdapp_contract/`:

```bash
cd dupdapp_contract
cargo build --target wasm32v1-none --release
cargo test
```

### Lint

`make lint` runs all static checks in sequence — `cargo clippy`, `cargo fmt --check`, and `cargo audit` — stopping at the first failure with a message identifying which check failed:

```bash
make lint
```

The pre-push git hook (`.githooks/pre-push`) runs `make lint`, so install the hooks once per clone:

```bash
git config core.hooksPath .githooks
```

## CI/CD

- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) — runs `cargo test`, coverage (tarpaulin), and a WASM build on every push/PR.
- **Deploy** ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) — builds and optimises WASMs, then deploys to Stellar testnet on merges to `main` and to mainnet on version tags (manual approval required).

### CI caching

The Soroban/Rust CI jobs cache the Cargo registry (`~/.cargo/registry`, `~/.cargo/git`) and the workspace `target/` directory via `actions/cache`. The cache key is derived from a hash of `dupdapp_contract/Cargo.lock`, so dependency changes invalidate the cache while unrelated commits reuse it.

Expected CI build time for the Rust/Soroban jobs:

| Scenario | Approx. duration |
|---|---|
| Cold cache (no cache hit) | ~8–12 min |
| Warm cache (registry + `target/` hit) | ~2–4 min |

Actual times vary with runner load and the size of the change; the warm-cache path is typically 3–4× faster because dependencies are not recompiled from scratch.

## Monitoring

Grafana/Loki/Promtail configs under [`grafana/`](grafana/) and [`docker-compose.yml`](docker-compose.yml) are provided for local observability tooling; see [`monitoring/`](monitoring/) for uptime/status-page setup.

### Alerts

Grafana alert rules are provisioned from [`grafana/provisioning/alerting/`](grafana/provisioning/alerting/). The `ESCROW.emergency_drain` rule fires within 1 minute of any emergency drain event on `payment_escrow`, pages PagerDuty, and notifies Slack `#security`. See the [emergency drain runbook](docs/security/emergency_drain_runbook.md).

## Docs

- [Escrow upgrade procedure](docs/escrow_upgrade_procedure.md)
- [Security docs](docs/security/)

## Links

- **Website**: [https://dupdub.xyz](https://dupdub.xyz)
- **Documentation**: [https://docs.dupdub.xyz](https://docs.dupdub.xyz)

## Handsoff notes

<!-- handsoff-issue-1094 -->
- #1094: merchant_registry and payment_escrow: a merchant suspended after deposit is still paid out by release/release_partial

<!-- handsoff-issue-1107 -->
- #1107: payment_escrow::dispute's _reason parameter is misleadingly underscore-prefixed despite being used, and has no validation

<!-- handsoff-issue-1108 -->
- #1108: payment_escrow: dispute resolution is all-or-nothing on the remainder even after a merchant has already delivered via partial release

<!-- handsoff-issue-1113 -->
- #1113: payment_escrow: the highest-risk functions (upgrade, emergency_drain's XLM path, set_registry(None)) have the thinnest test coverage

<!-- handsoff-issue-1307 -->
- #1307: [P2] payment_escrow: add is_expired() view function

<!-- handsoff-issue-1313 -->
- #1313: [P3] Add contract README for each of the 14 contracts

<!-- handsoff-issue-1323 -->
- #1323: [P3] Add Grafana alert rule for emergency_drain event
