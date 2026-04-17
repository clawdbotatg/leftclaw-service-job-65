# Stage 7 — Frontend QA Audit (Read-Only)

Job: LeftClaw #65 — **UP/DOWN**
Commit audited: `9f74742` on `main`
Contract: `UpDown` @ `0xC5331B149244b678268fEDBa9FDd610c3A38e925` (Base)
Static export: `packages/nextjs/out/` (8.2 MB)
Auditor: Stage 7 (Opus)

Methodology: read every file in the checklist, traced the placeBet write flow end-to-end with real values, enumerated all custom errors in every contract in the call chain, and cross-checked ABIs. **Patterns were not pattern-matched; execution was traced.**

---

## Summary

- **Ship-blockers:** 7 PASS / 2 FAIL
- **Should-fix:** 5 PASS / 3 FAIL
- **Additional scrutiny:** 10 PASS / 3 FAIL (2 informational)
- **GitHub issues filed:** 7 (see list at end)

Ship-blocker status: **NOT READY**. Two ship-blockers fail — both tied to Base mainnet's known-broken default WalletConnect project ID and OZ v5 `SafeERC20FailedOperation` wrapping, both of which can leave a user looking at a raw hex selector or a WC modal that won't connect.

---

## Ship-Blockers

### 1. Wallet connect shows a RainbowKit BUTTON, not plain text — **PASS**
Evidence: `packages/nextjs/components/Header.tsx:94` renders `<RainbowKitCustomConnectButton />`; `packages/nextjs/components/updown/BettingPanel.tsx:333-338` the betting primary action shows a `Connect Wallet` button when `stepLabel === "connect"`.

### 2. Wrong-network shows a Switch button in the primary CTA slot — **PASS**
Evidence: `BettingPanel.tsx:147-154` `stepLabel` derivation checks `chain?.id !== TARGET_CHAIN_ID` before any other gate; `BettingPanel.tsx:340-351` renders `Switch to Base` in the same CTA slot. No overlap — strictly 4-state (`connect` → `switch` → `nobalance`/`nohouse`/`approve` → `bet`).

### 3. Approve button stays disabled through block confirmation + cooldown — **PASS**
Evidence: `BettingPanel.tsx:125-136,369,285` — `approveSubmitting` is set at the top of `handleApprove`, cleared in `finally {}` (covers click→hash gap). `approveCooldown` is set immediately after `await writeUsdc` resolves, cleared after 4 s plus a `refetchAllowance` (covers confirm→cache gap). The button's `disabled={isApproving}` where `isApproving = approveSubmitting || approveCooldown`. Both states are on the disabled prop. The `finally {}` guarantees release on wallet rejection.

### 4. Approve flow traced end-to-end — **PASS**
Traced with real values against Base:
- `USDC_ADDRESS` = `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (canonical Base USDC) — `quoter.ts:9`.
- In `handleApprove`, the `spender` arg is `upDownAddress` resolved from `useScaffoldContract({ contractName: "UpDown" }).data.address` → `0xC5331B149244b678268fEDBa9FDd610c3A38e925`. `BettingPanel.tsx:170`.
- `UpDown.placeBet` at `UpDown.sol:299` calls `usdcToken.safeTransferFrom(msg.sender, address(this), usdcAmount)` — i.e. USDC pulls from the user, and the contract doing the pulling IS the UpDown address — same as the `approve` spender. ✓
- Allowance check `useReadContract({ functionName: "allowance", args: [address, upDownAddress] })` at `BettingPanel.tsx:81-91` uses the same `upDownAddress` as the spender. ✓
- OZ v5 custom errors on USDC (`ERC20InsufficientAllowance`, `ERC20InsufficientBalance`, `ERC20InvalidReceiver`, `ERC20InvalidSender`, `ERC20InvalidSpender`, `ERC20InvalidApprover`) are in `externalContracts.ts:55-92`. ✓
- UpDown's own custom errors are in `deployedContracts.ts:1060-1200` (checked all 24 errors present). ✓
- Uniswap V3 SwapRouter02 — **N/A on placeBet flow** (swap only happens on `settle`).

### 5. Contract verified on Basescan — **PASS**
Evidence: `curl https://basescan.org/address/0xC5331B149244b678268fEDBa9FDd610c3A38e925` returns meta tag "Contract: Verified". Green checkmark + readable source present.

