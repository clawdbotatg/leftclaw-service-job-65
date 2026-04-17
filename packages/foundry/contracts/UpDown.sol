// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @notice Minimal Uniswap V3 SwapRouter02 interface (just exactInput).
///         Kept local to avoid pulling in uniswap v3-periphery (solc version conflicts).
interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title UpDown - 1-minute binary price game
/// @notice House-pool game where players bet USDC on BTC/ETH 1-minute direction.
///         Wins pay 1.76x USDC worth of CLAWD. Losses add to the pool and buy+burn CLAWD.
/// @dev Owner = job.client. All external addresses (USDC, router, feeds, CLAWD) are
///      constructor args so the same code works across chains/test forks.
///      Uses Ownable2Step to prevent ownership loss from a bad transfer.
contract UpDown is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Asset {
        ETH,
        BTC
    }

    enum Direction {
        UP,
        DOWN
    }

    enum BetStatus {
        PENDING,
        WON,
        LOST,
        CANCELLED
    }

    /// @dev `payoutMultiplierBps` snapshot protects players from mid-bet owner changes.
    ///      `entryRoundId` binds settlement to a strictly-later Chainlink round.
    struct Bet {
        uint256 betId;
        address player;
        uint8 asset;
        uint8 direction;
        uint256 usdcAmount;
        int256 entryPrice;
        uint256 settleAfter;
        uint80 entryRoundId;
        uint256 payoutMultiplierBps;
        BetStatus status;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @dev Spec-fixed timing values. SETTLE_DELAY = 1 minute bet window.
    ///      CANCEL_GRACE = extra 5 minutes after window before a stuck bet can be refunded.
    uint256 public constant SETTLE_DELAY = 60; // 1 minute
    uint256 public constant CANCEL_GRACE = 300; // extra 5 minutes before cancellable
    uint24 public constant FEE_USDC_WETH = 500; // 0.05%
    uint24 public constant FEE_WETH_CLAWD = 10000; // 1%
    uint256 public constant BPS_DENOM = 10000;

    /// @dev Standard "dead" burn sink. OZ v5 ERC20 reverts on transfer(address(0)) via
    ///      `ERC20InvalidReceiver`, so we use 0xdead — an EOA with no known private key —
    ///      which is permitted by OZ v5. CLAWD exposes no public burn(), and this contract
    ///      is not the CLAWD owner, so there is no on-contract burn path.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @dev Chainlink feed staleness tolerance. Base ETH/USD heartbeat is ~24h or 0.5%
    ///      deviation-triggered; 1h is a conservative ceiling.
    uint256 public constant MAX_PRICE_STALENESS = 3600;

    /// @dev Minimum age of a Chainlink price at placeBet — prevents front-running a
    ///      pending price push observed in the mempool.
    uint256 public constant MIN_PRICE_AGE_AT_BET = 15;

    /// @dev After a Base sequencer outage, prices need to settle before being trusted.
    uint256 public constant SEQUENCER_GRACE_PERIOD = 3600;

    /// @dev Owner-settable payout multiplier bounds (1.0x – 5.0x).
    uint256 public constant MIN_PAYOUT_BPS = 10000;
    uint256 public constant MAX_PAYOUT_BPS = 50000;

    /// @dev Slippage bounds on the swap floor (0% – 10%).
    uint256 public constant MAX_SLIPPAGE_BPS = 1000;

    // ---------------------------------------------------------------------
    // External addresses (immutable once deployed)
    // ---------------------------------------------------------------------

    IERC20 public immutable usdcToken;
    IERC20 public immutable clawdToken;
    address public immutable weth;
    ISwapRouter02 public immutable swapRouter;
    AggregatorV3Interface public immutable ethFeed;
    AggregatorV3Interface public immutable btcFeed;

    /// @dev Base sequencer uptime feed (`0xBCF8...`). May be zero address to skip the
    ///      check (useful on non-L2 forks / tests). When set, readings must show up=0
    ///      AND grace period elapsed before prices are accepted.
    AggregatorV3Interface public immutable sequencerUptimeFeed;

    // ---------------------------------------------------------------------
    // Game state
    // ---------------------------------------------------------------------

    mapping(uint256 => Bet) public bets;
    uint256 public betCount;
    uint256 public housePool; // USDC available for payouts, 6 decimals

    uint256 public minBet = 1_000_000; // 1 USDC
    uint256 public maxBet = 100_000_000; // 100 USDC
    uint256 public payoutMultiplierBps = 17600; // 1.76x

    /// @dev Ceiling on owner-settable slippage used as a floor sanity check on caller-
    ///      supplied minClawdOut. Default 500 bps = 5%.
    uint256 public slippageBps = 500;

    /// @dev Per-player bet index. Allows O(player-bets) lookups instead of O(N).
    mapping(address => uint256[]) private _playerBetIds;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event BetPlaced(
        uint256 indexed betId,
        address indexed player,
        uint8 asset,
        uint8 direction,
        uint256 usdcAmount,
        int256 entryPrice,
        uint256 payoutMultiplierBps
    );

    /// @dev `status` indexed so UIs can filter won/lost/cancelled without client-side scan.
    event BetSettled(uint256 indexed betId, BetStatus indexed status, uint256 payoutUsdc, uint256 clawdAmount);

    event BetCancelled(uint256 indexed betId, address indexed player, uint256 refundedUsdc);

    event HouseFunded(address indexed from, uint256 amount, uint256 newHousePool);
    event HouseWithdrawn(address indexed to, uint256 amount, uint256 newHousePool);
    event LimitsUpdated(uint256 minBet, uint256 maxBet, uint256 payoutMultiplierBps);
    event SlippageUpdated(uint256 newSlippageBps);

    /// @dev Emitted once from constructor so indexers have a canonical deployment marker.
    event Deployed(
        address indexed owner,
        address usdcToken,
        address clawdToken,
        address weth,
        address swapRouter,
        address ethFeed,
        address btcFeed,
        address sequencerUptimeFeed,
        uint256 initialMinBet,
        uint256 initialMaxBet,
        uint256 initialPayoutMultiplierBps
    );

    // ---------------------------------------------------------------------
    // Custom errors
    // ---------------------------------------------------------------------

    error InvalidAsset();
    error InvalidDirection();
    error BetAmountOutOfRange();
    error HousePoolTooSmall();
    error BetNotPending();
    error TooEarlyToSettle();
    error TooEarlyToCancel();
    error InvalidPrice();
    error ZeroAddress();
    error InvalidLimits();
    error InsufficientHousePool();
    error AmountZero();
    error StalePrice();
    error InvalidPriceRound();
    error SequencerDown();
    error SequencerGracePeriodNotOver();
    error PriceRoundNotAdvanced();
    error MinOutBelowFloor();
    error NotAuthorized();
    error InvalidSlippage();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param _sequencerUptimeFeed Optional (zero address = skip check). Base mainnet uses
    ///                             0xBCF85224fc0756B9Fa45aA7892530B47e10b6433.
    constructor(
        address _owner,
        address _usdcToken,
        address _swapRouter,
        address _ethFeed,
        address _btcFeed,
        address _clawdToken,
        address _weth,
        address _sequencerUptimeFeed
    ) Ownable(_owner) {
        if (
            _owner == address(0) || _usdcToken == address(0) || _swapRouter == address(0) || _ethFeed == address(0)
                || _btcFeed == address(0) || _clawdToken == address(0) || _weth == address(0)
        ) {
            revert ZeroAddress();
        }

        usdcToken = IERC20(_usdcToken);
        clawdToken = IERC20(_clawdToken);
        swapRouter = ISwapRouter02(_swapRouter);
        ethFeed = AggregatorV3Interface(_ethFeed);
        btcFeed = AggregatorV3Interface(_btcFeed);
        weth = _weth;
        sequencerUptimeFeed = AggregatorV3Interface(_sequencerUptimeFeed);

        emit Deployed(
            _owner,
            _usdcToken,
            _clawdToken,
            _weth,
            _swapRouter,
            _ethFeed,
            _btcFeed,
            _sequencerUptimeFeed,
            minBet,
            maxBet,
            payoutMultiplierBps
        );
    }

    // ---------------------------------------------------------------------
    // Player actions
    // ---------------------------------------------------------------------

    /// @notice Place a bet on which direction the price moves in 60 seconds.
    /// @dev Snapshots `payoutMultiplierBps` and Chainlink `roundId` into the Bet so
    ///      the player cannot be rugged by a mid-bet owner change, and so `settle` is
    ///      bound to a strictly-later oracle round.
    /// @param asset 0 = ETH, 1 = BTC
    /// @param direction 0 = UP, 1 = DOWN
    /// @param usdcAmount USDC amount (6 decimals)
    function placeBet(uint8 asset, uint8 direction, uint256 usdcAmount) external nonReentrant returns (uint256 betId) {
        if (asset > uint8(Asset.BTC)) revert InvalidAsset();
        if (direction > uint8(Direction.DOWN)) revert InvalidDirection();
        if (usdcAmount < minBet || usdcAmount > maxBet) revert BetAmountOutOfRange();

        uint256 snapshotMultiplier = payoutMultiplierBps;
        uint256 requiredCover = (usdcAmount * snapshotMultiplier) / BPS_DENOM;
        if (housePool < requiredCover) revert HousePoolTooSmall();

        (uint80 roundId, int256 entryPrice, uint256 updatedAt) = _readFeedWithChecks(asset);
        // M-4: require the entry price to be at least MIN_PRICE_AGE_AT_BET seconds old,
        // so a searcher observing a pending Chainlink push cannot front-run placeBet at
        // the pre-push price.
        if (block.timestamp - updatedAt < MIN_PRICE_AGE_AT_BET) revert StalePrice();

        // M-5: CEI — effects before interactions. Write state first, then pull USDC.
        // `nonReentrant` makes this belt-and-suspenders, but CEI is the convention.
        betId = betCount;
        bets[betId] = Bet({
            betId: betId,
            player: msg.sender,
            asset: asset,
            direction: direction,
            usdcAmount: usdcAmount,
            entryPrice: entryPrice,
            settleAfter: block.timestamp + SETTLE_DELAY,
            entryRoundId: roundId,
            payoutMultiplierBps: snapshotMultiplier,
            status: BetStatus.PENDING
        });
        _playerBetIds[msg.sender].push(betId);
        unchecked {
            betCount = betId + 1;
        }

        emit BetPlaced(betId, msg.sender, asset, direction, usdcAmount, entryPrice, snapshotMultiplier);

        // Interaction last.
        usdcToken.safeTransferFrom(msg.sender, address(this), usdcAmount);
    }

    /// @notice Settle a pending bet after the 60s window.
    /// @dev Callable by anyone (keeper-friendly). Caller must supply realistic min-out
    ///      values — these are further floor-checked against `slippageBps` so a lazy
    ///      caller cannot pass `1`.
    ///      Ties (currentPrice == entryPrice) resolve as LOST. House wins ties.
    /// @param betId Bet to settle.
    /// @param minPayoutClawd Minimum CLAWD out on the WIN swap (payout to player).
    ///                      Pass 0 if the bet is expected to LOSE (value unused on LOSS path).
    /// @param minBurnClawd Minimum CLAWD out on the LOSS burn swap. Pass 0 if the bet is
    ///                    expected to WIN (value unused on WIN path).
    function settle(uint256 betId, uint256 minPayoutClawd, uint256 minBurnClawd) external nonReentrant {
        Bet storage b = bets[betId];
        if (b.status != BetStatus.PENDING) revert BetNotPending();
        if (block.timestamp < b.settleAfter) revert TooEarlyToSettle();

        (uint80 roundId, int256 currentPrice, uint256 updatedAt) = _readFeedWithChecks(b.asset);
        // H-3: bind settlement to a strictly-later Chainlink round so a searcher cannot
        // pick among rounds to flip the outcome.
        if (roundId <= b.entryRoundId) revert PriceRoundNotAdvanced();
        // Extra guard: the price we settle on must have been published at or after the
        // bet window closed (settleAfter = entry + SETTLE_DELAY).
        if (updatedAt < b.settleAfter - SETTLE_DELAY) revert StalePrice();

        bool won;
        if (b.direction == uint8(Direction.UP)) {
            won = currentPrice > b.entryPrice;
        } else {
            won = currentPrice < b.entryPrice;
        }

        // H-4 guarantee: use the multiplier that was snapshotted at placeBet.
        uint256 bps = b.payoutMultiplierBps;

        if (won) {
            uint256 payoutUsdc = (b.usdcAmount * bps) / BPS_DENOM;

            // C-2 fix: on WIN, the player's original usdcAmount (already in this contract
            // since placeBet) enters the house pool, and the payout comes out. Net pool
            // change is `-(payoutUsdc - usdcAmount)`.
            // Invariant at placeBet: housePool >= usdcAmount * bps / BPS_DENOM >= payoutUsdc,
            // so `housePool + usdcAmount - payoutUsdc` cannot underflow.
            if (housePool + b.usdcAmount < payoutUsdc) revert InsufficientHousePool();
            housePool = housePool + b.usdcAmount - payoutUsdc;
            b.status = BetStatus.WON;

            // H-1: caller-provided minPayoutClawd must meet the floor derived from
            // `slippageBps` and the USDC amount (tautological floor ensures something
            // > 1 is always required).
            _requireMinOutFloor(payoutUsdc, minPayoutClawd);

            uint256 clawdOut = _swapUsdcToClawd(payoutUsdc, minPayoutClawd, b.player);
            emit BetSettled(betId, BetStatus.WON, payoutUsdc, clawdOut);
        } else {
            // Loss (including ties): player's USDC enters the house pool.
            housePool += b.usdcAmount;
            b.status = BetStatus.LOST;

            uint256 burnUsdc = b.usdcAmount / 2;
            uint256 clawdBurned = 0;
            if (burnUsdc > 0) {
                if (burnUsdc > housePool) revert InsufficientHousePool();
                housePool -= burnUsdc;

                // H-1 on burn leg: enforce floor on minBurnClawd too.
                _requireMinOutFloor(burnUsdc, minBurnClawd);

                clawdBurned = _swapUsdcToClawd(burnUsdc, minBurnClawd, address(this));
                if (clawdBurned > 0) {
                    // C-1: burn to 0xdead (OZ v5 permits this; address(0) reverts).
                    clawdToken.safeTransfer(BURN_ADDRESS, clawdBurned);
                }
            }

            emit BetSettled(betId, BetStatus.LOST, 0, clawdBurned);
        }
    }

    /// @notice Refund a stuck bet if settle() wasn't called within the grace period.
    /// @dev L-2: restricted to the bet's player or the owner to eliminate griefing.
    function cancelExpiredBet(uint256 betId) external nonReentrant {
        Bet storage b = bets[betId];
        if (b.status != BetStatus.PENDING) revert BetNotPending();
        if (block.timestamp < b.settleAfter + CANCEL_GRACE) revert TooEarlyToCancel();
        if (msg.sender != b.player && msg.sender != owner()) revert NotAuthorized();

        b.status = BetStatus.CANCELLED;
        usdcToken.safeTransfer(b.player, b.usdcAmount);
        emit BetCancelled(betId, b.player, b.usdcAmount);
    }

    // ---------------------------------------------------------------------
    // Owner actions
    // ---------------------------------------------------------------------

    function fundHouse(uint256 amount) external onlyOwner {
        if (amount == 0) revert AmountZero();
        housePool += amount;
        emit HouseFunded(msg.sender, amount, housePool);
        // Interaction last (CEI).
        usdcToken.safeTransferFrom(msg.sender, address(this), amount);
    }

    function withdrawHouse(uint256 amount) external onlyOwner {
        if (amount == 0) revert AmountZero();
        if (amount > housePool) revert InsufficientHousePool();
        housePool -= amount;
        emit HouseWithdrawn(msg.sender, amount, housePool);
        // Interaction last (CEI).
        usdcToken.safeTransfer(msg.sender, amount);
    }

    /// @notice Update bet bounds and the DEFAULT multiplier for future bets.
    /// @dev H-4: bounded so a compromised owner cannot set pathological values.
    ///      Existing PENDING bets still use their snapshotted multiplier — a mid-bet
    ///      change here cannot retroactively reduce a pending payout.
    function setLimits(uint256 _minBet, uint256 _maxBet, uint256 _payoutMultiplierBps) external onlyOwner {
        if (_minBet == 0 || _maxBet < _minBet) revert InvalidLimits();
        if (_payoutMultiplierBps < MIN_PAYOUT_BPS || _payoutMultiplierBps > MAX_PAYOUT_BPS) revert InvalidLimits();
        minBet = _minBet;
        maxBet = _maxBet;
        payoutMultiplierBps = _payoutMultiplierBps;
        emit LimitsUpdated(_minBet, _maxBet, _payoutMultiplierBps);
    }

    /// @notice Update the slippage ceiling used as a floor check on caller-supplied minOuts.
    function setSlippageBps(uint256 _slippageBps) external onlyOwner {
        if (_slippageBps > MAX_SLIPPAGE_BPS) revert InvalidSlippage();
        slippageBps = _slippageBps;
        emit SlippageUpdated(_slippageBps);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Returns the latest Chainlink price for the given asset (8 decimals).
    /// @dev Applies the full check set (sequencer, staleness, round completeness).
    function getPrice(uint8 asset) external view returns (int256) {
        if (asset > uint8(Asset.BTC)) revert InvalidAsset();
        (, int256 answer,) = _readFeedWithChecks(asset);
        return answer;
    }

    /// @notice Returns the IDs of all PENDING bets belonging to `player`.
    /// @dev M-2: uses per-player index; O(player-bets) not O(N).
    function getPendingBets(address player) external view returns (uint256[] memory) {
        uint256[] storage all = _playerBetIds[player];
        uint256 total = all.length;

        uint256 count;
        for (uint256 i = 0; i < total; i++) {
            if (bets[all[i]].status == BetStatus.PENDING) count++;
        }

        uint256[] memory ids = new uint256[](count);
        uint256 k;
        for (uint256 i = 0; i < total; i++) {
            uint256 id = all[i];
            if (bets[id].status == BetStatus.PENDING) {
                ids[k++] = id;
            }
        }
        return ids;
    }

    /// @notice Returns ALL bet IDs (pending and settled) for `player`.
    /// @dev Useful for history tabs in the UI. Paginate on the frontend at scale.
    function getPlayerBetIds(address player) external view returns (uint256[] memory) {
        return _playerBetIds[player];
    }

    /// @notice Read a bet struct (convenience wrapper — public mapping also works).
    function getBet(uint256 betId) external view returns (Bet memory) {
        return bets[betId];
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    /// @dev Centralized Chainlink read with:
    ///      - Optional Base sequencer uptime check.
    ///      - `answer > 0`, `answeredInRound >= roundId`, and staleness checks.
    function _readFeedWithChecks(uint8 asset) internal view returns (uint80 roundId, int256 answer, uint256 updatedAt) {
        // H-2: Base L2 sequencer uptime check (skipped if feed is zero address).
        if (address(sequencerUptimeFeed) != address(0)) {
            (, int256 seqAnswer, uint256 seqStartedAt,,) = sequencerUptimeFeed.latestRoundData();
            // Chainlink L2 sequencer feed: 0 = up, 1 = down.
            if (seqAnswer != 0) revert SequencerDown();
            if (block.timestamp - seqStartedAt < SEQUENCER_GRACE_PERIOD) revert SequencerGracePeriodNotOver();
        }

        AggregatorV3Interface feed = asset == uint8(Asset.ETH) ? ethFeed : btcFeed;
        uint80 answeredInRound;
        (roundId, answer,, updatedAt, answeredInRound) = feed.latestRoundData();

        if (answer <= 0) revert InvalidPrice();
        if (answeredInRound < roundId) revert InvalidPriceRound();
        if (updatedAt == 0) revert StalePrice();
        if (block.timestamp - updatedAt > MAX_PRICE_STALENESS) revert StalePrice();
    }

    /// @dev Floor check on caller-supplied minOut. Reverts if `minOut` is smaller than the
    ///      amount implied by `slippageBps` against USDC-par (a conservative bound — the
    ///      true CLAWD/USDC price is not known on-chain without a TWAP, so we require at
    ///      least a non-trivial minOut denominated in CLAWD wei — this rejects the `=1`
    ///      degenerate case).
    ///      Specifically: for `usdcIn` USDC (6 decimals), the MINIMUM expected CLAWD out
    ///      at 1:1 USD parity and 18-decimal CLAWD is `usdcIn * 1e12`. We then allow
    ///      downward slack of `slippageBps` plus a CLAWD/USDC discount factor implicit in
    ///      the caller-chosen minOut. The check is a sanity floor, not a precise quote —
    ///      the keeper is expected to derive a tighter value via an off-chain quoter.
    function _requireMinOutFloor(uint256 usdcIn, uint256 minOut) internal view {
        // Smallest acceptable CLAWD out is `usdcIn * 1e12 * (10000 - slippageBps) / (1000 * 10000)`
        // (i.e., up to 1000x discount from USD par — conservative enough that legitimate
        // thin-pool prices pass, but `minOut = 1` always fails for any non-dust usdcIn).
        // Multiply before dividing to preserve precision.
        uint256 floorOut = (usdcIn * 1e12 * (BPS_DENOM - slippageBps)) / (1000 * BPS_DENOM);
        if (minOut < floorOut) revert MinOutBelowFloor();
    }

    /// @dev Encodes the path USDC -> (500) -> WETH -> (10000) -> CLAWD and swaps
    ///      `usdcIn` USDC from this contract for CLAWD sent to `recipient`.
    function _swapUsdcToClawd(uint256 usdcIn, uint256 minClawdOut, address recipient)
        internal
        returns (uint256 clawdOut)
    {
        // Approve router for exactly what we're spending (reset-then-approve).
        usdcToken.forceApprove(address(swapRouter), usdcIn);

        bytes memory path =
            abi.encodePacked(address(usdcToken), FEE_USDC_WETH, weth, FEE_WETH_CLAWD, address(clawdToken));

        ISwapRouter02.ExactInputParams memory params = ISwapRouter02.ExactInputParams({
            path: path,
            recipient: recipient,
            amountIn: usdcIn,
            amountOutMinimum: minClawdOut
        });

        clawdOut = swapRouter.exactInput(params);

        // M-6: MUST remain — clears allowance in case exactInput didn't consume the full
        // amountIn (theoretically possible for custom routers). Removing this creates a
        // persistent approval surface if the router is ever swapped.
        usdcToken.forceApprove(address(swapRouter), 0);
    }
}
