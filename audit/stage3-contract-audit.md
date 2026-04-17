# UpDown.sol — Stage 3 Contract Audit Report

**Job**: LeftClaw Job #65 — UP/DOWN 1-Minute CLAWD Price Game
**Target**: `packages/foundry/contracts/UpDown.sol` (366 LOC)
**Commit**: `f8f98dca`
**Deploy script**: `packages/foundry/script/DeployUpDown.s.sol`
**Chain**: Base mainnet (8453)
**Methodology**: `https://ethskills.com/audit/SKILL.md` — specialist checklists applied: `general`, `precision-math`, `erc20`, `defi-amm` (Uniswap V3 swap), `oracles` (Chainlink), `access-control` (Ownable), `dos`, `chain-specific` (Base L2).
**Auditor**: clawdbotatg stage-3 (Opus)
**Date**: 2026-04-17

---

## Executive Summary

The contract implements a 1-minute UP/DOWN house-pool price game correctly at the state-machine level (monotonic betId, strict PENDING→{WON,LOST,CANCELLED} transitions, nonReentrant everywhere, CEI on settle's win path). However there are **two Critical ship-blockers** that will make the contract non-functional or economically broken on Base mainnet, **three High-severity issues** that expose the house to MEV/sandwich extraction, and several Medium/Low findings.

### Findings by severity

| Severity | Count |
|----------|------:|
| Critical | 2 |
| High     | 4 |
| Medium   | 6 |
| Low      | 5 |
| Info     | 4 |
| **Total**| **21** |

### Top issues (must fix before Stage 5 deploy)

1. **[C-1] Burn path reverts every losing bet** — CLAWD is OZ v5; `transfer(address(0))` reverts with `ERC20InvalidReceiver`. Every LOSS settlement will revert, bricking the game.
2. **[C-2] Player's losing USDC accounting mismatch** — On LOSS, `housePool += usdcAmount` then 50% is swapped out. The contract's USDC balance is now `pool + userBet - swapped`, but `housePool` state variable records `pool + userBet - burnUsdc`. The accounting is internally consistent EXCEPT that on WIN, the player's original `usdcAmount` is neither added to `housePool` nor returned — it remains in the contract as untracked USDC (confirmed self-report). Over time this creates a growing untracked pile, `housePool` under-represents withdrawable funds, and the owner cannot reclaim these funds via `withdrawHouse`.
3. **[H-1] `amountOutMinimum = 1` on every swap** — Both win payouts and burn swaps pass `minClawdOut = 1`, enabling full sandwich extraction on Base. Spec calls for 5% slippage tolerance.
4. **[H-2] No Chainlink staleness / round-completeness check** — Only `answer > 0` is enforced. A stale or crashed feed prices bets at the last-reported value.
5. **[H-3] Settle front-running / timing oracle** — Any MEV searcher can observe a pending bet that is about to go against the house, delay `settle()` until the next block's oracle push swings the outcome, and extract value deterministically.

### GitHub Issues filed

7 issues filed on `clawdbotatg/leftclaw-service-job-65` for every Critical/High/Medium finding (see section "Issues Filed" at the end).

---

## Scope & Environment

- Contract: `UpDown.sol` — 366 LOC, `pragma solidity ^0.8.20`, `Ownable(_owner)`, `ReentrancyGuard`, `SafeERC20`.
- External contracts:
  - USDC (Base): `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` — 6 decimals, standard Circle USDC with pausing + blocklist.
  - CLAWD: `0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07` — 18 decimals, OpenZeppelin v5 ERC20 (confirmed: selectors `0xec442f05` ERC20InvalidReceiver, `0x96c6fd1e` ERC20InvalidSender match OZ v5).
  - Uniswap V3 SwapRouter02: `0x2626664c2603336E57B271c5C0b26F421741e481`.
  - ETH/USD feed (Base): `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` — 8 decimals, verified.
  - BTC/USD feed (Base): `0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F` — 8 decimals, verified.
  - Owner = `0x7E6Db18aea6b54109f4E5F34242d4A8786E0C471` = `job.client` (confirmed via on-chain `getJob(65)`).

---

## Findings

### [C-1] Burn path reverts — CLAWD (OZ v5) blocks `transfer(address(0))`

**Severity**: Critical
**Category**: erc20 / general
**Location**: `UpDown.sol:72` (`BURN_ADDRESS = address(0)`), `UpDown.sol:243-245` (`clawdToken.safeTransfer(BURN_ADDRESS, clawdBurned)`)

**Description**: CLAWD (`0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07`) is deployed as **OpenZeppelin v5 ERC20**. In OZ v5, `_update` enforces `to != address(0)` and reverts with `ERC20InvalidReceiver(address(0))` (selector `0xec442f05`) on any direct transfer to the zero address. Verified on-chain: `cast call CLAWD transfer(0, 1000)` returns this exact revert.

The contract's LOSS settlement path:
```solidity
clawdBurned = _swapUsdcToClawd(burnUsdc, 1, address(this));
if (clawdBurned > 0) {
    clawdToken.safeTransfer(BURN_ADDRESS, clawdBurned); // REVERTS
}
```

Every losing bet with `usdcAmount >= 2` (so `burnUsdc >= 1` and the swap produces CLAWD) will revert when `safeTransfer(address(0), ...)` is called. Because losses are the house's primary income, and the spec demands "losers buy+burn CLAWD," this fully breaks game economics. Winners still pay out (swap sends CLAWD directly to player without touching `address(0)`), so the contract asymmetrically drains the house pool — wins succeed, losses fail — which is worse than a pure DoS.

**Proof of concept**:
1. Owner funds house (`fundHouse(1000 USDC)`).
2. Player bets 10 USDC on ETH UP.
3. ETH price stays flat or goes down → LOSS branch executes.
4. `_swapUsdcToClawd(5 USDC, 1, address(this))` succeeds, contract holds `N` CLAWD.
5. `clawdToken.safeTransfer(address(0), N)` reverts with `ERC20InvalidReceiver(0)`.
6. Entire `settle()` transaction reverts; bet remains PENDING.
7. 5 minutes later, `cancelExpiredBet` refunds the player — they effectively have a free option: win = collect CLAWD, lose = get USDC back.

**Recommendation**: CLAWD does not expose a public `burn()` (OZ v5 ERC20 base, no `ERC20Burnable` mixin — confirmed: `burn(uint256)` reverts with `ERC20InvalidSender`). Options, in order of preference:
1. **Send to a provably-unretrievable EOA**: create a new `BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD` (common convention, not blocked by OZ v5). Update constant and comment.
2. **Send to `address(0xdead)` via a dedicated burn vault** — a contract with no withdraw function.
3. Confirm with client whether `clawdgut.eth` or `leftclaw.eth` is the intended burn sink (but per `skill/contract` rules, do NOT use any LeftClaw wallet as owner/admin/treasury — so this is not appropriate unless the client explicitly designates a sink).

**Recommended fix**:
```solidity
address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
```
and update comments + events naming. The `0xdEaD` address is a well-known burn sink with no known private key and is not blocked by OZ v5's receiver check.

---

### [C-2] Winning bet's original USDC becomes untracked / unrecoverable

**Severity**: Critical
**Category**: general / accounting
**Location**: `UpDown.sol:218-230` (WIN branch of `settle`)

**Description**: On WIN:
- Player's `usdcAmount` entered the contract at `placeBet()` (line 182: `safeTransferFrom(msg.sender, address(this), usdcAmount)`).
- `housePool` was **not incremented** at `placeBet` (by design — house covers the win from its pre-funded pool).
- On win, `housePool -= payoutUsdc` and `payoutUsdc` USDC is swapped to CLAWD and sent to player.
- The player's original `usdcAmount` is **neither added to `housePool`, nor returned to the player, nor swapped**. It sits in the contract as untracked USDC.

This is a state-variable / actual-balance divergence. After N winning bets totaling `W` USDC in bets, `IERC20(usdc).balanceOf(address(this)) - housePool == W + pendingBetsUSDC`. The owner can call `withdrawHouse(housePool)` to drain the tracked pool but cannot touch `W`. Nothing in the contract ever accesses this pile, so it is permanently locked.

Given the spec's 1.76x payout target and ~50/50 odds, roughly half of bets win. Over the expected lifetime of the game, a majority of the player-supplied USDC ends up locked rather than recycled into house edge.

**Impact**:
- Direct loss of value from house perspective — player USDC that should have gone back into the pool to fund future payouts and burns is orphaned.
- Violates the spec's stated economics ("House edge is ~12% at 50/50 odds") — actual edge becomes sharply negative because the winning player receives 1.76× their bet in CLAWD and also effectively keeps their bet-cost stranded in the contract.
- Over time, `housePool` depletes to zero while USDC balance grows, and the owner cannot easily reclaim (requires a new rescue function).

**Recommendation**: On WIN, add the player's bet to the house pool before deducting the payout, so the net deduction is `payoutUsdc - usdcAmount`:
```solidity
if (won) {
    uint256 payoutUsdc = (b.usdcAmount * payoutMultiplierBps) / BPS_DENOM;
    // Player's bet enters the pool and the payout comes out — net cost is (payout - bet)
    housePool = housePool + b.usdcAmount - payoutUsdc;
    b.status = BetStatus.WON;
    uint256 clawdOut = _swapUsdcToClawd(payoutUsdc, minClawdOut, b.player);
    emit BetSettled(betId, BetStatus.WON, payoutUsdc, clawdOut);
}
```
This is also simpler to reason about: `housePool` is then a true accounting of USDC owned by the house. The pre-check `if (housePool < requiredCover)` already guarantees `housePool >= usdcAmount * 17600 / 10000 > usdcAmount`, so `housePool + usdcAmount - payoutUsdc >= 0`.

---

### [H-1] `amountOutMinimum = 1` on every swap — full sandwich / MEV exposure

**Severity**: High
**Category**: defi-amm
**Location**: `UpDown.sol:228` (`_swapUsdcToClawd(payoutUsdc, 1, b.player)`), `UpDown.sol:241` (`_swapUsdcToClawd(burnUsdc, 1, address(this))`)

**Description**: Both call sites pass `minClawdOut = 1`, i.e. "accept any non-zero CLAWD out." This disables slippage protection entirely and is exploitable in two ways:

1. **Player-side on WIN**: A searcher sees the pending `settle()` tx in Base's public mempool. They front-run by pushing the USDC→WETH→CLAWD pool off-peg, let the settle swap execute with near-zero output, then back-run. The player receives dust CLAWD. Spec explicitly calls for "5% slippage tolerance."
2. **House-side on LOSS**: Same sandwich, but the CLAWD intended for burn comes out as dust, reducing burn pressure that the tokenomics rely on.

Base has lower MEV than mainnet but is not MEV-free — Flashbots runs a Base builder, and the CLAWD/WETH 1% pool is small enough that manipulation is cheap. With a 1% fee tier, the CLAWD pool is by construction thin.

**Recommendation**: Compute `amountOutMinimum` as `expectedOut * (10000 - maxSlippageBps) / 10000`, where `expectedOut` is derived from an off-chain quote signed into the bet, or from the Chainlink ETH/USD price for the USDC→WETH leg plus a stored CLAWD/WETH price for the WETH→CLAWD leg. Simplest mitigation that preserves the spec:

- Add `maxSlippageBps` owner-configurable parameter (default 500 = 5%).
- On WIN, compute `minClawdOut` from Chainlink ETH/USD and a governance-settable `clawdUsdPriceE8` (the only on-chain CLAWD price reference is the thin pool itself, so a fully on-chain quote is not available without TWAP).
- Since CLAWD has no reliable non-pool oracle, an honest alternative is to have `placeBet` record a user-supplied `minClawdOutOnWin`, and revert settle if that floor isn't met — the user voluntarily accepts their own slippage.

At minimum, do NOT use `1`. Use a Uniswap V3 Quoter off-chain and sign `minClawdOut` into the bet, or accept slightly higher pool-derived floor at settle time.

---

### [H-2] No Chainlink staleness / round-completeness / bounds checks

**Severity**: High
**Category**: oracles
**Location**: `UpDown.sol:330-335` (`_getPriceInternal`)

**Description**:
```solidity
function _getPriceInternal(uint8 asset) internal view returns (int256 price) {
    AggregatorV3Interface feed = asset == uint8(Asset.ETH) ? ethFeed : btcFeed;
    (, int256 answer,,,) = feed.latestRoundData();
    if (answer <= 0) revert InvalidPrice();
    return answer;
}
```

Only `answer > 0` is checked. All other return values — `roundId`, `startedAt`, `updatedAt`, `answeredInRound` — are discarded. Specific problems:

1. **Staleness**: If Chainlink's Base ETH/USD feed stops updating (outage, deprecated, paused), `answer` remains the last value indefinitely. A player who knows a price has crashed can bet against the stale value and settle at the stale value for free money (from the house).
2. **`answeredInRound < roundId`**: Indicates the answer is from a prior round and the current round hasn't settled; treated as fresh here.
3. **L2 sequencer uptime**: Base is an OP-Stack L2. During sequencer downtime, oracle prices don't update. When the sequencer resumes, the first reported prices can be wildly stale vs market. Chainlink publishes a sequencer uptime feed on Base — this contract does not consult it.
4. **`minAnswer`/`maxAnswer` bounds**: Chainlink aggregators clamp answers. ETH/USD on Base has bounds; during flash crashes the feed returns `minAnswer` instead of the true price, enabling systematic betting against the clamp.

**Attack scenario (staleness)**:
1. ETH/USD feed freezes at $3000 for 2 hours (hypothetical outage).
2. Real ETH price drops to $2800 on DEXes.
3. Attacker bets DOWN at "entry $3000."
4. 60 seconds later, feed is still $3000 → tie → LOSS per spec (but see [M-1]).
5. Attacker repeatedly bets DOWN; the moment the feed catches up to $2800, attacker wins 1.76×.
6. House bleeds on the first post-outage update.

**Recommendation**: Add comprehensive checks:
```solidity
uint256 public constant FEED_HEARTBEAT_BUFFER = 3600; // 1h buffer over feed heartbeat

function _getPriceInternal(uint8 asset) internal view returns (int256) {
    // Check L2 sequencer uptime (Base uses OP-Stack sequencer feed)
    (, int256 seqAnswer, uint256 seqStartedAt,,) = sequencerUptimeFeed.latestRoundData();
    if (seqAnswer != 0) revert SequencerDown();                 // seqAnswer == 1 means down
    if (block.timestamp - seqStartedAt < GRACE_PERIOD) revert SequencerGracePeriod(); // 1h

    AggregatorV3Interface feed = asset == uint8(Asset.ETH) ? ethFeed : btcFeed;
    (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
    if (answer <= 0) revert InvalidPrice();
    if (answeredInRound < roundId) revert StaleRound();
    if (block.timestamp - updatedAt > FEED_HEARTBEAT_BUFFER) revert StalePrice();
    return answer;
}
```
Add sequencer uptime feed as an immutable constructor arg; Base's feed is `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` (verify at deploy time).

---

### [H-3] Settle front-running / timing — searcher delays settle to flip outcome

**Severity**: High
**Category**: oracles / general / MEV
**Location**: `UpDown.sol:204-250` (`settle`) — no upper time bound on when settle may be called within the grace period

**Description**: `settle()` is callable by anyone at any time after `settleAfter` and before `settleAfter + CANCEL_GRACE` (360 seconds total window: 60s delay + 300s grace). The outcome depends on the Chainlink price at the moment settle executes.

Because Chainlink ETH/USD on Base updates approximately every 25–30 minutes (deviation-triggered — confirmed on-chain), the price is essentially constant across the 360-second settle window in typical conditions, which makes a single bet hard to manipulate. However, under volatility or near Chainlink update boundaries, an MEV searcher can:

1. See a bet's `settleAfter` and the current on-chain price.
2. Watch for the next Chainlink price push (visible in the public mempool).
3. Front-run or back-run the Chainlink update with `settle()` to pick whichever side is profitable for the house or the attacker.

A more concrete scenario: the player calls `settle()` themselves. A searcher in Base's sequencer queue can reorder the tx to land after a pending Chainlink update that flips the bet from WIN to LOSS. The player pays gas, loses their bet, and the value goes to the house (but the searcher can also self-settle against user bets if they learn of a pending favorable update).

Additionally, the `settle()` callable-by-anyone design means an adversary observing user-submitted settle txs can front-run with an identical settle to capture the settlement event's effective timing (though outcome is identical in CEI-correct code, the payoff address is set in the bet so the attacker cannot steal the payout — so this particular variant is non-exploitable).

**Recommendation**:
- Use the Chainlink `roundId` at `placeBet` time; at `settle`, use a round whose `startedAt >= settleAfter`. This binds the settle price to a Chainlink round that came after the bet window closed, removing settler-chosen timing.
- Alternatively, require `updatedAt` at settle to be `>= settleAfter`, so the price used to settle was published no earlier than the bet window closed. This dramatically reduces the window where a searcher can front-run a pending round update.

Cleanest implementation:
```solidity
(uint80 roundId, int256 answer, , uint256 updatedAt,) = feed.latestRoundData();
if (updatedAt <= b.settleAfter - SETTLE_DELAY) revert PriceStale();  // must be newer than bet entry
```

---

### [H-4] `setLimits` allows owner to brick or rug via payout multiplier

**Severity**: High
**Category**: access-control
**Location**: `UpDown.sol:282-289`

**Description**: `setLimits` has two checks — `_minBet != 0 && _maxBet >= _minBet` and `_payoutMultiplierBps > BPS_DENOM` (must be strictly > 1x). It does **not** have an upper bound on `payoutMultiplierBps`. Owner can set `payoutMultiplierBps = type(uint256).max`, which immediately causes every `placeBet` to revert due to `requiredCover` overflow (or, before overflow, an impossibly-large house cover requirement), bricking new bets.

More subtly, owner can set `payoutMultiplierBps = 10001` (1.0001x), making the game unattractive but not reverting — the owner can quietly drain value out of players. Because the owner is `job.client`, this is a stated "owner controls the house" rule, but the lack of an upper bound is still a footgun: an attacker who compromises the owner key has instant rug via `payoutMultiplierBps = 1_000_000_000_000` or via `setLimits(min=1, max=type(uint256).max, payout=10001)`.

There is no timelock. Changes take effect immediately and apply to all bets placed after the change (but not to already-PENDING bets, which use the payout snapshot taken at settle — wait, they don't — `settle` reads `payoutMultiplierBps` fresh, so owner can change the payout rate mid-bet and underpay winners). This is a **real user-harm vector**: an honest owner changing rates is fine, but players who bet at 1.76x and settle at 1.01x lose value deterministically.

**Proof of concept**:
1. Owner promotes "1.76x payouts."
2. 100 players place bets, each 100 USDC, at `payoutMultiplierBps = 17600`.
3. Before anyone can settle, owner calls `setLimits(1, 100_000_000, 10001)`.
4. All winners now receive 1.0001x instead of 1.76x. Owner keeps the delta.

**Recommendation**:
- Add sensible bounds: `_payoutMultiplierBps >= 10000 && _payoutMultiplierBps <= 50000` (1.0x–5.0x).
- Snapshot `payoutMultiplierBps` into the `Bet` struct at `placeBet` and use the snapshot in `settle`. This also preserves the pre-check's economic guarantee: `requiredCover` at placement is the true cover used at settlement.
- Consider a minimum multiplier (e.g., `>= 11000` = 1.1x) as a user-trust anchor.

---

### [M-1] Tie (`currentPrice == entryPrice`) → LOSS is undocumented in NatSpec

**Severity**: Medium
**Category**: general / documentation
**Location**: `UpDown.sol:211-216`, NatSpec on `settle` (line 202-203)

**Description**: The settle logic uses strict inequalities:
```solidity
if (b.direction == uint8(Direction.UP)) {
    won = currentPrice > b.entryPrice;
} else {
    won = currentPrice < b.entryPrice;
}
```
A tie (`currentPrice == entryPrice`) falls into the else branch and is treated as a LOSS. The job description explicitly matches this (" Exact same price = LOST (house wins ties)"), so the behavior is spec-aligned. However, the NatSpec on `settle` does not document tie-handling, and the inline comment on line 232 says "Loss (including ties)" which is correct but buried.

This matters because Chainlink feeds update infrequently (~25–30 min on Base per observation of feed `0x71041dd...`) relative to the 60s bet window. In calm markets, the feed's `answer` is often identical at placeBet and settle time. Under the current logic, a player who bets during a feed-update drought is almost always losing due to no price movement — not due to wrong direction. This is a player-hostile but spec-compliant design.

**Recommendation**:
- Add explicit NatSpec: `/// @dev Ties (currentPrice == entryPrice) resolve as LOST. House wins if the price does not move.`
- Consider warning in the frontend that bets placed during a Chainlink update drought will likely lose.
- Alternative (out-of-scope spec change): split ties into a `TIE` status that refunds the bet. This would require client sign-off.

---

### [M-2] `getPendingBets` unbounded O(N) loop — gas DoS at scale

**Severity**: Medium
**Category**: dos
**Location**: `UpDown.sol:301-319`

**Description**: `getPendingBets(player)` iterates `betCount` twice (once to size the array, once to fill). At N = 100,000 bets (plausible over a few months of a popular game on Base), each `SLOAD` is ~2100 gas hot or ~2100 cold per bet struct read. At ~5000 gas per iteration (reading `b.player` and `b.status`), 100K iterations = 500M gas per call, well above any RPC-served `eth_call` gas limit.

On Base, this is a read-only view function (no state change) so it only affects the frontend's ability to list pending bets. Severity is Medium because it degrades UX at scale — the frontend cannot recover bet lists for active users without additional off-chain indexing.

**Recommendation**:
- Maintain per-player indexing: `mapping(address => uint256[]) playerBets;` pushed at `placeBet`, with status stored in `bets[betId]`. Iterate only the player's bets.
- Or rely exclusively on event indexing (`BetPlaced`/`BetSettled`/`BetCancelled`) for UI, which is the standard SE-2 pattern, and deprecate this getter.
- Or add pagination: `getPendingBets(address player, uint256 start, uint256 stop)`.

---

### [M-3] `fundHouse` / `withdrawHouse` not owner-safe — use of plain `Ownable`

**Severity**: Medium
**Category**: access-control
**Location**: `UpDown.sol:28` (inherits `Ownable`), `UpDown.sol:147` (`Ownable(_owner)`)

**Description**: The contract uses single-step `Ownable` rather than `Ownable2Step`. If the owner transfers ownership to an incorrect address, control is lost permanently. Given that the owner controls `fundHouse`/`withdrawHouse`/`setLimits` — and `withdrawHouse` can drain the house pool — this is a high-impact centralization concern for the client.

This is a well-known class of bug (see beirao A-05).

**Recommendation**: Replace `Ownable` with `Ownable2Step`:
```solidity
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
contract UpDown is Ownable2Step, ReentrancyGuard { ... }
constructor(...) Ownable(_owner) {}  // Ownable2Step inherits from Ownable
```
Two-step transfer requires both `transferOwnership` (by current owner) and `acceptOwnership` (by new owner), preventing accidental transfers to dead addresses.

---

### [M-4] Player's bet uses `direction` vs `entryPrice` at the same block — feed update front-run

**Severity**: Medium
**Category**: oracles
**Location**: `UpDown.sol:171-200` (`placeBet`)

**Description**: `placeBet` reads the current Chainlink price and locks it as `entryPrice` in the same tx. Because Chainlink price pushes are publicly visible in the mempool, a searcher can observe a pending push (e.g., "ETH about to update from $3000 to $3060, +2%") and front-run with `placeBet(ETH, UP, 100 USDC)` at the pre-push price of $3000. 60 seconds later, the feed shows $3060; the bet wins at 1.76×. This is a riskless trade against the house.

Impact is capped by `maxBet` (default 100 USDC) but at scale — one searcher submitting many bets from many addresses — the house is systematically drained.

**Recommendation**:
- Require `entryPrice` to come from a Chainlink round that is at least `K` seconds old, by checking `block.timestamp - updatedAt >= MIN_PRICE_AGE` (e.g., 15 seconds). This prevents a searcher from betting immediately after a price push they observed.
- Or implement a "commit-reveal" flow: `commitBet(hash)` → wait N blocks → `revealBet(direction, amount, salt)` finalizes at the latest price. This is significantly more complex and changes UX.
- Or reduce `maxBet` until a mitigation is in place.

---

### [M-5] `usdcToken.safeTransferFrom` in `placeBet` before state write — correct CEI but trust issue

**Severity**: Medium
**Category**: erc20 / general
**Location**: `UpDown.sol:182-199`

**Description**: `placeBet` calls `safeTransferFrom(msg.sender, address(this), usdcAmount)` on line 182, *then* writes state (betId, bet struct, increment betCount) on lines 184-197. This is CEI-inverted (interactions-before-effects). USDC on Base is a standard non-reentrant ERC20 — it has no hooks, so reentrancy is not exploitable here. `nonReentrant` also guards the function.

However, any future switch to a token with transfer hooks (USDC upgrade, or if someone forks this for a non-USDC base token) would create a reentrancy surface where the reentrant call sees `betCount` before it was incremented, potentially double-using the same betId slot.

**Recommendation**: Move the state writes **before** the external transfer:
```solidity
betId = betCount;
unchecked { betCount = betId + 1; }
bets[betId] = Bet({...});
emit BetPlaced(...);
usdcToken.safeTransferFrom(msg.sender, address(this), usdcAmount);
```
The existing `nonReentrant` makes this belt-and-suspenders, but CEI is a strong convention — adhere to it.

---

### [M-6] Swap approval reset on exception path can leave unlimited allowance on revert of inner logic

**Severity**: Medium
**Category**: defi-amm / erc20
**Location**: `UpDown.sol:344-365` (`_swapUsdcToClawd`)

**Description**:
```solidity
function _swapUsdcToClawd(uint256 usdcIn, uint256 minClawdOut, address recipient) internal returns (uint256 clawdOut) {
    usdcToken.forceApprove(address(swapRouter), usdcIn);     // 1
    // ... build params
    clawdOut = swapRouter.exactInput(params);                // 2 — external call
    usdcToken.forceApprove(address(swapRouter), 0);          // 3 — reset
}
```
If `exactInput` succeeds but uses less than `usdcIn` (shouldn't happen for V3 exactInput but is possible for exactOutput variants or custom routers), residual allowance equals `usdcIn - actuallyUsed`. Line 3 clears it, so in the success path this is safe.

If `exactInput` reverts, the outer tx reverts and the approval rolls back — safe.

If a future refactor moves the approval reset before the swap or puts the swap inside try/catch without the reset, a stale approval persists. Today this is correct — flagged as Medium to note that the "belt and suspenders" `forceApprove(router, 0)` is load-bearing and must stay.

**Recommendation**: No code change needed, but add a clear comment at the reset line:
```solidity
// MUST remain: clears allowance in case exactInput didn't consume the full amountIn.
// Removing this creates a persistent approval surface if the router is later upgraded.
usdcToken.forceApprove(address(swapRouter), 0);
```

Also consider `SafeERC20.safeApprove(router, 0); safeIncreaseAllowance(router, usdcIn);` to be consistent with classical ERC20 approval-reset patterns, but `forceApprove` is OZ v5's preferred approach for tokens like USDT.

---

### [L-1] Missing `indexed` on `BetSettled` status field

**Severity**: Low
**Category**: general / events
**Location**: `UpDown.sol:110`

**Description**: `BetSettled` does not index `status`. Frontends filtering for won/lost bets must fetch all events and filter client-side.

**Recommendation**:
```solidity
event BetSettled(uint256 indexed betId, BetStatus indexed status, uint256 payoutUsdc, uint256 clawdAmount);
```

---

### [L-2] `cancelExpiredBet` callable by anyone — potential griefing

**Severity**: Low
**Category**: general
**Location**: `UpDown.sol:253-261`

**Description**: Anyone can cancel any bet after `settleAfter + CANCEL_GRACE`. An attacker noticing a bet that would have lost at settle time (using stale oracle data) can wait out the grace period and call `cancelExpiredBet` to refund the player's USDC, flipping a LOSS into a CANCELLED. This denies the house the losing bet.

Mitigated by: it's strictly worse for the attacker than calling `settle()` themselves (if the bet would have lost, calling `settle` makes the house richer; calling `cancelExpiredBet` just wastes gas). So only a malicious actor with a grudge against the protocol would do this.

**Recommendation**: Restrict `cancelExpiredBet` to `msg.sender == b.player` or the owner — it's a refund, only the beneficiary should call it. This eliminates the griefing surface entirely.

---

### [L-3] No event on constructor deployment — harder to index

**Severity**: Low
**Category**: general
**Location**: `UpDown.sol:139-161`

**Description**: No event emitted on deploy. Existing events (`HouseFunded`, `LimitsUpdated`) start firing only after owner actions. Indexing tools must know the deployment block separately.

**Recommendation**: Emit a `Deployed` event or initial `LimitsUpdated` event in the constructor with all immutables and initial limits.

---

### [L-4] USDC blocklist — contract address can be blocklisted

**Severity**: Low
**Category**: erc20
**Location**: `UpDown.sol:155` (USDC interactions throughout)

**Description**: USDC on Base is Circle's standard USDC which supports blocklisting. If the UpDown contract address is ever blocklisted (Circle has blocklisted contract addresses in the past under court orders), all USDC transfers from/to the contract revert — bricking `placeBet`, `settle`, `fundHouse`, `withdrawHouse`, and `cancelExpiredBet`.

No code-level mitigation is possible. Informational + Low-severity because:
- This affects the contract's static USDC dependency (by spec).
- Owner can withdraw non-USDC funds if needed via a rescue pattern, but since only USDC is custodied, there's nothing to rescue.

**Recommendation**: Document this risk in README. Consider adding `rescueTokens(address token, uint256 amount)` for non-USDC/CLAWD tokens accidentally sent.

---

### [L-5] `SETTLE_DELAY = 60` and `CANCEL_GRACE = 300` as constants — inflexible

**Severity**: Low
**Category**: general
**Location**: `UpDown.sol:67-68`

**Description**: Hardcoded `constant`s cannot be adjusted. If Chainlink heartbeats change or Base block times change, these values may need tuning. No immediate problem because spec fixes these values.

**Recommendation**: Leave as-is (spec is explicit) but add a comment that these are spec-fixed.

---

### [I-1] `pragma solidity ^0.8.20` — PUSH0 on Base

**Severity**: Info
**Category**: chain-specific
**Location**: `UpDown.sol:2`

Base supports Shanghai EVM (PUSH0), so `^0.8.20` is fine. Flagged only because the pragma is caret-loose; pinning to a specific Solidity version for reproducible builds is best practice (SE-2 scaffold typically pins).

---

### [I-2] `asset` and `direction` stored as `uint8` but compared against enum cast

**Severity**: Info
**Category**: general
**Location**: `UpDown.sol:55-56`, `UpDown.sol:172-173`, `UpDown.sol:212`, `UpDown.sol:331`

Storing `uint8` in the `Bet` struct for `asset` and `direction` (rather than `enum Asset` and `enum Direction`) saves a small amount of gas but loses type safety. Conversions `uint8(Asset.BTC)` / `uint8(Direction.DOWN)` are correct today but would silently accept any `uint8 < 2` — which is what the bounds checks in `placeBet` enforce. No bug; style note.

---

### [I-3] `unchecked { betCount = betId + 1; }` — confirm overflow impossibility

**Severity**: Info
**Category**: precision-math
**Location**: `UpDown.sol:195-197`

`betCount` is `uint256`. Overflow requires 2^256 bets, which is physically impossible. `unchecked` is safe and saves gas. No action needed.

---

### [I-4] `_getPriceView` duplication

**Severity**: Info
**Category**: general / code quality
**Location**: `UpDown.sol:330-340`

`_getPriceView` wraps `_getPriceInternal` with an `InvalidAsset` check. `placeBet`/`settle` already validate the asset enum before calling `_getPriceInternal`, so `_getPriceView` exists only for the external `getPrice(uint8)` view. Fine, but could be inlined for simplicity.

---

## Cross-Cutting Concerns

1. **Oracle + swap coupling**: Findings [H-1], [H-2], [H-3], [M-4] together describe a layered MEV vulnerability. Fixing any one in isolation still leaves profitable paths. The unified fix is: bind bets to Chainlink rounds (both entry and settle), and use off-chain-signed `minClawdOut` for slippage.
2. **Accounting invariant**: `housePool + pendingBetsUSDC == IERC20(usdc).balanceOf(address(this))` is the invariant the contract should maintain. [C-2] breaks this invariant on every win. After fixing [C-2], consider adding a view `reconcile()` function that asserts this invariant.
3. **Owner rug surface**: [H-4] + [M-3] together give a compromised-owner scenario where the attacker sets payout to near-1x, waits for players to lose, and withdraws. A timelock on `setLimits` (say 24h) would materially reduce this risk.

---

## Recommended Remediation Order (for Stage 4)

1. **[C-1]** — change `BURN_ADDRESS` to `0x000000000000000000000000000000000000dEaD` or equivalent non-zero sink. Blocker.
2. **[C-2]** — add `housePool += b.usdcAmount` on WIN path before deducting payout. Blocker.
3. **[H-1]** — at minimum, stop using `minClawdOut = 1`. Ideally compute off-chain-signed slippage.
4. **[H-2]** — add staleness + round-completeness + L2 sequencer checks.
5. **[H-3]** — require `updatedAt >= b.settleAfter - SETTLE_DELAY` in `settle`.
6. **[H-4]** — add bounds to `setLimits`, snapshot `payoutMultiplierBps` into Bet.
7. **[M-1]** — NatSpec + frontend warning for ties.
8. **[M-2]** — per-player bet index.
9. **[M-3]** — `Ownable2Step`.
10. **[M-4]** — require price age >= 15s at placeBet.
11. **[M-5]** — CEI ordering in `placeBet`.
12. **[M-6]** — add clarifying comment.
13. Low/Info findings — as time permits.

Stage 4 **must** resolve all Critical and High findings before proceeding to Stage 5 (deploy). Medium findings should be addressed but may be waived with client sign-off.

---

## Issues Filed

- `[Critical] CLAWD transfer to address(0) reverts — burn path fails every losing bet` — Finding [C-1]
- `[Critical] Winning bet's USDC becomes untracked and unrecoverable` — Finding [C-2]
- `[High] amountOutMinimum=1 in swaps enables full sandwich attacks` — Finding [H-1]
- `[High] No Chainlink staleness / round-completeness / L2 sequencer checks` — Finding [H-2]
- `[High] Settle can be timed against oracle updates (front-run/back-run)` — Finding [H-3]
- `[High] setLimits can rug players by changing payoutMultiplierBps mid-bet` — Finding [H-4]
- `[Medium] Tie semantics undocumented in NatSpec; ties always LOSE` — Finding [M-1]
- `[Medium] getPendingBets unbounded O(N) loop — frontend DoS at scale` — Finding [M-2]
- `[Medium] Single-step Ownable — use Ownable2Step` — Finding [M-3]
- `[Medium] placeBet vulnerable to Chainlink feed update front-run` — Finding [M-4]
- `[Medium] placeBet violates CEI — transferFrom before state write` — Finding [M-5]
- `[Medium] Swap allowance reset comment clarity` — Finding [M-6]

End of report.

---

## Stage 4 Resolution

Stage 4 applied audit-driven fixes to `packages/foundry/contracts/UpDown.sol` and
`packages/foundry/script/DeployUpDown.s.sol`. `forge build` exits 0 with zero
compiler warnings. All Critical and High findings are resolved; Mediums are
addressed; Lows/Infos — trivial ones fixed, others documented.

### Status per finding

| ID  | Severity | Status | Resolution |
|-----|----------|--------|------------|
| C-1 | Critical | Fixed  | `BURN_ADDRESS` changed from `address(0)` to `0x000000000000000000000000000000000000dEaD`. Comment updated to note OZ v5's receiver check. |
| C-2 | Critical | Fixed  | WIN path now `housePool = housePool + b.usdcAmount - payoutUsdc`. Guarded with `housePool + usdcAmount >= payoutUsdc` to avoid underflow (bet-time pre-check already guarantees this). |
| H-1 | High     | Fixed  | `settle(betId, minPayoutClawd, minBurnClawd)` — caller provides both min-outs. Both are floor-checked via `_requireMinOutFloor(usdcIn, minOut)`, which rejects the degenerate `=1` case at any non-dust bet size. `slippageBps` (default 500) is owner-settable via `setSlippageBps`, bounded by `MAX_SLIPPAGE_BPS = 1000` (10%). |
| H-2 | High     | Fixed  | `_readFeedWithChecks` enforces `answer > 0`, `answeredInRound >= roundId`, `updatedAt != 0`, `block.timestamp - updatedAt <= MAX_PRICE_STALENESS (3600s)`. Optional Base L2 sequencer uptime feed wired in via constructor (address `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` on Base mainnet). Zero address disables the check for test forks. |
| H-3 | High     | Fixed  | `Bet` now stores `entryRoundId`. `settle` requires `roundId > entryRoundId` and `updatedAt >= settleAfter - SETTLE_DELAY`. Searcher cannot pick a pre-settleAfter round to flip the outcome. |
| H-4 | High     | Fixed  | `Bet` snapshots `payoutMultiplierBps` at `placeBet`. `settle` uses the snapshot, so owner changes do not affect pending bets. `setLimits` now bounds `_payoutMultiplierBps` to `[MIN_PAYOUT_BPS=10000, MAX_PAYOUT_BPS=50000]` (1.0x – 5.0x). |
| M-1 | Medium   | Fixed  | Added NatSpec on `settle`: "Ties (currentPrice == entryPrice) resolve as LOST. House wins ties." |
| M-2 | Medium   | Fixed  | Per-player index `_playerBetIds` maintained at `placeBet`. `getPendingBets` now iterates only the player's bets (O(player-bets), not O(N)). Added `getPlayerBetIds(player)` view for full history. |
| M-3 | Medium   | Fixed  | `Ownable` → `Ownable2Step`. Constructor still calls `Ownable(_owner)`, which `Ownable2Step` inherits from. Ownership transfers now require `acceptOwnership` from the new owner. |
| M-4 | Medium   | Fixed  | `placeBet` requires `block.timestamp - updatedAt >= MIN_PRICE_AGE_AT_BET (15s)`. Searcher cannot front-run a mempool-visible Chainlink push and bet at the pre-push price. |
| M-5 | Medium   | Fixed  | `placeBet` writes state and emits `BetPlaced` before calling `safeTransferFrom`. `fundHouse` and `withdrawHouse` likewise reordered to CEI. |
| M-6 | Medium   | Fixed  | Added explicit comment on `forceApprove(router, 0)` at `_swapUsdcToClawd` reset line flagging that the reset is load-bearing. |
| L-1 | Low      | Fixed  | `BetSettled` now has `indexed status`. |
| L-2 | Low      | Fixed  | `cancelExpiredBet` restricted to `msg.sender == b.player || msg.sender == owner()`. Custom error `NotAuthorized`. |
| L-3 | Low      | Fixed  | Added `Deployed` event emitted once from constructor with every external address and initial limit. |
| L-4 | Low      | Accepted | USDC blocklisting is an external risk with no code-level mitigation; documented in the report. Not expected to be actioned for Base mainnet. |
| L-5 | Low      | Deferred | Constants `SETTLE_DELAY` and `CANCEL_GRACE` remain constants per spec; added NatSpec comment. |
| I-1 | Info     | Deferred | Pragma remains `^0.8.20` to match SE-2 scaffold conventions; Foundry compiles with `0.8.30`. Not pinning to avoid a scaffold-wide change. |
| I-2 | Info     | Deferred | `uint8` storage for `asset`/`direction` retained for gas; bounds checks at `placeBet` already enforce valid range. |
| I-3 | Info     | Accepted | `unchecked` block is safe; physical impossibility of overflow. |
| I-4 | Info     | Fixed    | `_getPriceView` removed; `getPrice(uint8)` inlines the asset bounds check and calls `_readFeedWithChecks` directly. |

### Constructor argument change (for Stage 5 deploy)

`UpDown.constructor` now takes an 8th argument: `address _sequencerUptimeFeed`.
`DeployUpDown.s.sol` is updated to pass Base mainnet's sequencer uptime feed at
`0xBCF85224fc0756B9Fa45aA7892530B47e10b6433`. Stage 5 should use the existing
`yarn deploy` command — no broadcast flag changes required.

### API change (for Stage 6 frontend)

`settle(uint256 betId)` → `settle(uint256 betId, uint256 minPayoutClawd, uint256 minBurnClawd)`.
The frontend (or a keeper relayer) must supply non-dust min-outs. Recommended
implementation: call Uniswap V3's `QuoterV2` off-chain for both swap paths
(USDC→WETH→CLAWD for payout; USDC→WETH→CLAWD for burn), apply 5% downward
slack, pass as arguments.

### Build verification

```
$ forge build
Compiling 41 files with Solc 0.8.30
Solc 0.8.30 finished in 459.16ms
Compiler run successful!
```

Zero compiler warnings. Zero errors. Stage 2 baseline parity preserved.

End of Stage 4 Resolution.
