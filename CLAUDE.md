# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WAX RNG Oracle is the NodeJS member process of the WAX `orng.wax` randomness service. Each member
holds one share of a 2-of-3 threshold RSA key (Shoup scheme, dealt at a key ceremony) and talks
to the `orng.wax` smart contract to:
- Verify at boot that its share matches the active on-chain `pubkeys` row and that its configured
  share index equals its `oracles.a` `oracle_index` (`lib/bootChecks.js`; any failure is fatal)
- Poll `reqs` and submit a partial signature for each request (`submitpart`)
- Combine the on-chain partials into the full signature and deliver it (`setrand`), logging
  combine diagnostics (rejected parts, suspect share index) and parking a request whose parts
  cannot combine until they change
- Report delivery failures (`markfailed`), retry delivery of `undelivered1` rows (`retrydeliver`)
  and erase expired ones (`cleanup`)

Key versions and membership are set on the contract by producer governance, not by this process.
Operator-facing documentation: `docs/OPERATOR-GUIDE.md`.

## Build & Development Commands

```bash
npm install          # Install dependencies
npm run build        # Build with webpack (development mode)
npm start            # Build and run application
npm test             # Run all unit tests (mocha)
npm run coverage     # Run tests with coverage (nyc)
npm run lint         # Check formatting with prettier
npm run prettier     # Auto-format code with prettier
```

Run a single test file:
```bash
LOG_LEVEL=none NODE_ENV=test mocha --exit test/<filename>.js
```

## Local Development Environment

The Makefile provides commands to set up a local development environment with Docker:

```bash
make setup-env       # Start local WAX chain + deploy contracts + configure RNG
make start-node1     # Start RNG oracle node 1 (via PM2)
make start-node2     # Start RNG oracle node 2 (via PM2)
make start-node3     # Start RNG oracle node 3 (via PM2)
```

Requires unlocking local wallet first:
```bash
cleos wallet unlock
cleos wallet import --private-key 5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3
```

## Architecture

### Entry Point
- `index.js` - Main entry point; initializes services and starts polling loops

### Core Services (lib/)
- `poller.js` - Polls blockchain for jobs, manages signing/execution lifecycle
- `rngPusher.js` - Pushes RNG transactions to the blockchain
- `jobService.js` - Manages job state, signatures, and delivery tracking
- `shareKeyService.js` - Manages RSA threshold signing keys
- `storage.js` - LowDB-based persistence for job tracking

### Express API (lib/)
- `app.js` - Express application setup
- `controller/` - API controllers for jobs and health checks
- `routes/` - Express route definitions

### Configuration (lib/config/)
- `configLoader.js` - Shim that tries `@waxio/wax-config` first, falls back to standard `config` library
- `config/default.json` - Default configuration
- Environment-specific configs: `config/local1.json`, `config/local2.json`, etc.

**Note:** For open source usage, the standard [config](https://www.npmjs.com/package/config) library is used. Optionally, `@waxio/wax-config` resolves secrets from AWS Secrets Manager - if installed, it is used automatically (README, "Optional: AWS Secrets Manager").

### Key Dependencies
- `@waxio/rsa-threshold-signatures` - RSA threshold signing library
- `eosjs` - WAX/EOS blockchain interaction
- `lowdb` - JSON file database for job state

## Configuration

Key environment variables:
- `EOS_API_URL` - WAX chain API endpoint
- `EOS_ORNG_NODE_OWNER` - Block producer account name
- `EOS_ORNG_PRIVATE_KEY` - Private key for pushing RNG actions
- `CLUSTER_MODE` - Enable cluster mode for parallel processing
- `READONLY_MODE` - Run Express API only without polling

## Smart Contract Integration

When modifying blockchain interaction code, show detailed plans before making changes. The actions the pollers push (`lib/rngPusher.js` → `lib/config/eos.js`) are:
- `submitpart(oracle, id, ver, sig_i)` - submit this member's partial signature for a request
- `setrand(oracle, id, ver, sig)` - deliver the combined full signature
- `markfailed(oracle, id, ver, sig, error_message)` - record a result whose delivery failed
- `retrydeliver(oracle, request_id)` - retry delivery of an `undelivered1` row
- `cleanup(oracle, batch_size)` - erase expired `undelivered1` rows

The boot self-check (`lib/bootChecks.js`) only reads `config.a`, `pubkeys` and `oracles.a`. The byte format of `sig_i` and `sig` must not change (see `CHANGELOG.md` 7.2.0).
