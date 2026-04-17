"use client";

import { useEffect, useMemo, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { useAccount, usePublicClient } from "wagmi";
import { ActiveBets } from "~~/components/updown/ActiveBets";
import { AdminPanel } from "~~/components/updown/AdminPanel";
import { BettingPanel } from "~~/components/updown/BettingPanel";
import { PriceChart } from "~~/components/updown/PriceChart";
import { PriceDisplay } from "~~/components/updown/PriceDisplay";
import { ResultsFeed } from "~~/components/updown/ResultsFeed";
import { Stats } from "~~/components/updown/Stats";
import { useScaffoldContract, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import scaffoldConfig from "~~/scaffold.config";

const TARGET_CHAIN_ID = scaffoldConfig.targetNetworks[0].id;

/**
 * UP/DOWN — 1-minute binary price game on Base.
 *
 * Layout:
 *   ┌───────────────────────────────────────────────┐
 *   │              Top-line stats tiles             │
 *   ├────────────────────────┬──────────────────────┤
 *   │  Price display         │                      │
 *   │  Price chart           │   Betting panel      │
 *   ├────────────────────────┤                      │
 *   │  Active bets           │                      │
 *   ├───────────────────────────────────────────────┤
 *   │  Recent results                               │
 *   ├───────────────────────────────────────────────┤
 *   │  Admin panel (owner only)                     │
 *   └───────────────────────────────────────────────┘
 *
 * We keep the `asset` state up here so the chart, price display, betting
 * panel, and active-bet overlay all share it.
 */
const Home: NextPage = () => {
  const [asset, setAsset] = useState<0 | 1>(0);
  const [direction, setDirection] = useState<0 | 1>(0);
  const [betUsdc, setBetUsdc] = useState<number>(10);

  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: TARGET_CHAIN_ID });
  const { data: upDown } = useScaffoldContract({ contractName: "UpDown" });

  // Active-bet entry-price overlay: look at the selected asset's oldest pending
  // bet for the connected wallet, if any. One read per render is cheap — this
  // is cosmetic, not load-bearing.
  const { data: pendingIds } = useScaffoldReadContract({
    contractName: "UpDown",
    functionName: "getPendingBets",
    args: address ? [address] : [undefined],
    watch: true,
  });
  const [entryOverlay, setEntryOverlay] = useState<bigint | undefined>(undefined);

  useEffect(() => {
    const run = async () => {
      if (!publicClient || !upDown || !pendingIds || (pendingIds as bigint[]).length === 0) {
        setEntryOverlay(undefined);
        return;
      }
      const ids = pendingIds as bigint[];
      try {
        const results = await publicClient.multicall({
          contracts: ids.map(id => ({
            address: upDown.address,
            abi: upDown.abi as any,
            functionName: "getBet",
            args: [id],
          })),
          allowFailure: true,
        });
        for (const r of results) {
          if (r.status === "success" && r.result) {
            const b = r.result as any;
            const a = Number(b.asset ?? b[2]);
            if (a === asset) {
              setEntryOverlay((b.entryPrice ?? b[5]) as bigint);
              return;
            }
          }
        }
        setEntryOverlay(undefined);
      } catch {
        setEntryOverlay(undefined);
      }
    };
    void run();
  }, [pendingIds, publicClient, upDown, asset]);

  // Contract address subtitle — helps users verify they're on the right one.
  const contractAddress = upDown?.address;
  const subtitle = useMemo(() => (contractAddress ? contractAddress : "loading…"), [contractAddress]);

  return (
    <div className="flex flex-col grow pb-10">
      {/* Hero ------------------------------------------------------------- */}
      <section className="px-5 pt-8 pb-6 text-center">
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight">
          <span className="text-success">UP</span>
          <span className="opacity-40"> / </span>
          <span className="text-error">DOWN</span>
        </h1>
        <p className="mt-2 text-sm md:text-base opacity-70 max-w-xl mx-auto">
          Bet 1–100 USDC on whether ETH or BTC moves UP or DOWN in the next 60 seconds. Wins pay
          <span className="font-semibold"> 1.76x in CLAWD</span>. Losses buy-and-burn CLAWD. Live on Base.
        </p>
        <div className="mt-3 flex justify-center items-center gap-2 text-xs opacity-60">
          <span>Contract:</span>
          {contractAddress ? (
            <Address address={contractAddress} format="short" size="xs" />
          ) : (
            <span className="font-mono">{subtitle}</span>
          )}
        </div>
      </section>

      <main className="px-5 flex flex-col gap-6 max-w-6xl w-full mx-auto">
        <Stats />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 flex flex-col gap-4">
            <PriceDisplay asset={asset} />
            <PriceChart asset={asset} entryOverlay={entryOverlay} />
            <ActiveBets selectedAsset={asset} />
          </div>
          <div className="lg:col-span-1">
            <BettingPanel
              asset={asset}
              direction={direction}
              betUsdc={betUsdc}
              setAsset={setAsset}
              setDirection={setDirection}
              setBetUsdc={setBetUsdc}
            />
          </div>
        </div>

        <ResultsFeed />

        <AdminPanel />
      </main>
    </div>
  );
};

export default Home;
