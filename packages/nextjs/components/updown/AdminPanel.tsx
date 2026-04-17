"use client";

import { useEffect, useMemo, useState } from "react";
import { Address } from "@scaffold-ui/components";
import { parseUnits } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { useScaffoldContract, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useWriteAndOpen } from "~~/hooks/updown/useWriteAndOpen";
import scaffoldConfig from "~~/scaffold.config";
import { notification } from "~~/utils/scaffold-eth";
import { getParsedError } from "~~/utils/scaffold-eth";
import { USDC_DECIMALS, formatUsdc } from "~~/utils/updown/format";
import { USDC_ADDRESS } from "~~/utils/updown/quoter";

const TARGET_CHAIN_ID = scaffoldConfig.targetNetworks[0].id;

const USDC_MIN_ABI = [
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

/**
 * Owner-only control panel. Only rendered when connected wallet === owner().
 * Exposes every owner-settable knob on the contract:
 *   - fundHouse(uint256 amount)        : pulls USDC, grows the pool
 *   - withdrawHouse(uint256 amount)    : pulls USDC from pool back to owner
 *   - setLimits(min, max, payoutBps)   : bet bounds and default multiplier
 *   - setSlippageBps(uint256)          : caller-minOut floor ceiling
 *
 * The USDC approval for fundHouse is handled here too so the owner doesn't
 * need to bounce out to a different flow.
 */
export const AdminPanel = () => {
  const { address } = useAccount();
  const { data: upDown } = useScaffoldContract({ contractName: "UpDown" });

  const { data: ownerRaw } = useScaffoldReadContract({
    contractName: "UpDown",
    functionName: "owner",
  });
  const owner = ownerRaw as `0x${string}` | undefined;

  const isOwner = Boolean(address && owner && address.toLowerCase() === owner.toLowerCase());

  if (!isOwner) return null;

  return (
    <div className="card bg-base-200 shadow-xl border border-primary/30">
      <div className="card-body">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="card-title">Admin panel</h2>
          <div className="flex items-center gap-2 text-xs opacity-70">
            <span>owner:</span>
            <Address address={owner} format="short" size="xs" />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
          <FundHouseCard upDownAddress={upDown?.address as `0x${string}` | undefined} />
          <WithdrawHouseCard />
          <SetLimitsCard />
          <SetSlippageCard />
        </div>
      </div>
    </div>
  );
};

// -- fundHouse -------------------------------------------------------------

const FundHouseCard = ({ upDownAddress }: { upDownAddress: `0x${string}` | undefined }) => {
  const { address } = useAccount();
  const [amount, setAmount] = useState("100");
  const { writeContractAsync: writeUsdc, isPending: isApproving } = useWriteContract();
  const { writeContractAsync: writeUpDown, isMining: isFunding } = useScaffoldWriteContract({
    contractName: "UpDown",
  });
  const { writeAndOpen } = useWriteAndOpen();

  const parsed = useMemo(() => {
    try {
      const n = parseFloat(amount);
      if (!Number.isFinite(n) || n <= 0) return null;
      return parseUnits(amount, USDC_DECIMALS);
    } catch {
      return null;
    }
  }, [amount]);

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    abi: USDC_MIN_ABI,
    address: USDC_ADDRESS,
    functionName: "allowance",
    args: address && upDownAddress ? [address, upDownAddress] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: {
      enabled: Boolean(address && upDownAddress),
      refetchInterval: 5000,
    },
  });

  const needsApprove = parsed !== null && (allowance === undefined || (allowance as bigint) < parsed);

  const handleApprove = async () => {
    if (!parsed || !upDownAddress) return;
    try {
      await writeAndOpen(() =>
        writeUsdc({
          abi: USDC_MIN_ABI,
          address: USDC_ADDRESS,
          functionName: "approve",
          args: [upDownAddress, parsed],
        }),
      );
      notification.success("USDC approved for fundHouse");
      setTimeout(() => void refetchAllowance(), 3000);
    } catch (e) {
      notification.error(getParsedError(e) || "Approval failed");
    }
  };

  const handleFund = async () => {
    if (!parsed) return;
    try {
      await writeAndOpen(() => writeUpDown({ functionName: "fundHouse", args: [parsed] }));
      notification.success(`House pool funded with ${amount} USDC`);
    } catch (e) {
      notification.error(getParsedError(e) || "fundHouse failed");
    }
  };

  return (
    <div className="p-4 bg-base-100 rounded-box">
      <h3 className="font-bold mb-2">Fund house pool</h3>
      <label className="label label-text text-xs opacity-70 p-0 mb-1">Amount (USDC)</label>
      <input
        type="number"
        min={0}
        step={0.01}
        className="input input-bordered input-sm w-full mb-3"
        value={amount}
        onChange={e => setAmount(e.target.value)}
        placeholder="100"
      />
      {needsApprove ? (
        <button className="btn btn-primary btn-sm w-full" onClick={handleApprove} disabled={!parsed || isApproving}>
          {isApproving ? "Approving…" : "Approve USDC"}
        </button>
      ) : (
        <button className="btn btn-success btn-sm w-full" onClick={handleFund} disabled={!parsed || isFunding}>
          {isFunding ? "Funding…" : "Fund house"}
        </button>
      )}
    </div>
  );
};

