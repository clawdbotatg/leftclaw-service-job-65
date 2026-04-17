// Uniswap V3 QuoterV2 helpers — we simulate the same USDC->WETH->CLAWD path
// the UpDown contract uses at settle time, so we can derive a realistic
// min-out to pass into settle() with 5% slippage.
//
// Path encoding mirrors `abi.encodePacked(USDC, uint24(500), WETH, uint24(10000), CLAWD)`
// on-chain. viem's `encodePacked` matches Solidity's encoding.
import { type PublicClient, encodePacked } from "viem";

export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const;
export const CLAWD_ADDRESS = "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07" as const;
export const QUOTER_V2_ADDRESS = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as const;

export const FEE_USDC_WETH = 500;
export const FEE_WETH_CLAWD = 10000;

export const SLIPPAGE_BPS = 500n; // 5%
export const BPS_DENOM = 10000n;

export const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInput",
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * Build the packed USDC -> WETH -> CLAWD path for Uniswap V3 multi-hop.
 */
export const buildUsdcToClawdPath = (): `0x${string}` =>
  encodePacked(
    ["address", "uint24", "address", "uint24", "address"],
    [USDC_ADDRESS, FEE_USDC_WETH, WETH_ADDRESS, FEE_WETH_CLAWD, CLAWD_ADDRESS],
  );

/**
 * Off-chain quote of CLAWD received for `usdcIn` USDC (6 decimals).
 * Uses `simulateContract` — QuoterV2 is state-changing in signature but
 * reverts in simulation mode with the amountOut, and viem decodes both.
 * Returns `amountOut` (CLAWD wei, 18 decimals).
 */
export const quoteUsdcToClawd = async (publicClient: PublicClient, usdcIn: bigint): Promise<bigint> => {
  const path = buildUsdcToClawdPath();
  const { result } = await publicClient.simulateContract({
    address: QUOTER_V2_ADDRESS,
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInput",
    args: [path, usdcIn],
  });
  // `result` is the tuple [amountOut, ...]
  return result[0] as bigint;
};

/**
 * Apply the 5% slippage floor: (amountOut * 9500) / 10000.
 */
export const applySlippage = (amountOut: bigint): bigint => (amountOut * (BPS_DENOM - SLIPPAGE_BPS)) / BPS_DENOM;
