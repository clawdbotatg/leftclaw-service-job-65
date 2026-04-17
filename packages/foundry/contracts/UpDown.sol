// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
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
contract UpDown is Ownable, ReentrancyGuard {
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

    struct Bet {
        uint256 betId;
        address player;
        uint8 asset;
        uint8 direction;
        uint256 usdcAmount;
        int256 entryPrice;
        uint256 settleAfter;
        BetStatus status;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint256 public constant SETTLE_DELAY = 60; // 1 minute
    uint256 public constant CANCEL_GRACE = 300; // extra 5 minutes before cancellable
    uint24 public constant FEE_USDC_WETH = 500; // 0.05%
    uint24 public constant FEE_WETH_CLAWD = 10000; // 1%
    uint256 public constant BPS_DENOM = 10000;
    address public constant BURN_ADDRESS = address(0);

    // ---------------------------------------------------------------------
    // External addresses (immutable once deployed)
    // ---------------------------------------------------------------------

    IERC20 public immutable usdcToken;
    IERC20 public immutable clawdToken;
    address public immutable weth;
    ISwapRouter02 public immutable swapRouter;
    AggregatorV3Interface public immutable ethFeed;
    AggregatorV3Interface public immutable btcFeed;

    // ---------------------------------------------------------------------
    // Game state
    // ---------------------------------------------------------------------

    mapping(uint256 => Bet) public bets;
    uint256 public betCount;
    uint256 public housePool; // USDC available for payouts, 6 decimals

    uint256 public minBet = 1_000_000; // 1 USDC
    uint256 public maxBet = 100_000_000; // 100 USDC
    uint256 public payoutMultiplierBps = 17600; // 1.76x

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event BetPlaced(
        uint256 indexed betId,
        address indexed player,
        uint8 asset,
        uint8 direction,
        uint256 usdcAmount,
        int256 entryPrice
    );

    event BetSettled(uint256 indexed betId, BetStatus status, uint256 payoutUsdc, uint256 clawdAmount);

    event BetCancelled(uint256 indexed betId, address indexed player, uint256 refundedUsdc);

    event HouseFunded(address indexed from, uint256 amount, uint256 newHousePool);
    event HouseWithdrawn(address indexed to, uint256 amount, uint256 newHousePool);
    event LimitsUpdated(uint256 minBet, uint256 maxBet, uint256 payoutMultiplierBps);

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

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(
        address _owner,
        address _usdcToken,
        address _swapRouter,
        address _ethFeed,
        address _btcFeed,
        address _clawdToken,
        address _weth
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
    }

    // ---------------------------------------------------------------------
    // Player actions
    // ---------------------------------------------------------------------

    /// @notice Place a bet on which direction the price moves in 60 seconds.
    /// @param asset 0 = ETH, 1 = BTC
    /// @param direction 0 = UP, 1 = DOWN
    /// @param usdcAmount USDC amount (6 decimals)
    function placeBet(uint8 asset, uint8 direction, uint256 usdcAmount) external nonReentrant returns (uint256 betId) {
        if (asset > uint8(Asset.BTC)) revert InvalidAsset();
        if (direction > uint8(Direction.DOWN)) revert InvalidDirection();
        if (usdcAmount < minBet || usdcAmount > maxBet) revert BetAmountOutOfRange();

        uint256 requiredCover = (usdcAmount * payoutMultiplierBps) / BPS_DENOM;
        if (housePool < requiredCover) revert HousePoolTooSmall();

        int256 entryPrice = _getPriceInternal(asset);

        // Pull USDC from player
        usdcToken.safeTransferFrom(msg.sender, address(this), usdcAmount);

        betId = betCount;
        bets[betId] = Bet({
            betId: betId,
            player: msg.sender,
            asset: asset,
            direction: direction,
            usdcAmount: usdcAmount,
            entryPrice: entryPrice,
            settleAfter: block.timestamp + SETTLE_DELAY,
            status: BetStatus.PENDING
        });
        unchecked {
            betCount = betId + 1;
        }

        emit BetPlaced(betId, msg.sender, asset, direction, usdcAmount, entryPrice);
    }

    /// @notice Settle a pending bet after the 60s window.
    ///         Anyone can call. Winner receives CLAWD. Loser's USDC half-burns CLAWD.
    function settle(uint256 betId) external nonReentrant {
        Bet storage b = bets[betId];
        if (b.status != BetStatus.PENDING) revert BetNotPending();
        if (block.timestamp < b.settleAfter) revert TooEarlyToSettle();

        int256 currentPrice = _getPriceInternal(b.asset);

        bool won;
        if (b.direction == uint8(Direction.UP)) {
            won = currentPrice > b.entryPrice;
        } else {
            won = currentPrice < b.entryPrice;
        }

        if (won) {
            uint256 payoutUsdc = (b.usdcAmount * payoutMultiplierBps) / BPS_DENOM;
            if (payoutUsdc > housePool) revert InsufficientHousePool();

            // Deduct from house. The player's bet USDC stays in the contract but is
            // NOT counted in housePool (it was never added on placeBet).
            housePool -= payoutUsdc;
            b.status = BetStatus.WON;

            // Swap payoutUsdc USDC -> CLAWD, send directly to player.
            uint256 clawdOut = _swapUsdcToClawd(payoutUsdc, 1, b.player);

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
                clawdBurned = _swapUsdcToClawd(burnUsdc, 1, address(this));
                if (clawdBurned > 0) {
                    // Send received CLAWD to address(0) as a burn.
                    clawdToken.safeTransfer(BURN_ADDRESS, clawdBurned);
                }
            }

            emit BetSettled(betId, BetStatus.LOST, 0, clawdBurned);
        }
    }

    /// @notice Refund a stuck bet if settle() wasn't called within the grace period.
    function cancelExpiredBet(uint256 betId) external nonReentrant {
        Bet storage b = bets[betId];
        if (b.status != BetStatus.PENDING) revert BetNotPending();
        if (block.timestamp < b.settleAfter + CANCEL_GRACE) revert TooEarlyToCancel();

        b.status = BetStatus.CANCELLED;
        usdcToken.safeTransfer(b.player, b.usdcAmount);
        emit BetCancelled(betId, b.player, b.usdcAmount);
    }

    // ---------------------------------------------------------------------
    // Owner actions
    // ---------------------------------------------------------------------

    function fundHouse(uint256 amount) external onlyOwner {
        if (amount == 0) revert AmountZero();
        usdcToken.safeTransferFrom(msg.sender, address(this), amount);
        housePool += amount;
        emit HouseFunded(msg.sender, amount, housePool);
    }

    function withdrawHouse(uint256 amount) external onlyOwner {
        if (amount == 0) revert AmountZero();
        if (amount > housePool) revert InsufficientHousePool();
        housePool -= amount;
        usdcToken.safeTransfer(msg.sender, amount);
        emit HouseWithdrawn(msg.sender, amount, housePool);
    }

    function setLimits(uint256 _minBet, uint256 _maxBet, uint256 _payoutMultiplierBps) external onlyOwner {
        if (_minBet == 0 || _maxBet < _minBet) revert InvalidLimits();
        if (_payoutMultiplierBps <= BPS_DENOM) revert InvalidLimits(); // must be > 1x
        minBet = _minBet;
        maxBet = _maxBet;
        payoutMultiplierBps = _payoutMultiplierBps;
        emit LimitsUpdated(_minBet, _maxBet, _payoutMultiplierBps);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Returns the latest Chainlink price for the given asset (8 decimals).
    function getPrice(uint8 asset) external view returns (int256) {
        return _getPriceView(asset);
    }

    /// @notice Returns the IDs of all PENDING bets belonging to `player`.
    function getPendingBets(address player) external view returns (uint256[] memory) {
        uint256 total = betCount;
        uint256 count;
        for (uint256 i = 0; i < total; i++) {
            Bet storage b = bets[i];
            if (b.player == player && b.status == BetStatus.PENDING) {
                count++;
            }
        }
        uint256[] memory ids = new uint256[](count);
        uint256 k;
        for (uint256 i = 0; i < total; i++) {
            Bet storage b = bets[i];
            if (b.player == player && b.status == BetStatus.PENDING) {
                ids[k++] = i;
            }
        }
        return ids;
    }

    /// @notice Read a bet struct (convenience wrapper — public mapping also works).
    function getBet(uint256 betId) external view returns (Bet memory) {
        return bets[betId];
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _getPriceInternal(uint8 asset) internal view returns (int256 price) {
        AggregatorV3Interface feed = asset == uint8(Asset.ETH) ? ethFeed : btcFeed;
        (, int256 answer,,,) = feed.latestRoundData();
        if (answer <= 0) revert InvalidPrice();
        return answer;
    }

    function _getPriceView(uint8 asset) internal view returns (int256 price) {
        if (asset > uint8(Asset.BTC)) revert InvalidAsset();
        return _getPriceInternal(asset);
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

        // Clear any residual approval (belt and suspenders).
        usdcToken.forceApprove(address(swapRouter), 0);
    }
}
