"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { ASSET_LABEL, formatPrice } from "~~/utils/updown/format";

/**
 * Lightweight SVG sparkline for the selected asset.
 *
 * Why in-memory instead of CoinGecko: a static IPFS export must not depend on
 * a third-party API to render the core flow. We sample `getPrice()` through
 * SE2's scaffoldConfig polling interval (3s) and keep the last N points in
 * memory. On a fresh page load the chart starts empty and fills in — this is
 * intentional and clearly labelled.
 *
 * If the user has an active bet on the selected asset, the caller can pass
 * `entryOverlay` to overlay a dashed horizontal line at the entry price, so
 * you can see live whether you're winning.
 */
const WINDOW_POINTS = 60; // ~3 minutes at a 3s polling interval

export const PriceChart = ({ asset, entryOverlay }: { asset: 0 | 1; entryOverlay?: bigint | undefined }) => {
  const { data: price } = useScaffoldReadContract({
    contractName: "UpDown",
    functionName: "getPrice",
    args: [asset],
    watch: true,
  });

  // Per-asset buffers (so switching assets doesn't clobber the other's history).
  const buffersRef = useRef<{ [k: number]: { ts: number; value: bigint }[] }>({});
  const [, force] = useState(0);

  useEffect(() => {
    if (price === undefined || price === null) return;
    const v = price as bigint;
    const buf = buffersRef.current[asset] ?? [];
    const last = buf[buf.length - 1];
    const now = Date.now();
    // Skip duplicate consecutive values to avoid flat-line artifacts on slow ticks.
    if (!last || last.value !== v) {
      buf.push({ ts: now, value: v });
      if (buf.length > WINDOW_POINTS) buf.splice(0, buf.length - WINDOW_POINTS);
      buffersRef.current[asset] = buf;
      force(n => n + 1);
    }
  }, [price, asset]);

  const buf = buffersRef.current[asset] ?? [];

  const { path, yForEntry, min, max, first, last } = useMemo(() => {
    if (buf.length < 2) {
      return {
        path: "",
        yForEntry: null as number | null,
        min: 0n,
        max: 0n,
        first: 0n,
        last: 0n,
      };
    }
    let lo = buf[0].value;
    let hi = buf[0].value;
    for (const p of buf) {
      if (p.value < lo) lo = p.value;
      if (p.value > hi) hi = p.value;
    }
    if (entryOverlay !== undefined) {
      if (entryOverlay < lo) lo = entryOverlay;
      if (entryOverlay > hi) hi = entryOverlay;
    }
    const span = hi - lo === 0n ? 1n : hi - lo;
    const w = 300;
    const h = 80;
    const toY = (v: bigint) => {
      // v in [lo, hi] -> y in [h-2, 2] (flipped: higher price, lower y)
      const num = (v - lo) * BigInt(h - 4);
      const y = h - 2 - Number(num) / Number(span);
      return y;
    };
    const stepX = w / (WINDOW_POINTS - 1);
    // Left-pad so sparse data hugs the right edge.
    const padLeft = WINDOW_POINTS - buf.length;
    const coords = buf.map((p, i) => {
      const x = (padLeft + i) * stepX;
      return `${x},${toY(p.value).toFixed(2)}`;
    });
    const path = `M ${coords[0]} L ${coords.slice(1).join(" ")}`;
    const yForEntry = entryOverlay !== undefined ? toY(entryOverlay) : null;
    return {
      path,
      yForEntry,
      min: lo,
      max: hi,
      first: buf[0].value,
      last: buf[buf.length - 1].value,
    };
  }, [buf, entryOverlay]);

  const pctChange = useMemo(() => {
    if (buf.length < 2 || first === 0n) return null;
    // (last - first) / first * 100, kept as number since Chainlink 8-decimals fit easily.
    const lastN = Number(last);
    const firstN = Number(first);
    if (firstN === 0) return null;
    return ((lastN - firstN) / firstN) * 100;
  }, [buf, first, last]);

  const stroke = pctChange === null ? "oklch(var(--bc))" : pctChange >= 0 ? "oklch(var(--su))" : "oklch(var(--er))";

  return (
    <div className="card bg-base-100 shadow-md">
      <div className="card-body p-4">
        <div className="flex justify-between items-center">
          <div className="flex items-baseline gap-2">
            <span className="text-sm opacity-70">{ASSET_LABEL[asset]} / USD</span>
            <span className="text-xs opacity-50">· ~3 min</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono font-bold">${formatPrice(last || (price as bigint | undefined))}</span>
            {pctChange !== null && (
              <span className={`text-xs font-mono ${pctChange >= 0 ? "text-success" : "text-error"}`}>
                {pctChange >= 0 ? "+" : ""}
                {pctChange.toFixed(3)}%
              </span>
            )}
          </div>
        </div>

        <svg viewBox="0 0 300 80" className="w-full h-20 mt-1" preserveAspectRatio="none">
          {path && (
            <path
              d={path}
              fill="none"
              stroke={stroke}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {yForEntry !== null && (
            <line
              x1={0}
              x2={300}
              y1={yForEntry}
              y2={yForEntry}
              stroke="oklch(var(--p))"
              strokeDasharray="3 3"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        <div className="flex justify-between text-[10px] opacity-50 font-mono">
          <span>lo ${formatPrice(min)}</span>
          {buf.length < 3 ? <span>collecting ticks…</span> : <span>{buf.length} ticks</span>}
          <span>hi ${formatPrice(max)}</span>
        </div>
      </div>
    </div>
  );
};
