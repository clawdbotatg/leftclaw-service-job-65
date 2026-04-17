import { formatUnits } from "viem";

// Chainlink ETH/USD and BTC/USD feeds on Base are 8-decimal.
export const CHAINLINK_DECIMALS = 8;
export const USDC_DECIMALS = 6;
export const CLAWD_DECIMALS = 18;

/**
 * Format a Chainlink price (int256, 8 decimals) to a USD string with
 * commas. Handles negative values defensively (shouldn't happen on
 * price feeds we read but the type is `int256`).
 */
export const formatPrice = (price: bigint | undefined | null, fractionDigits = 2): string => {
  if (price === undefined || price === null) return "—";
  const n = Number(formatUnits(price < 0n ? -price : price, CHAINLINK_DECIMALS));
  const sign = price < 0n ? "-" : "";
  return (
    sign +
    n.toLocaleString(undefined, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    })
  );
};

/**
 * Format a USDC amount (6 decimals). `$1,234.56` shape.
 */
export const formatUsdc = (amount: bigint | undefined | null, fractionDigits = 2): string => {
  if (amount === undefined || amount === null) return "—";
  const n = Number(formatUnits(amount, USDC_DECIMALS));
  return n.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
};

/**
 * Format a CLAWD (18-decimal) amount with a compact, reader-friendly
 * shape. Adds k/M suffixes once we cross 10_000 CLAWD.
 */
export const formatClawd = (amount: bigint | undefined | null): string => {
  if (amount === undefined || amount === null) return "—";
  const n = Number(formatUnits(amount, CLAWD_DECIMALS));
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 10_000) return (n / 1_000).toFixed(2) + "k";
  if (n >= 1) return n.toFixed(2);
  if (n > 0) return n.toPrecision(3);
  return "0";
};

/**
 * seconds -> "0:45" mm:ss (bounded to 0 minimum).
 */
export const formatCountdown = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

export const ASSET_LABEL = ["ETH", "BTC"] as const;
export const DIRECTION_LABEL = ["UP", "DOWN"] as const;
export const BET_STATUS = ["PENDING", "WON", "LOST", "CANCELLED"] as const;

/**
 * Best-effort mapping of known error strings to player-facing messages.
 * The scaffold's getParsedError runs first; this is a fallback and an
 * override for a couple of cases where the raw selector wording is
 * unhelpful.
 */
export const KNOWN_ERROR_MESSAGES: Record<string, string> = {
  HousePoolTooSmall:
    "The house pool isn't large enough to cover this bet yet. Try a smaller amount or wait for the owner to fund.",
  BetAmountOutOfRange: "Bet must be between the current min and max (default 1–100 USDC).",
  InvalidAsset: "Pick ETH or BTC.",
  InvalidDirection: "Pick UP or DOWN.",
  StalePrice: "The price feed hasn't ticked recently. Try again in a few seconds.",
  InvalidPrice: "Price feed returned an invalid value. Try again shortly.",
  PriceRoundNotAdvanced: "Settlement needs a fresh Chainlink round. Wait a few seconds and retry.",
  TooEarlyToSettle: "This bet's 60-second window hasn't closed yet.",
  TooEarlyToCancel: "Cancel is only available after 5 minutes past settle time.",
  BetNotPending: "This bet has already been settled or cancelled.",
  NotAuthorized: "Only the player who placed this bet (or the owner) can cancel it.",
  SequencerDown: "The Base sequencer is currently down. Wait for it to recover.",
  SequencerGracePeriodNotOver: "Base sequencer just restarted. Wait an hour for prices to be trusted.",
  MinOutBelowFloor: "The min-out is too low. Try increasing slippage tolerance.",
  ERC20InsufficientAllowance: "You need to approve USDC first (click Approve).",
  ERC20InsufficientBalance: "Not enough USDC in your wallet.",
  // OZ v5's SafeERC20 wraps the underlying ERC20 custom error into this one.
  // When a user lacks allowance or balance on placeBet/fundHouse, this is what
  // actually surfaces — map it so users don't see the raw selector.
  SafeERC20FailedOperation:
    "USDC transfer failed — check that you have enough USDC and that you've approved the contract.",
  ERC20InvalidReceiver: "Invalid USDC receiver address.",
  ERC20InvalidSender: "Invalid USDC sender address.",
  ERC20InvalidSpender: "Invalid USDC spender address.",
  ERC20InvalidApprover: "Invalid USDC approver address.",
};