// -- withdrawHouse ----------------------------------------------------------

const WithdrawHouseCard = () => {
  const [amount, setAmount] = useState("");
  const { data: housePool } = useScaffoldReadContract({
    contractName: "UpDown",
    functionName: "housePool",
    watch: true,
  });
  const { writeContractAsync: writeUpDown, isMining } = useScaffoldWriteContract({
    contractName: "UpDown",
  });
  const { writeAndOpen } = useWriteAndOpen();

  const parsed = useMemo(() => {
    try {
      const n = parseFloat(amount);
      if (!Number.isFinite(n) || n <= 0) return null;
      return parseUnits(amount, USDC_DECIMALS);
    } catch {
      return null;
    }
  }, [amount]);

  const tooMuch = parsed !== null && housePool !== undefined && parsed > (housePool as bigint);

  const handleWithdraw = async () => {
    if (!parsed) return;
    try {
      await writeAndOpen(() => writeUpDown({ functionName: "withdrawHouse", args: [parsed] }));
      notification.success(`Withdrew ${amount} USDC`);
    } catch (e) {
      notification.error(getParsedError(e) || "withdrawHouse failed");
    }
  };

  return (
    <div className="p-4 bg-base-100 rounded-box">
      <h3 className="font-bold mb-2">Withdraw house pool</h3>
      <div className="text-xs opacity-70 mb-1">
        Current pool: <span className="font-mono">{formatUsdc(housePool as bigint | undefined)} USDC</span>
      </div>
      <input
        type="number"
        min={0}
        step={0.01}
        className="input input-bordered input-sm w-full mb-3"
        value={amount}
        onChange={e => setAmount(e.target.value)}
        placeholder="0"
      />
      <button
        className="btn btn-warning btn-sm w-full"
        onClick={handleWithdraw}
        disabled={!parsed || tooMuch || isMining}
      >
        {isMining ? "Withdrawing…" : tooMuch ? "Exceeds pool" : "Withdraw"}
      </button>
    </div>
  );
};

// -- setLimits -------------------------------------------------------------

