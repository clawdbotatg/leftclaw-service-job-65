"use client";

import { useCallback } from "react";
import { useAccount } from "wagmi";

/**
 * Best-effort mobile deep-link: fire the transaction, then after ~2s try to
 * bounce the user back to their wallet app. RainbowKit / WalletConnect v2 do
 * not auto-reopen the wallet after a write on mobile — a user taps "Place bet",
 * nothing visibly happens, and they have to manually switch apps. This nudges
 * them back.
 *
 * Pattern: call `writeContractAsync` first so the RPC request is inflight
 * (writeFn is invoked synchronously), THEN setTimeout(openWallet, 2000). The
 * 2s delay lets the WalletConnect session send the request to the wallet's
 * push service before we try to open the app.
 *
 * No-op on desktop (where an injected wallet like MetaMask already pops its
 * own signature modal).
 */
export const useWriteAndOpen = () => {
  const { connector } = useAccount();

  const openWallet = useCallback(() => {
    if (typeof window === "undefined") return;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (!isMobile) return;
    // If there's an injected provider (wallet browser), the wallet's own modal
    // is already showing — don't hijack the navigation.
    if ((window as any).ethereum) return;

    // Try to figure out which wallet the user connected with. WalletConnect
    // stores the peer metadata in localStorage under `wc@2:*` keys; RainbowKit
    // also writes `wagmi.recentConnectorId`.
    let hint = "";
    try {
      const recentId = window.localStorage?.getItem("wagmi.recentConnectorId") ?? "";
      const connectorId = connector?.id ?? "";
      const connectorName = connector?.name ?? "";
      hint = `${recentId} ${connectorId} ${connectorName}`.toLowerCase();
      // Sniff WalletConnect v2 session peer name, if present.
      for (const key of Object.keys(window.localStorage ?? {})) {
        if (key.startsWith("wc@2:") && key.includes("session")) {
          try {
            const raw = window.localStorage.getItem(key);
            if (raw) hint += " " + raw.toLowerCase();
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore — localStorage may be blocked */
    }

    // Deep-link schemes for the most common wallets.
    let target: string | null = null;
    if (hint.includes("rainbow")) target = "rainbow://";
    else if (hint.includes("metamask")) target = "https://metamask.app.link/";
    else if (hint.includes("trust")) target = "trust://";
    else if (hint.includes("coinbase")) target = "cbwallet://";
    else if (hint.includes("phantom")) target = "phantom://";
    else if (hint.includes("ledger")) target = "ledgerlive://";

    // Fall back to the generic WalletConnect deep-link; most wallets register
    // `wc://` as a URL handler.
    if (!target) target = "wc://";

    try {
      window.location.href = target;
    } catch {
      /* browsers may block programmatic navigation — quietly give up */
    }
  }, [connector]);

  // Generic wrapper: takes a zero-arg function that returns a Promise (the
  // actual write call). Kicks off the write, then a 2s timer to nudge the
  // wallet app open. Returns the write's promise unchanged so callers can
  // await/catch as normal.
  const writeAndOpen = useCallback(
    <T>(writeFn: () => Promise<T>): Promise<T> => {
      const promise = writeFn();
      setTimeout(openWallet, 2000);
      return promise;
    },
    [openWallet],
  );

  return { writeAndOpen, openWallet };
};
