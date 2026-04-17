"use client";

import { useMemo, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits, parseUnits } from "viem";
import { useAccount, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { useScaffoldContract, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useWriteAndOpen } from "~~/hooks/updown/useWriteAndOpen";
import scaffoldConfig from "~~/scaffold.config";
import { notification } from "~~/utils/scaffold-eth";
import { getParsedError } from "~~/utils/scaffold-eth";
import { ASSET_LABEL, KNOWN_ERROR_MESSAGES, USDC_DECIMALS, formatUsdc } from "~~/utils/updown/format";
import { USDC_ADDRESS } from "~~/utils/updown/quoter";

// Minimal USDC ABI for allowance/approve. We go through wagmi directly here
// (rather than a scaffold external-contract hook) so that nothing else in the
// app needs to know about USDC at all.
const USDC_ABI = [
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const TARGET_CHAIN_ID = scaffoldConfig.targetNetworks[0].id;

type BettingPanelProps = {
  asset: 0 | 1;
  direction: 0 | 1;
  betUsdc: number;
  setAsset: (a: 0 | 1) => void;
  setDirection: (d: 0 | 1) => void;
  setBetUsdc: (v: number) => void;
};

/**
 * 4-state action flow:
 *   1. Not connected   -> Connect Wallet
 *   2. Wrong network   -> Switch to Base
 *   3. Needs approval  -> Approve USDC
 *   4. Ready           -> Place Bet
 *
 * Only one primary action is shown at a time. `approveSubmitting` covers the
 * wallet->tx-hash gap; `approveCooldown` covers the confirmation->cache-refresh
 * gap (allowance query takes a beat to settle).
 */
export const BettingPanel = ({ asset, direction, betUsdc, setAsset, setDirection, setBetUsdc }: BettingPanelProps) => {
  const { address, chain, isConnected } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { openConnectModal } = useConnectModal();

  const usdcAmount = parseUnits(betUsdc.toString(), USDC_DECIMALS);

  // --- Reads ---------------------------------------------------------------

  const { data: deployedContract } = useScaffoldContract({ contractName: "UpDown" });
  const upDownAddress = deployedContract?.address;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    abi: USDC_ABI,
    address: USDC_ADDRESS,
    functionName: "allowance",
    args: address && upDownAddress ? [address, upDownAddress] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: {
      enabled: Boolean(address && upDownAddress && isConnected && chain?.id === TARGET_CHAIN_ID),
      refetchInterval: 5000,
    },
  });

  const { data: usdcBalance } = useReadContract({
    abi: USDC_ABI,
    address: USDC_ADDRESS,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: {
      enabled: Boolean(address && isConnected && chain?.id === TARGET_CHAIN_ID),
      refetchInterval: 5000,
    },
  });

  const { data: housePool } = useScaffoldReadContract({
    contractName: "UpDown",
    functionName: "housePool",
    watch: true,
  });

  const { data: payoutMultiplierBps } = useScaffoldReadContract({
    contractName: "UpDown",
    functionName: "payoutMultiplierBps",
  });

  // --- Write hooks ---------------------------------------------------------

  const { writeContractAsync: writeUsdc } = useWriteContract();
  const { writeContractAsync: writeUpDown, isMining: isBetting } = useScaffoldWriteContract({
    contractName: "UpDown",
  });
  const { writeAndOpen } = useWriteAndOpen();

  // --- Approval pending/cooldown state -------------------------------------

  const [approveSubmitting, setApproveSubmitting] = useState(false);
  const [approveCooldown, setApproveCooldown] = useState(false);

  // Drop the cooldown a few seconds after the approval hash lands, so the
  // allowance cache has a window to refresh before we re-enable anything.
  const startApproveCooldown = () => {
    setApproveCooldown(true);
    setTimeout(() => {
      setApproveCooldown(false);
      void refetchAllowance();
    }, 4000);
  };

  // --- Derived button state ------------------------------------------------

  const hasAllowance = allowance !== undefined && (allowance as bigint) >= usdcAmount;
  const hasBalance = usdcBalance !== undefined && (usdcBalance as bigint) >= usdcAmount;

  const bps = (payoutMultiplierBps as bigint | undefined) ?? 17600n;
  const requiredCover = (usdcAmount * bps) / 10000n;
  const poolCoversBet = housePool !== undefined ? (housePool as bigint) >= requiredCover : false;

  const stepLabel = useMemo(() => {
    if (!isConnected) return "connect";
    if (chain?.id !== TARGET_CHAIN_ID) return "switch";
    if (!hasBalance) return "nobalance";
    if (!poolCoversBet) return "nohouse";
    if (!hasAllowance) return "approve";
    return "bet";
  }, [isConnected, chain?.id, hasAllowance, hasBalance, poolCoversBet]);

  // --- Potential payout (display only) -------------------------------------

  const potentialPayoutUsdc = (usdcAmount * bps) / 10000n;

  // --- Handlers ------------------------------------------------------------

  const handleApprove = async () => {
    if (!upDownAddress) return;
    setApproveSubmitting(true);
    try {
      // writeAndOpen wraps the write so that on mobile we nudge the wallet app
      // open ~2s after the request is sent (WC v2 won't auto-open the wallet).
      await writeAndOpen(() =>
        writeUsdc({
          abi: USDC_ABI,
          address: USDC_ADDRESS,
          functionName: "approve",
          args: [upDownAddress, usdcAmount],
        }),
      );
      notification.success("USDC approval submitted");
      startApproveCooldown();
    } catch (e) {
      notification.error(prettifyError(e));
    } finally {
      // ALWAYS release, even on reject — otherwise a canceled tx locks the UI.
      setApproveSubmitting(false);
    }
  };

  const handlePlaceBet = async () => {
    try {
      await writeAndOpen(() =>
        writeUpDown({
          functionName: "placeBet",
          args: [asset, direction, usdcAmount],
        }),
      );
      notification.success(`${ASSET_LABEL[asset]} ${direction === 0 ? "UP" : "DOWN"} bet placed — settle in 60s`);
    } catch (e) {
      notification.error(prettifyError(e));
    }
  };

  // --- Render --------------------------------------------------------------

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body gap-4">
        <h2 className="card-title">Place a bet</h2>

        {/* Asset selector */}
        <div className="flex gap-2">
          {[0, 1].map(i => (
            <button
              key={i}
              className={`btn btn-sm flex-1 ${asset === i ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setAsset(i as 0 | 1)}
              disabled={isBetting || approveSubmitting}
            >
              {ASSET_LABEL[i]}
            </button>
          ))}
        </div>

        {/* Bet amount slider */}
        <div className="flex flex-col gap-1">
          <div className="flex justify-between items-center">
            <span className="text-sm opacity-70">Bet amount</span>
            <span className="font-mono">
              {betUsdc} USDC <span className="opacity-60 text-xs">(~${betUsdc.toFixed(2)})</span>
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            step={1}
            value={betUsdc}
            onChange={e => setBetUsdc(Number(e.target.value))}
            className="range range-primary range-sm"
            disabled={isBetting || approveSubmitting}
          />
          <div className="flex justify-between text-xs opacity-50">
            <span>1 USDC</span>
            <span>100 USDC</span>
          </div>
        </div>

        {/* Direction */}
        <div className="grid grid-cols-2 gap-3">
          <button
            className={`btn btn-lg ${direction === 0 ? "btn-success" : "btn-outline btn-success"}`}
            onClick={() => setDirection(0)}
            disabled={isBetting || approveSubmitting}
          >
            ▲ UP
          </button>
          <button
            className={`btn btn-lg ${direction === 1 ? "btn-error" : "btn-outline btn-error"}`}
            onClick={() => setDirection(1)}
            disabled={isBetting || approveSubmitting}
          >
            ▼ DOWN
          </button>
        </div>

        {/* Potential payout */}
        <div className="p-3 bg-base-200 rounded-box">
          <div className="flex justify-between text-sm">
            <span className="opacity-70">You stake</span>
            <span className="font-mono">
              {betUsdc} USDC (~${betUsdc.toFixed(2)})
            </span>
          </div>
          <div className="flex justify-between text-sm mt-1">
            <span className="opacity-70">You win (if right)</span>
            <span className="font-mono text-success">
              {formatUsdc(potentialPayoutUsdc)} USDC <span className="opacity-60">(≈ in CLAWD at settle)</span>
            </span>
          </div>
          <div className="flex justify-between text-sm mt-1">
            <span className="opacity-70">You lose (if wrong)</span>
            <span className="font-mono text-error">-{betUsdc} USDC</span>
          </div>
        </div>

        {/* Primary action — one at a time */}
        <PrimaryAction
          step={stepLabel}
          onConnect={() => openConnectModal?.()}
          onSwitch={() => switchChain({ chainId: TARGET_CHAIN_ID })}
          onApprove={handleApprove}
          onBet={handlePlaceBet}
          isSwitching={isSwitching}
          isApproving={approveSubmitting || approveCooldown}
          isBetting={isBetting}
        />

        {/* House-pool warning */}
        {isConnected && chain?.id === TARGET_CHAIN_ID && !poolCoversBet && (
          <div className="alert alert-warning text-xs">
            The house pool is not yet funded by the owner (pool needs ≥ {formatUsdc(requiredCover)} USDC to cover this
            bet). Try a smaller amount, or wait for the owner to fund. Current pool:{" "}
            <span className="font-mono">{formatUsdc(housePool as bigint | undefined)} USDC</span>.
          </div>
        )}

        {/* Balance helper */}
        {isConnected && chain?.id === TARGET_CHAIN_ID && !hasBalance && (
          <div className="alert alert-info text-xs">
            Wallet USDC balance:{" "}
            <span className="font-mono">
              {usdcBalance !== undefined ? Number(formatUnits(usdcBalance as bigint, USDC_DECIMALS)).toFixed(2) : "—"}{" "}
              USDC
            </span>{" "}
            — not enough for this bet.
          </div>
        )}
      </div>
    </div>
  );
};

const PrimaryAction = ({
  step,
  onConnect,
  onSwitch,
  onApprove,
  onBet,
  isSwitching,
  isApproving,
  isBetting,
}: {
  step: string;
  onConnect: () => void;
  onSwitch: () => void;
  onApprove: () => void;
  onBet: () => void;
  isSwitching: boolean;
  isApproving: boolean;
  isBetting: boolean;
}) => {
  if (step === "connect") {
    return (
      <button className="btn btn-primary btn-lg w-full" onClick={onConnect}>
        Connect Wallet
      </button>
    );
  }
  if (step === "switch") {
    return (
      <button className="btn btn-warning btn-lg w-full" onClick={onSwitch} disabled={isSwitching}>
        {isSwitching ? (
          <>
            <span className="loading loading-spinner loading-sm" /> Switching…
          </>
        ) : (
          "Switch to Base"
        )}
      </button>
    );
  }
  if (step === "nobalance") {
    return (
      <button className="btn btn-disabled btn-lg w-full" disabled>
        Insufficient USDC balance
      </button>
    );
  }
  if (step === "nohouse") {
    return (
      <button className="btn btn-disabled btn-lg w-full" disabled>
        House pool too small for this bet
      </button>
    );
  }
  if (step === "approve") {
    return (
      <button className="btn btn-primary btn-lg w-full" onClick={onApprove} disabled={isApproving}>
        {isApproving ? (
          <>
            <span className="loading loading-spinner loading-sm" /> Approving USDC…
          </>
        ) : (
          "Approve USDC"
        )}
      </button>
    );
  }
  return (
    <button className="btn btn-accent btn-lg w-full" onClick={onBet} disabled={isBetting}>
      {isBetting ? (
        <>
          <span className="loading loading-spinner loading-sm" /> Placing bet…
        </>
      ) : (
        "Place bet"
      )}
    </button>
  );
};

/**
 * Combine scaffold's getParsedError with a tiny curated map of human-facing
 * messages for UpDown-specific errors. Falls back to the parsed error.
 */
const prettifyError = (err: unknown): string => {
  const parsed = getParsedError(err);
  for (const key of Object.keys(KNOWN_ERROR_MESSAGES)) {
    if (parsed && parsed.includes(key)) return KNOWN_ERROR_MESSAGES[key];
  }
  return parsed || "Transaction failed.";
};
