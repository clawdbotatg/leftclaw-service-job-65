"use client";

import { useMemo } from "react";
import { useScaffoldEventHistory, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { formatClawd, formatUsdc } from "~~/utils/updown/format";

/**
 * Four top-line stats driven by on-chain state:
 *  - CLAWD distributed: sum of clawdAmount from WON BetSettled events
 *  - CLAWD burned:      sum of clawdAmount from LOST BetSettled events
 *  - House pool USDC:   housePool() view
 *  - Win rate:          wins / (wins + losses)
 *
 * CANCELLED bets are excluded from the win-rate denominator since they never
 * had an outcome. A cancelled BetSettled event is not emitted by the contract
 * (cancel emits BetCancelled), so filtering just on PENDING/WON/LOST handles it.
 */
export const Stats = () => {
  const { data: housePool } = useScaffoldReadContract({
    contractName: "UpDown",
    functionName: "housePool",
    watch: true,
  });

  const { data: settledEvents } = useScaffoldEventHistory({
    contractName: "UpDown",
    eventName: "BetSettled",
    fromBlock: 0n,
    watch: true,
  });

  const { distributed, burned, wins, losses } = useMemo(() => {
    let distributed = 0n;
    let burned = 0n;
    let wins = 0;
    let losses = 0;
    for (const ev of settledEvents ?? []) {
      const args = (ev as any).args as
        | { status?: number | bigint; payoutUsdc?: bigint; clawdAmount?: bigint }
        | undefined;
      if (!args) continue;
      // BetStatus enum: 0 PENDING, 1 WON, 2 LOST, 3 CANCELLED
      const status = Number(args.status ?? 0);
      const clawd = args.clawdAmount ?? 0n;
      if (status === 1) {
        distributed += clawd;
        wins += 1;
      } else if (status === 2) {
        burned += clawd;
        losses += 1;
      }
    }
    return { distributed, burned, wins, losses };
  }, [settledEvents]);

  const settledCount = wins + losses;
  const winRatePct = settledCount === 0 ? null : (wins / settledCount) * 100;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <StatTile
        label="CLAWD distributed"
        value={formatClawd(distributed)}
        subtitle={`${wins} win${wins === 1 ? "" : "s"}`}
        tone="success"
      />
      <StatTile
        label="CLAWD burned"
        value={formatClawd(burned)}
        subtitle={`${losses} loss${losses === 1 ? "" : "es"}`}
        tone="error"
      />
      <StatTile
        label="House pool"
        value={`${formatUsdc(housePool as bigint | undefined)}`}
        subtitle="USDC"
        tone="info"
      />
      <StatTile
        label="Win rate"
        value={winRatePct === null ? "—" : `${winRatePct.toFixed(1)}%`}
        subtitle={settledCount === 0 ? "no settles yet" : `${settledCount} settled`}
        tone="primary"
      />
    </div>
  );
};

type Tone = "success" | "error" | "info" | "primary";

const TONE: Record<Tone, string> = {
  success: "text-success",
  error: "text-error",
  info: "text-info",
  primary: "text-primary",
};

const StatTile = ({ label, value, subtitle, tone }: { label: string; value: string; subtitle: string; tone: Tone }) => (
  <div className="card bg-base-100 shadow-md">
    <div className="card-body p-4">
      <div className="text-xs uppercase tracking-wider opacity-60">{label}</div>
      <div className={`text-xl md:text-2xl font-bold font-mono ${TONE[tone]}`}>{value}</div>
      <div className="text-xs opacity-60">{subtitle}</div>
    </div>
  </div>
);
