"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useScaffoldContract, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import scaffoldConfig from "~~/scaffold.config";
import { notification } from "~~/utils/scaffold-eth";
import { getParsedError } from "~~/utils/scaffold-eth";
import {
  ASSET_LABEL,
  DIRECTION_LABEL,
  KNOWN_ERROR_MESSAGES,
  formatCountdown,
  formatPrice,
  formatUsdc,
} from "~~/utils/updown/format";
import { applySlippage, quoteUsdcToClawd } from "~~/utils/updown/quoter";

type Bet = {
  betId: bigint;
  player: string;
  asset: number;
  direction: number;
  usdcAmount: bigint;
  entryPrice: bigint;
  settleAfter: bigint;
  entryRoundId: bigint;
  payoutMultiplierBps: bigint;
  status: number;
};

const TARGET_CHAIN_ID = scaffoldConfig.targetNetworks[0].id;

/**
 * Active-bets list for the connected wallet.
 *
 * Flow:
 *  - Poll `getPendingBets(player)` to get IDs
 *  - Fetch each bet via `getBet(id)` through a multicall (publicClient.multicall)
 *  - For each, show a countdown; once `now >= settleAfter`, enable Settle
 *  - Settle: quote USDC->CLAWD twice (for the payout-on-win and burn-on-loss legs),
 *    apply 5% slippage, pass both as args. Contract only uses whichever leg matches
 *    the actual outcome.
 *  - Past grace period (settleAfter + 300s) show Cancel.
 */
