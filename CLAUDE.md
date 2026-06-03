# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WAX RNG Oracle is a NodeJS application for WAX Block Producers to process decentralized random number generation (RNG) jobs on the WAX blockchain. It interacts with the `orng.wax` smart contract to:
- Update signing public keys
- Participate in epoch processes (submitting seeds and signatures)
- Poll and sign pending RNG jobs using RSA threshold signatures
- Execute completed jobs and report failures
- Clean up resolved signed values

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

**Note:** For open source usage, the standard [config](https://www.npmjs.com/package/config) library is used. Internal WAX deployments can optionally use `@waxio/wax-config` for secrets management - if installed, it will be used automatically.

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

When modifying blockchain interaction code, show detailed plans before making changes. The oracle interacts with the `orng.wax` contract for:
- `setrand` - Submit partial signatures for jobs
- `signepoch` - Sign epoch seeds
- `execjob` - Execute completed RNG jobs