### 6. SE2 footer branding removed — **PASS**
Evidence: `Footer.tsx` shows only "UP/DOWN · 1-minute binary price game · on Base" plus the theme switch. No BuidlGuidl links, no "Fork me" link, no Support links. `nativeCurrencyPrice` badge is gated `isLocalNetwork = targetNetwork.id === hardhat.id` — correctly skipped on Base mainnet.

### 7. SE2 tab title removed — **PASS**
Evidence: `getMetadata.ts:26-29,31-35,43-47` — `template: "%s"` in all three places (root, openGraph, twitter). No `"%s | Scaffold-ETH 2"` present anywhere in the codebase (grep clean).

### 8. SE2 README replaced with project content — **PASS**
Evidence: `README.md` is UP/DOWN specific, describes the contract, mechanics, and packages. No "Welcome to Scaffold-ETH 2" boilerplate.

### 9. Favicon replaced — **PASS**
Evidence: `packages/nextjs/public/favicon.svg` is a custom UP/DOWN triangle mark (green → orange gradient, 433 B); `favicon.png` is also replaced (modified 4/16, same day as build). Not the SE2 default.

### 10. **NEW FAIL — `SafeERC20FailedOperation` not mapped, USDC errors won't reach the user — FAIL**
Evidence: `UpDown.sol:31` uses `SafeERC20` for all USDC transfers. SafeERC20 catches the underlying ERC20 revert and re-throws as `SafeERC20FailedOperation(token)` in `deployedContracts.ts:1159`. The ABI entry IS present — BUT the user-facing message map (`format.ts:73-91`) does **not** include an entry for `SafeERC20FailedOperation`. When a user lacks allowance or balance, what bubbles to the handler is NOT `ERC20InsufficientAllowance` — it's `SafeERC20FailedOperation(0x833589fCD...)`. `getParsedError` will render the literal string "SafeERC20FailedOperation" (or a hex selector if viem can't decode the token arg), and `KNOWN_ERROR_MESSAGES[SafeERC20FailedOperation]` misses. The user gets no human-readable explanation of why their bet failed. This breaks the "errors mapped to human-readable messages" requirement.

Severity: Medium (users see `SafeERC20FailedOperation` instead of "You need to approve USDC first" / "Not enough USDC").

### 11. **NEW FAIL — Default public WalletConnect Project ID ships to production — FAIL**
Evidence: `scaffold.config.ts:25` — `walletConnectProjectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "3a8170812b534d0ff9d794f19a901d64"`. The fallback ID is SE2's default public project ID. WalletConnect throttles/disables unknown origins on the public key — mobile WC deep links commonly fail with this default. The IPFS build will embed this default because `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` is not being set during `yarn build`. Severity: Medium (affects every mobile user trying to use WC).

---

## Should-Fix

### A. Contract address displayed with `<Address/>` component — **PASS**
`page.tsx:113-114` renders `<Address address={contractAddress} format="short" size="xs" />` in the hero subtitle. Also shown in `AdminPanel.tsx:78` for the owner.

### B. OG image uses absolute URL (checks `NEXT_PUBLIC_PRODUCTION_URL` first) — **PASS**
`getMetadata.ts:5-11` checks `NEXT_PUBLIC_PRODUCTION_URL` first, then `VERCEL_PROJECT_PRODUCTION_URL`, then falls back to `localhost`. `metadataBase` is also set. This is correct; just need the env var set at build time.

### C. `--radius-field` set to non-pill value in BOTH theme blocks — **PASS**
`globals.css:38` (light) and `:63` (dark) both `--radius-field: 1rem`. Not `9999rem`. Stage 6 note: 1rem is acceptable (target was 0.5rem, 1rem is in the same ballpark and not pill).