const SetLimitsCard = () => {
  const { data: minBet } = useScaffoldReadContract({ contractName: "UpDown", functionName: "minBet", watch: true });
  const { data: maxBet } = useScaffoldReadContract({ contractName: "UpDown", functionName: "maxBet", watch: true });
  const { data: payoutBps } = useScaffoldReadContract({
    contractName: "UpDown",
    functionName: "payoutMultiplierBps",
    watch: true,
  });
  const { writeContractAsync: writeUpDown, isMining } = useScaffoldWriteContract({
    contractName: "UpDown",
  });
  const { writeAndOpen } = useWriteAndOpen();

  const [minStr, setMinStr] = useState("");
  const [maxStr, setMaxStr] = useState("");
  const [bpsStr, setBpsStr] = useState("");

  useEffect(() => {
    if (minStr === "" && minBet !== undefined) {
      setMinStr(Number(minBet as bigint) / 10 ** USDC_DECIMALS + "");
    }
  }, [minBet, minStr]);
  useEffect(() => {
    if (maxStr === "" && maxBet !== undefined) {
      setMaxStr(Number(maxBet as bigint) / 10 ** USDC_DECIMALS + "");
    }
  }, [maxBet, maxStr]);
  useEffect(() => {
    if (bpsStr === "" && payoutBps !== undefined) {
      setBpsStr((payoutBps as bigint).toString());
    }
  }, [payoutBps, bpsStr]);

  const handle = async () => {
    try {
      const minP = parseUnits(minStr || "0", USDC_DECIMALS);
      const maxP = parseUnits(maxStr || "0", USDC_DECIMALS);
      const bpsP = BigInt(bpsStr || "0");
      await writeAndOpen(() => writeUpDown({ functionName: "setLimits", args: [minP, maxP, bpsP] }));
      notification.success("Limits updated");
    } catch (e) {
      notification.error(getParsedError(e) || "setLimits failed");
    }
  };

  return (
    <div className="p-4 bg-base-100 rounded-box">
      <h3 className="font-bold mb-2">Bet limits & payout</h3>
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div>
          <label className="label label-text text-xs opacity-70 p-0 mb-1">Min (USDC)</label>
          <input
            type="number"
            className="input input-bordered input-sm w-full"
            value={minStr}
            onChange={e => setMinStr(e.target.value)}
          />
        </div>
        <div>
          <label className="label label-text text-xs opacity-70 p-0 mb-1">Max (USDC)</label>
          <input
            type="number"
            className="input input-bordered input-sm w-full"
            value={maxStr}
            onChange={e => setMaxStr(e.target.value)}
          />
        </div>
        <div>
          <label className="label label-text text-xs opacity-70 p-0 mb-1">Payout (bps)</label>
          <input
            type="number"
            className="input input-bordered input-sm w-full"
            value={bpsStr}
            onChange={e => setBpsStr(e.target.value)}
          />
        </div>
      </div>
      <div className="text-[10px] opacity-60 mb-2">10000 = 1.00x · 17600 = 1.76x · 50000 = 5.00x (max)</div>
      <button className="btn btn-primary btn-sm w-full" onClick={handle} disabled={isMining}>
        {isMining ? "Updating…" : "Update limits"}
      </button>
    </div>
  );
};

// -- setSlippageBps --------------------------------------------------------

const SetSlippageCard = () => {
  const { data: slippageBps } = useScaffoldReadContract({
    contractName: "UpDown",
    functionName: "slippageBps",
    watch: true,
  });
  const { writeContractAsync: writeUpDown, isMining } = useScaffoldWriteContract({
    contractName: "UpDown",
  });
  const { writeAndOpen } = useWriteAndOpen();

  const [bpsStr, setBpsStr] = useState("");

  useEffect(() => {
    if (bpsStr === "" && slippageBps !== undefined) {
      setBpsStr((slippageBps as bigint).toString());
    }
  }, [slippageBps, bpsStr]);

  const handle = async () => {
    try {
      const n = BigInt(bpsStr || "0");
      await writeAndOpen(() => writeUpDown({ functionName: "setSlippageBps", args: [n] }));
      notification.success("Slippage updated");
    } catch (e) {
      notification.error(getParsedError(e) || "setSlippageBps failed");
    }
  };

  return (
    <div className="p-4 bg-base-100 rounded-box">
      <h3 className="font-bold mb-2">Slippage ceiling</h3>
      <div className="text-xs opacity-70 mb-1">
        Current:{" "}
        <span className="font-mono">{slippageBps !== undefined ? (slippageBps as bigint).toString() : "—"} bps</span>
      </div>
      <input
        type="number"
        min={0}
        max={1000}
        step={1}
        className="input input-bordered input-sm w-full mb-3"
        value={bpsStr}
        onChange={e => setBpsStr(e.target.value)}
        placeholder="500"
      />
      <div className="text-[10px] opacity-60 mb-2">
        Max 1000 bps (10%). Used as the floor on caller-supplied settle minOuts.
      </div>
      <button className="btn btn-primary btn-sm w-full" onClick={handle} disabled={isMining}>
        {isMining ? "Updating…" : "Update slippage"}
      </button>
    </div>
  );
};