export const ActiveBets = ({ selectedAsset }: { selectedAsset: 0 | 1 }) => {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: TARGET_CHAIN_ID });
  const { data: upDown } = useScaffoldContract({ contractName: "UpDown" });

  const { data: pendingIds, refetch: refetchPending } = useScaffoldReadContract({
    contractName: "UpDown",
    functionName: "getPendingBets",
    args: address ? [address] : [undefined],
    watch: true,
  });

  const [bets, setBets] = useState<Bet[]>([]);
  const [now, setNow] = useState<number>(Math.floor(Date.now() / 1000));

  // Simple 1s ticker for countdowns
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Hydrate bet structs from IDs (batched multicall)
  useEffect(() => {
    const run = async () => {
      if (!publicClient || !upDown || !pendingIds || (pendingIds as bigint[]).length === 0) {
        setBets([]);
        return;
      }
      const ids = pendingIds as bigint[];
      const calls = ids.map(id => ({
        address: upDown.address,
        abi: upDown.abi as any,
        functionName: "getBet",
        args: [id],
      }));
      try {
        const results = await publicClient.multicall({ contracts: calls, allowFailure: true });
        const fetched: Bet[] = [];
        results.forEach((r, i) => {
          if (r.status === "success" && r.result) {
            const b = r.result as any;
            fetched.push({
              betId: b.betId,
              player: b.player,
              asset: Number(b.asset),
              direction: Number(b.direction),
              usdcAmount: b.usdcAmount,
              entryPrice: b.entryPrice,
              settleAfter: b.settleAfter,
              entryRoundId: b.entryRoundId,
              payoutMultiplierBps: b.payoutMultiplierBps,
              status: Number(b.status),
            });
          } else if (r.status === "success") {
            // tuple fallback
            const t = r.result as unknown as any[];
            fetched.push({
              betId: t[0],
              player: t[1],
              asset: Number(t[2]),
              direction: Number(t[3]),
              usdcAmount: t[4],
              entryPrice: t[5],
              settleAfter: t[6],
              entryRoundId: t[7],
              payoutMultiplierBps: t[8],
              status: Number(t[9]),
            });
          } else {
            console.warn("getBet failed for id", ids[i], r);
          }
        });
        setBets(fetched);
      } catch (e) {
        console.error("multicall getBet failed", e);
      }
    };
    void run();
  }, [pendingIds, publicClient, upDown]);

  // Current prices (for live entry-vs-now display)
  const { data: ethPrice } = useScaffoldReadContract({
    contractName: "UpDown",
    functionName: "getPrice",
    args: [0],
    watch: true,
  });
  const { data: btcPrice } = useScaffoldReadContract({
    contractName: "UpDown",
    functionName: "getPrice",
    args: [1],
    watch: true,
  });

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body">
        <div className="flex justify-between items-center">
          <h2 className="card-title">Active bets</h2>
          <button className="btn btn-ghost btn-xs" onClick={() => void refetchPending()}>
            Refresh
          </button>
        </div>

        {!address && <div className="text-center opacity-60 py-6 text-sm">Connect your wallet to see active bets.</div>}

        {address && bets.length === 0 && (
          <div className="text-center opacity-60 py-6 text-sm">No active bets. Place one on the left!</div>
        )}

        <div className="flex flex-col gap-3">
          {bets.map(bet => {
            const currentPrice = bet.asset === 0 ? (ethPrice as bigint | undefined) : (btcPrice as bigint | undefined);
            return (
              <BetRow
                key={bet.betId.toString()}
                bet={bet}
                now={now}
                currentPrice={currentPrice}
                isForSelectedAsset={bet.asset === selectedAsset}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};

const BetRow = ({
  bet,
  now,
  currentPrice,
}: {
  bet: Bet;
  now: number;
  currentPrice: bigint | undefined;
  isForSelectedAsset: boolean;
}) => {
  const { writeContractAsync: writeUpDown } = useScaffoldWriteContract({ contractName: "UpDown" });
  const publicClient = usePublicClient({ chainId: TARGET_CHAIN_ID });
  const [isSettling, setIsSettling] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const settleAt = Number(bet.settleAfter);
  const cancelAt = settleAt + 300;
  const remaining = settleAt - now;
  const canSettle = now >= settleAt;
  const canCancel = now >= cancelAt;

  // Direction-aware live win/lose hint
  const isWinningNow = useMemo(() => {
    if (!currentPrice) return undefined;
    if (bet.direction === 0) return currentPrice > bet.entryPrice;
    return currentPrice < bet.entryPrice;
  }, [currentPrice, bet]);

  const handleSettle = async () => {
    if (!publicClient) return;
    setIsSettling(true);
    try {
      // Quote both legs since the caller doesn't know the outcome.
      // If WIN, contract swaps `payoutUsdc = usdcAmount * bps/1e4` to CLAWD for the player.
      // If LOSS, contract swaps `burnUsdc = usdcAmount / 2` to CLAWD and burns.
      const payoutUsdc = (bet.usdcAmount * bet.payoutMultiplierBps) / 10000n;
      const burnUsdc = bet.usdcAmount / 2n;

      const [payoutQuote, burnQuote] = await Promise.all([
        quoteUsdcToClawd(publicClient as any, payoutUsdc),
        burnUsdc > 0n ? quoteUsdcToClawd(publicClient as any, burnUsdc) : Promise.resolve(0n),
      ]);

      const minPayoutClawd = applySlippage(payoutQuote);
      const minBurnClawd = burnUsdc > 0n ? applySlippage(burnQuote) : 0n;

      await writeUpDown({
        functionName: "settle",
        args: [bet.betId, minPayoutClawd, minBurnClawd],
      });
      notification.success(`Bet #${bet.betId.toString()} settled`);
    } catch (e) {
      notification.error(prettifyError(e));
    } finally {
      setIsSettling(false);
    }
  };

  const handleCancel = async () => {
    setIsCancelling(true);
    try {
      await writeUpDown({
        functionName: "cancelExpiredBet",
        args: [bet.betId],
      });
      notification.success(`Bet #${bet.betId.toString()} refunded`);
    } catch (e) {
      notification.error(prettifyError(e));
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <div className="p-3 bg-base-200 rounded-box border border-base-300">
      <div className="flex flex-wrap justify-between items-center gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className={`badge ${bet.direction === 0 ? "badge-success" : "badge-error"} badge-sm font-mono`}>
            {DIRECTION_LABEL[bet.direction]}
          </span>
          <span className="font-mono text-sm">{ASSET_LABEL[bet.asset]}</span>
          <span className="opacity-50 text-xs">#{bet.betId.toString()}</span>
        </div>
        <div className="font-mono text-sm">{formatUsdc(bet.usdcAmount)} USDC</div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs mb-2">
        <div>
          <div className="opacity-50">Entry</div>
          <div className="font-mono">${formatPrice(bet.entryPrice)}</div>
        </div>
        <div>
          <div className="opacity-50">Current</div>
          <div
            className={`font-mono ${
              isWinningNow === true ? "text-success" : isWinningNow === false ? "text-error" : ""
            }`}
          >
            ${formatPrice(currentPrice)}
          </div>
        </div>
      </div>

      <div className="flex justify-between items-center mt-3">
        <div className="text-xs">
          {canCancel ? (
            <span className="text-warning">Expired — please cancel to refund</span>
          ) : canSettle ? (
            <span className="text-info">Ready to settle</span>
          ) : (
            <span className="opacity-70">Settles in {formatCountdown(remaining)}</span>
          )}
        </div>
        <div className="flex gap-2">
          {canSettle && !canCancel && (
            <button className="btn btn-primary btn-sm" onClick={handleSettle} disabled={isSettling}>
              {isSettling ? (
                <>
                  <span className="loading loading-spinner loading-xs" /> Settling…
                </>
              ) : (
                "Settle"
              )}
            </button>
          )}
          {canCancel && (
            <button className="btn btn-warning btn-sm" onClick={handleCancel} disabled={isCancelling}>
              {isCancelling ? (
                <>
                  <span className="loading loading-spinner loading-xs" /> Refunding…
                </>
              ) : (
                "Cancel expired"
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const prettifyError = (err: unknown): string => {
  const parsed = getParsedError(err);
  for (const key of Object.keys(KNOWN_ERROR_MESSAGES)) {
    if (parsed && parsed.includes(key)) return KNOWN_ERROR_MESSAGES[key];
  }
  return parsed || "Transaction failed.";
};