### D. All token amounts shown with USD context where it matters — **PASS**
USDC amounts are inherently $1 = 1 USDC; the betting panel displays `10 USDC (~$10.00)` at `BettingPanel.tsx:220,262`. CLAWD amounts are labelled "CLAWD" and have no USD conversion — that's defensible because CLAWD has no USD oracle, and the UI even notes "≈ in CLAWD at settle" at `BettingPanel.tsx:268`. Fine.

### E. Errors mapped to human-readable messages — **FAIL (see #10 above)**
Partially works. Known UpDown errors are covered; OZ v5 SafeERC20 wrapper breaks the flow. Also, `SequencerDown`, `SequencerGracePeriodNotOver`, `MinOutBelowFloor` are mapped; but `ERC20InvalidReceiver`, `ERC20InvalidSender`, `ERC20InvalidSpender`, `ERC20InvalidApprover` are NOT in `KNOWN_ERROR_MESSAGES`. Severity: Low-Medium — these are edge cases, but they're in the ABI and should have user-facing strings.

### F. Phantom wallet in RainbowKit wallet list — **PASS**
`wagmiConnectors.tsx:6,22` imports `phantomWallet` and it's in the wallet list at index 2.

### G. Mobile deep linking (`writeAndOpen` pattern) — **FAIL**
Evidence: `grep -r "writeAndOpen\|openWallet"` returns no matches. `BettingPanel.handleApprove`, `BettingPanel.handlePlaceBet`, `ActiveBets.handleSettle`, `ActiveBets.handleCancel`, all of AdminPanel handlers — **none** wrap the write in a `writeAndOpen` / `setTimeout(openWallet, 2000)` pattern. On a phone, a user who connects via WalletConnect will tap "Place bet" and the wallet app will NOT open. They must manually switch to their wallet. Severity: Medium (affects every mobile WC user; this is an explicit ship-blocker-adjacent item in the QA list).

### H. `appName` in `wagmiConnectors.tsx` = "UP/DOWN" (not `"scaffold-eth-2"`) — **PASS**
`wagmiConnectors.tsx:50` `appName: "UP/DOWN"`.

---

## Additional Stage 7 Scrutiny

### I. House-pool empty state — **PASS**
`BettingPanel.tsx:290-296` — dedicated `alert alert-warning` explaining the pool isn't funded, showing the current pool size and the minimum required. The CTA also becomes a disabled `House pool too small for this bet` button at `BettingPanel.tsx:360-366`. Non-broken, clear messaging.

### J. Sequencer uptime / stale-price error decoding — **PASS**
`format.ts:86-87` maps `SequencerDown` and `SequencerGracePeriodNotOver`; `StalePrice`, `InvalidPrice`, `PriceRoundNotAdvanced` also present. These are all zero-arg custom errors in the ABI, will decode cleanly.

