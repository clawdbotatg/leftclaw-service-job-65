import { wagmiConnectors } from "./wagmiConnectors";
import { Chain, createClient, fallback, http } from "viem";
import { hardhat, mainnet } from "viem/chains";
import { createConfig } from "wagmi";
import scaffoldConfig, { DEFAULT_ALCHEMY_API_KEY, ScaffoldConfig } from "~~/scaffold.config";
import { getAlchemyHttpUrl } from "~~/utils/scaffold-eth";

const { targetNetworks } = scaffoldConfig;

// We always want to have mainnet enabled (ENS resolution, ETH price, etc). But only once.
export const enabledChains = targetNetworks.find((network: Chain) => network.id === 1)
  ? targetNetworks
  : ([...targetNetworks, mainnet] as const);

export const wagmiConfig = createConfig({
  chains: enabledChains,
  connectors: wagmiConnectors(),
  ssr: true,
  client: ({ chain }) => {
    // IMPORTANT: do NOT include a bare `http()` fallback here. `http()` with
    // no URL resolves to viem's built-in public RPC list (e.g. mainnet.base.org
    // for Base), which rate-limits under our polling + watch load and leaks
    // calls to unmonitored endpoints. Only explicit, configured URLs below.
    //
    // Ordering notes:
    //  - If an `rpcOverrides[chainId]` is set, it wins (first in fallback list).
    //  - Otherwise we use Alchemy (when a key is configured for the chain).
    //  - For mainnet only, we keep the buidlguidl endpoint as a second-tier
    //    fallback since the Alchemy default key is aggressively rate-limited
    //    on ETH mainnet and ENS/price reads are noisy.
    const mainnetFallback = chain.id === mainnet.id ? [http("https://mainnet.rpc.buidlguidl.com")] : [];
    let rpcFallbacks: ReturnType<typeof http>[] = [...mainnetFallback];

    const rpcOverrideUrl = (scaffoldConfig.rpcOverrides as ScaffoldConfig["rpcOverrides"])?.[chain.id];
    if (rpcOverrideUrl) {
      rpcFallbacks = [http(rpcOverrideUrl), ...rpcFallbacks];
    } else {
      const alchemyHttpUrl = getAlchemyHttpUrl(chain.id);
      if (alchemyHttpUrl) {
        const isUsingDefaultKey = scaffoldConfig.alchemyApiKey === DEFAULT_ALCHEMY_API_KEY;
        // When we have a dedicated Alchemy key, prefer it. With the shared
        // default key, try other sources first and use Alchemy as a last resort.
        rpcFallbacks = isUsingDefaultKey
          ? [...rpcFallbacks, http(alchemyHttpUrl)]
          : [http(alchemyHttpUrl), ...rpcFallbacks];
      }
    }

    // If rpcFallbacks ended up empty (e.g. unknown chain with no override and
    // no Alchemy coverage), fall back to the chain's own RPC URLs — explicit,
    // not the bare viem-default list. This preserves function on exotic chains
    // without silently routing through a public gateway.
    if (rpcFallbacks.length === 0) {
      const chainRpcs = chain.rpcUrls?.default?.http ?? [];
      rpcFallbacks = chainRpcs.map(url => http(url));
    }

    return createClient({
      chain,
      transport: fallback(rpcFallbacks),
      ...(chain.id !== (hardhat as Chain).id ? { pollingInterval: scaffoldConfig.pollingInterval } : {}),
    });
  },
});
