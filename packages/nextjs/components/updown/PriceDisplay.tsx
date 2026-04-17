"use client";

import { useEffect, useState } from "react";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { ASSET_LABEL, formatPrice } from "~~/utils/updown/format";

type PriceDisplayProps = {
  asset: 0 | 1;
  onPriceUpdate?: (price: bigint | undefined) => void;
};

/**
 * Live price readout for the selected asset.
 * `watch: true` is wired through to SE2's polling interval (3s in scaffoldConfig).
 * We surface the price up via `onPriceUpdate` so the betting panel can
 * overlay it (entry vs current) without a second RPC hit.
 */
export const PriceDisplay = ({ asset, onPriceUpdate }: PriceDisplayProps) => {
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

  const [prev, setPrev] = useState<{ eth: bigint | undefined; btc: bigint | undefined }>({
    eth: undefined,
    btc: undefined,
  });

  useEffect(() => {
    setPrev(curr => ({
      eth: curr.eth === undefined && ethPrice !== undefined ? ethPrice : curr.eth,
      btc: curr.btc === undefined && btcPrice !== undefined ? btcPrice : curr.btc,
    }));
  }, [ethPrice, btcPrice]);

  const selected = asset === 0 ? ethPrice : btcPrice;

  useEffect(() => {
    onPriceUpdate?.(selected as bigint | undefined);
    // onPriceUpdate is expected to be stable or wrapped by the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const tint = (curr?: bigint, start?: bigint) => {
    if (curr === undefined || start === undefined) return "";
    if (curr > start) return "text-success";
    if (curr < start) return "text-error";
    return "";
  };

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className={`p-4 rounded-box bg-base-100 shadow-md ${asset === 0 ? "ring-2 ring-primary" : ""}`}>
        <div className="text-xs uppercase tracking-wider opacity-60">ETH / USD</div>
        <div className={`text-2xl font-bold ${tint(ethPrice as bigint, prev.eth)}`}>
          ${formatPrice(ethPrice as bigint | undefined)}
        </div>
      </div>
      <div className={`p-4 rounded-box bg-base-100 shadow-md ${asset === 1 ? "ring-2 ring-primary" : ""}`}>
        <div className="text-xs uppercase tracking-wider opacity-60">BTC / USD</div>
        <div className={`text-2xl font-bold ${tint(btcPrice as bigint, prev.btc)}`}>
          ${formatPrice(btcPrice as bigint | undefined)}
        </div>
      </div>
      <div className="col-span-2 text-xs opacity-50 text-center">
        {ASSET_LABEL[asset]} selected · Chainlink price feed · updates every 3s
      </div>
    </div>
  );
};