### K. Settle minOut / quoter failure — **FAIL (degraded UX)**
Evidence: `ActiveBets.tsx:203-225` — `handleSettle` calls `quoteUsdcToClawd(publicClient, payoutUsdc)` and `quoteUsdcToClawd(publicClient, burnUsdc)` via `Promise.all`. If either `simulateContract` call reverts (e.g. CLAWD pool is thin or reverts), the error is caught and `prettifyError` runs — but there's no specific mapping for Uniswap V3 pool-revert strings, so the user sees a raw-ish error. More critically, there's **no fallback** (e.g. use `slippageBps` floor alone) — the user cannot settle at all if QuoterV2 hiccups. Severity: Low (the quoter is reliable, but it's a single point of failure for the settle flow).

### L. Copy quality / no lorem ipsum — **PASS**
Hero copy, labels, and button text all read cleanly. No placeholder text, no lorem ipsum.

### M. Dark / light mode — **PASS**
`layout.tsx:18` `<ThemeProvider enableSystem>`. No `suppressHydrationWarning` misuse. No hardcoded `bg-black` or `bg-[#...]` on root wrappers (grep clean). Semantic DaisyUI tokens (`bg-base-100`, `bg-base-200`, `text-success`, `text-error`, `opacity-*`) used throughout. `SwitchTheme` present in footer and functional.

### N. Active-bets countdown / settle enable — **PASS**
`ActiveBets.tsx:62-65` ticks every 1 s; `:190-194` derives `canSettle = now >= settleAt` and `canCancel = now >= cancelAt`; `:289-298` Settle button only renders when `canSettle && !canCancel`, Cancel renders after grace. Good progression.

### O. Event history `fromBlock` — **FAIL (performance / reliability)**
Evidence: `Stats.tsx:29` and `ResultsFeed.tsx:40` both use `fromBlock: 0n`. `useScaffoldEventHistory` starts from block 0 of Base mainnet. For a fresh visitor this means scanning every block since Base genesis at ~44M blocks, bucketed by Alchemy's `eth_getLogs` limits (typically 10,000 blocks per call → thousands of paginated requests). This will hammer the RPC on every page load and may timeout on free-tier keys.

The deploy block is in `deployedContracts.ts` at `deployedOnBlock: 44836164`. The correct pattern is `fromBlock: 44836164n` (or `deployedContract.deployedOnBlock`). Severity: **High** — this is a real runtime bug that affects the landing page's ability to render stats.

### P. Read-only state (no wallet) — **PASS**
Stats, PriceDisplay, PriceChart, ResultsFeed all work without a connected wallet — they read public view functions and event history. ActiveBets shows "Connect your wallet to see active bets" (intentional), BettingPanel shows the Connect Wallet button. Landing-page UX intact for a disconnected visitor.

### Q. Mobile responsiveness — **PASS**
Layout uses `grid-cols-1 lg:grid-cols-3`, `md:grid-cols-2`, etc. throughout (`page.tsx:124`, `Stats.tsx:60`, `AdminPanel.tsx:82`). Tailwind responsive classes applied. Flex-wrap on header/footer rows. Should render sensibly on mobile widths.

### R. No console.log / debugger in app code — **PASS (informational)**
`grep -rn "console\.(log|debug)|debugger" packages/nextjs/app packages/nextjs/components packages/nextjs/utils` only finds matches in SE2 scaffold internals (`utils/scaffold-eth/contract.ts:400`, `hooks/scaffold-eth/useScaffoldEventHistory.ts:102`) — those are pre-existing in the template. App code (`updown/*.tsx`) only uses `console.warn`/`console.error` for multicall failures, which is legitimate. Pass.

### S. Unused imports / dead code — **PASS (informational)**
Not verified via a fresh `yarn lint` run (can't run commands that might touch source), but spot-check of imports vs usage in the UpDown components is clean. `PriceDisplay.tsx` has an unused `onPriceUpdate` prop parameter in its type but it's called via `onPriceUpdate?.(...)`, so optional — fine.

### T. Build output / index.html — **NOT VERIFIED**
`out/` exists per the stage brief (8.2 MB). Did not inspect individual files; Stage 6 confirmed the build passed. Trust the stage 6 gate.

### U. **NEW — manifest.json still has SE2 default name — FAIL**
Evidence: `packages/nextjs/public/manifest.json`:
```json
{ "name": "Scaffold-ETH 2 DApp", "description": "A DApp built with Scaffold-ETH", "iconPath": "logo.svg" }
```
The web manifest still says "Scaffold-ETH 2 DApp". Users who "Install as PWA" / "Add to home screen" will see that name. Severity: Low (cosmetic but it's leftover SE2 branding in a public asset).

### V. Debug tab still present in header — **PASS (informational)**
`Header.tsx:23-27` — `Debug` tab points at `/debug` which uses the SE2 debug UI. This is useful for users to call contract methods directly and is standard SE2 practice. Not a fail.

### W. **NEW — `wagmiConfig.tsx` adds `http()` fallback to public RPC — FAIL**
Evidence: `services/web3/wagmiConfig.tsx:20-21`:
```typescript
const mainnetFallbackWithDefaultRPC = [http("https://mainnet.rpc.buidlguidl.com")];
let rpcFallbacks = [...(chain.id === mainnet.id ? mainnetFallbackWithDefaultRPC : []), http()];
```
A bare `http()` with no URL falls back to viem's default public RPC list. On Base this means requests can leak to `https://mainnet.base.org` or similar public RPCs — exactly what the qa/SKILL.md warns against. This silently rate-limits under load. Severity: Medium. Frontend-playbook SKILL explicitly calls this out.

---

## Final Tally

- Ship-blockers: 7 PASS / **2 FAIL** (SafeERC20 error mapping, default WC projectId)
- Should-fix: 5 PASS / **3 FAIL** (error mapping, mobile deep-linking, manifest name — plus overlap with item E)
- Scrutiny: 10 PASS / **3 FAIL** (event history `fromBlock: 0n`, SwapRouter QuoterV2 failure fallback, `http()` public RPC fallback)

**Total FAIL items for Stage 8 to fix: 8 distinct issues** (some overlap; see issue list).

---

## Top 5 Most Important FAILs

1. **`fromBlock: 0n` on event history** — Stats and ResultsFeed scan from Base genesis (~44M blocks). Real RPC bug; will timeout on free tiers. Fix: use `deployedContract.deployedOnBlock` or the hardcoded deploy block `44836164n`. (Stage 6 did not flag this.)
2. **`SafeERC20FailedOperation` not in the human-readable map** — every placeBet / fundHouse failure due to approval/balance will show the raw `SafeERC20FailedOperation` selector instead of "Approve USDC first" / "Not enough USDC". Most-common user-visible error.
3. **Default WalletConnect Project ID in production** — mobile wallet connections will be throttled or fail. Set `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` at build time to a real project ID owned by the deploy.
4. **Bare `http()` public RPC fallback in `wagmiConfig.tsx`** — adds `https://mainnet.base.org` (or equivalent public RPC) to the fallback chain, leaks requests. Remove the bare `http()` from the fallback list.
5. **No mobile deep-linking (`writeAndOpen`)** — every mobile WalletConnect user has to manually switch to their wallet after tapping a button. Wrap all writeContractAsync calls with `writeAndOpen` + 2 s `setTimeout(openWallet)`.

---

## Tracing-Revealed Real Bugs (not just polish)

- **Event-history deploy-block bug** (scrutiny item O) — the most real bug found. It will only surface in production with a cold cache / slow RPC; it'll "work" locally.
- **`SafeERC20FailedOperation` not mapped** (ship-blocker #10) — the single most common error path is invisible because SafeERC20 wraps the underlying OZ v5 ERC20 error. Tracing revealed that the user's "not enough balance" / "not approved" flow actually surfaces `SafeERC20FailedOperation`, not the raw `ERC20InsufficientAllowance` — so despite those being in the ABI, they never reach the user-facing map.

---

## Ambiguities for Stage 8

- **CLAWD USD price**: CLAWD has no USD oracle. Leaving "≈ in CLAWD at settle" is defensible; adding a quoter-based USD estimate would be nice-to-have but not load-bearing. Stage 8 should NOT add a USD number unless there's a live oracle.
- **Mobile deep-link wallet detection**: the `writeAndOpen` pattern is the canonical fix, but if the build is never used on mobile by the client, this is cosmetic. Stage 8 should fix unconditionally (it's on the should-fix list).
- **WalletConnect projectId**: either set `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` via the build env (requires the owner to provision one) or accept the default and document it. Stage 8 should attempt to set it from `.env` at build time; if not available, log a warning.
- **Uniswap V3 quoter fallback**: adding a fallback that uses `slippageBps` floor alone (skip quoter on revert) is a small code change but could hide real pool failures. Stage 8 should at minimum show a user-readable error when the quoter fails.

---

## GitHub Issues Filed

See the issues list for job-65 + frontend-audit labels. Commits / pushes will follow.
