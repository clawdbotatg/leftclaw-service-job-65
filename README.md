# UP/DOWN

A 1-minute binary price game on Base. Bet 1-100 USDC on whether ETH or BTC moves UP or DOWN in the next 60 seconds. Wins pay 1.76x in CLAWD. Losses buy-and-burn CLAWD.

- **Contract**: `UpDown` at [`0xC5331B149244b678268fEDBa9FDd610c3A38e925`](https://basescan.org/address/0xC5331B149244b678268fEDBa9FDd610c3A38e925) on Base mainnet
- **Collateral**: USDC (Base)
- **Payout token**: CLAWD
- **Oracle**: Chainlink ETH/USD and BTC/USD feeds on Base
- **Swap venue**: Uniswap V3 (USDC → WETH 0.05% → CLAWD 1%)

## Packages

- `packages/foundry/` — UpDown.sol, deploy script, tests
- `packages/nextjs/` — Next.js + RainbowKit + wagmi frontend (static IPFS export)

## Quickstart

```bash
yarn install
yarn start      # dev server at http://localhost:3000
yarn compile    # build contracts
yarn build      # static IPFS export -> packages/nextjs/out
```

Built on [Scaffold-ETH 2](https://scaffoldeth.io). See `packages/nextjs/` for frontend details and `packages/foundry/` for contract source, audit, and deploy script.
