import * as chains from "viem/chains";

export type BaseConfig = {
  targetNetworks: readonly chains.Chain[];
  pollingInterval: number;
  alchemyApiKey: string;
  rpcOverrides?: Record<number, string>;
  walletConnectProjectId: string;
  burnerWalletMode: "localNetworksOnly" | "allNetworks" | "disabled";
};

export type ScaffoldConfig = BaseConfig;

export const DEFAULT_ALCHEMY_API_KEY = "cR4WnXePioePZ5fFrnSiR";

// SE2's public default. If this is what ends up in the production bundle,
// WalletConnect will throttle / mis-route mobile deep links. Owners of the
// deploy should set NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID at build time with
// a registered project from https://cloud.walletconnect.com/.
const DEFAULT_WALLETCONNECT_PROJECT_ID = "3a8170812b534d0ff9d794f19a901d64";

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || DEFAULT_WALLETCONNECT_PROJECT_ID;

if (
  typeof process !== "undefined" &&
  process.env?.NODE_ENV !== "production" &&
  walletConnectProjectId === DEFAULT_WALLETCONNECT_PROJECT_ID
) {
  // Dev-only warning — the build should set a real projectId. Don't spam in
  // production (prod users can't do anything about it; we don't want console
  // noise on every page load).

  console.warn(
    "[scaffold.config] Using SE2 default WalletConnect projectId. " +
      "Set NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID in .env for production builds " +
      "(get a real projectId at https://cloud.walletconnect.com/).",
  );
}

const scaffoldConfig = {
  // Base mainnet — the UpDown contract is live at
  // 0xC5331B149244b678268fEDBa9FDd610c3A38e925.
  targetNetworks: [chains.base],
  // Base blocks are fast; poll every 3s so live prices/bets feel responsive
  // without thrashing the RPC.
  pollingInterval: 3000,
  alchemyApiKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || DEFAULT_ALCHEMY_API_KEY,
  rpcOverrides: {},
  walletConnectProjectId,
  burnerWalletMode: "localNetworksOnly",
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
