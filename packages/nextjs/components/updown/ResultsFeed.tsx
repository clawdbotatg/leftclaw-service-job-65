"use client";

import { useEffect, useMemo, useState } from "react";
import { Address } from "@scaffold-ui/components";
import { usePublicClient } from "wagmi";
import { useDeployedContractInfo, useScaffoldContract, useScaffoldEventHistory } from "~~/hooks/scaffold-eth";
import scaffoldConfig from "~~/scaffold.config";
import { ASSET_LABEL, BET_STATUS, DIRECTION_LABEL, formatClawd, formatPrice, formatUsdc } from "~~/utils/updown/format";

const TARGET_CHAIN_ID = scaffoldConfig.targetNetworks[0].id;

// Deploy block fallback — matches `deployedContracts.ts.UpDown.deployedOnBlock`.
// Used only if `useDeployedContractInfo` is still resolving so we never scan
// from Base genesis (~44M blocks).
const UPDOWN_DEPLOY_BLOCK = 44836164n;

type Row = {
  betId: bigint;
  status: 1 | 2; // WON or LOST (CANCELLED uses BetCancelled event, not shown here)
  payoutUsdc: bigint;
  clawdAmount: bigint;
  player?: string;
  asset?: number;
  direction?: number;
  entryPrice?: bigint;
  blockNumber?: bigint;
};

/**
 * Recent settled bets feed. `BetSettled` events only carry status + payout;
 * the struct fields (player/asset/direction/entryPrice) need a follow-up
 * `getBet(betId)` read, which we batch via multicall.
 *
 * Note: the contract does not persist the exit price anywhere, so "exit" is
 * implicit in the status (WIN/LOSS). We show entry + outcome instead.
 */
export const ResultsFeed = () => {
  const publicClient = usePublicClient({ chainId: TARGET_CHAIN_ID });
  const { data: upDown } = useScaffoldContract({ contractName: "UpDown" });
  const { data: deployedContract } = useDeployedContractInfo({ contractName: "UpDown" });
  const fromBlock =
    deployedContract?.deployedOnBlock !== undefined ? BigInt(deployedContract.deployedOnBlock) : UPDOWN_DEPLOY_BLOCK;

  const { data: settledEvents } = useScaffoldEventHistory({
    contractName: "UpDown",
    eventName: "BetSettled",
    fromBlock,
    watch: true,
  });

  // Freeze the most recent 25, newest first. The `log` shape comes back with
  // blockNumber populated by viem's getLogs.
  const recent = useMemo<Row[]>(() => {
    if (!settledEvents) return [];
    const rows: Row[] = [];
    for (const ev of settledEvents) {
      const args = (ev as any).args as
        | { betId?: bigint; status?: number | bigint; payoutUsdc?: bigint; clawdAmount?: bigint }
        | undefined;
      if (!args || args.betId === undefined) continue;
      const status = Number(args.status ?? 0);
      if (status !== 1 && status !== 2) continue;
      rows.push({
        betId: args.betId,
        status: status as 1 | 2,
        payoutUsdc: args.payoutUsdc ?? 0n,
        clawdAmount: args.clawdAmount ?? 0n,
        blockNumber: (ev as any).blockNumber as bigint | undefined,
      });
    }
    // Most recent first (sort by blockNumber; fallback to betId).
    rows.sort((a, b) => {
      const ab = a.blockNumber ?? 0n;
      const bb = b.blockNumber ?? 0n;
      if (ab !== bb) return ab > bb ? -1 : 1;
      return a.betId > b.betId ? -1 : 1;
    });
    return rows.slice(0, 25);
  }, [settledEvents]);

  const [hydrated, setHydrated] = useState<Row[]>([]);

  // Fetch full bet structs for the visible rows via multicall so we can show
  // player / asset / direction / entry price.
  useEffect(() => {
    const run = async () => {
      if (!publicClient || !upDown || recent.length === 0) {
        setHydrated(recent);
        return;
      }
      const calls = recent.map(r => ({
        address: upDown.address,
        abi: upDown.abi as any,
        functionName: "getBet",
        args: [r.betId],
      }));
      try {
        const results = await publicClient.multicall({ contracts: calls, allowFailure: true });
        const merged: Row[] = recent.map((r, i) => {
          const res = results[i];
          if (res?.status !== "success" || !res.result) return r;
          const b = res.result as any;
          // Named-struct shape; fall back to tuple indices if named fields not present.
          const player = b.player ?? b[1];
          const asset = b.asset ?? b[2];
          const direction = b.direction ?? b[3];
          const entryPrice = b.entryPrice ?? b[5];
          return {
            ...r,
            player: typeof player === "string" ? player : undefined,
            asset: asset !== undefined ? Number(asset) : undefined,
            direction: direction !== undefined ? Number(direction) : undefined,
            entryPrice: typeof entryPrice === "bigint" ? entryPrice : undefined,
          };
        });
        setHydrated(merged);
      } catch (e) {
        console.warn("ResultsFeed hydrate multicall failed", e);
        setHydrated(recent);
      }
    };
    void run();
  }, [recent, publicClient, upDown]);

  const rows = hydrated.length > 0 ? hydrated : recent;

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body">
        <h2 className="card-title">Recent results</h2>
        {rows.length === 0 ? (
          <div className="text-center opacity-60 py-6 text-sm">No settled bets yet. Be the first!</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr className="text-xs opacity-70">
                  <th>Player</th>
                  <th>Market</th>
                  <th>Outcome</th>
                  <th className="text-right">Entry</th>
                  <th className="text-right">Payout</th>
                  <th className="text-right">CLAWD</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <ResultRow key={r.betId.toString()} row={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

const ResultRow = ({ row }: { row: Row }) => {
  const asset = row.asset !== undefined ? ASSET_LABEL[row.asset as 0 | 1] : "—";
  const direction = row.direction !== undefined ? DIRECTION_LABEL[row.direction as 0 | 1] : "—";
  const won = row.status === 1;

  return (
    <tr>
      <td>
        {row.player ? (
          <Address address={row.player as `0x${string}`} format="short" size="xs" />
        ) : (
          <span className="opacity-50 text-xs">—</span>
        )}
      </td>
      <td>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{asset}</span>
          <span
            className={`badge badge-xs font-mono ${
              row.direction === 0 ? "badge-success" : row.direction === 1 ? "badge-error" : "badge-ghost"
            }`}
          >
            {direction}
          </span>
        </div>
      </td>
      <td>
        <span className={`badge badge-sm font-mono ${won ? "badge-success" : "badge-error"}`}>
          {BET_STATUS[row.status]}
        </span>
      </td>
      <td className="text-right font-mono text-xs">
        {row.entryPrice !== undefined ? `$${formatPrice(row.entryPrice)}` : "—"}
      </td>
      <td className="text-right font-mono text-xs">{won ? `${formatUsdc(row.payoutUsdc)} USDC` : "—"}</td>
      <td className={`text-right font-mono text-xs ${won ? "text-success" : "text-error"}`}>
        {won ? "+" : "-"}
        {formatClawd(row.clawdAmount)}
      </td>
    </tr>
  );
};
