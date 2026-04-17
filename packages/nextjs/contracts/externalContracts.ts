import { GenericContractsDeclaration } from "~~/utils/scaffold-eth/contract";

// External contracts the frontend talks to on Base mainnet.
// Including these gives wagmi-style ABIs to our hooks AND — critically —
// adds their custom errors (OZ v5 ERC20, Uniswap V3 QuoterV2) to the
// registry scaffold-eth's `getParsedError` uses to decode reverts.
const externalContracts = {
  8453: {
    // USDC on Base (the bet collateral)
    USDC: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      abi: [
        {
          type: "function",
          name: "approve",
          inputs: [
            { name: "spender", type: "address", internalType: "address" },
            { name: "amount", type: "uint256", internalType: "uint256" },
          ],
          outputs: [{ name: "", type: "bool", internalType: "bool" }],
          stateMutability: "nonpayable",
        },
        {
          type: "function",
          name: "allowance",
          inputs: [
            { name: "owner", type: "address", internalType: "address" },
            { name: "spender", type: "address", internalType: "address" },
          ],
          outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "balanceOf",
          inputs: [{ name: "account", type: "address", internalType: "address" }],
          outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "decimals",
          inputs: [],
          outputs: [{ name: "", type: "uint8", internalType: "uint8" }],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "symbol",
          inputs: [],
          outputs: [{ name: "", type: "string", internalType: "string" }],
          stateMutability: "view",
        },
        // OZ v5 custom errors — these bubble up from transferFrom/allowance in UpDown.placeBet
        {
          type: "error",
          name: "ERC20InsufficientAllowance",
          inputs: [
            { name: "spender", type: "address", internalType: "address" },
            { name: "allowance", type: "uint256", internalType: "uint256" },
            { name: "needed", type: "uint256", internalType: "uint256" },
          ],
        },
        {
          type: "error",
          name: "ERC20InsufficientBalance",
          inputs: [
            { name: "sender", type: "address", internalType: "address" },
            { name: "balance", type: "uint256", internalType: "uint256" },
            { name: "needed", type: "uint256", internalType: "uint256" },
          ],
        },
        {
          type: "error",
          name: "ERC20InvalidSpender",
          inputs: [{ name: "spender", type: "address", internalType: "address" }],
        },
        {
          type: "error",
          name: "ERC20InvalidApprover",
          inputs: [{ name: "approver", type: "address", internalType: "address" }],
        },
        {
          type: "error",
          name: "ERC20InvalidReceiver",
          inputs: [{ name: "receiver", type: "address", internalType: "address" }],
        },
        {
          type: "error",
          name: "ERC20InvalidSender",
          inputs: [{ name: "sender", type: "address", internalType: "address" }],
        },
      ],
    },
    // CLAWD token on Base. Only used for symbol/balance reads, but still
    // register the ABI for errors so any bubble-up from a settle() swap
    // decodes cleanly instead of showing raw selectors.
    CLAWD: {
      address: "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07",
      abi: [
        {
          type: "function",
          name: "balanceOf",
          inputs: [{ name: "account", type: "address", internalType: "address" }],
          outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "decimals",
          inputs: [],
          outputs: [{ name: "", type: "uint8", internalType: "uint8" }],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "symbol",
          inputs: [],
          outputs: [{ name: "", type: "string", internalType: "string" }],
          stateMutability: "view",
        },
        {
          type: "error",
          name: "ERC20InsufficientAllowance",
          inputs: [
            { name: "spender", type: "address", internalType: "address" },
            { name: "allowance", type: "uint256", internalType: "uint256" },
            { name: "needed", type: "uint256", internalType: "uint256" },
          ],
        },
        {
          type: "error",
          name: "ERC20InsufficientBalance",
          inputs: [
            { name: "sender", type: "address", internalType: "address" },
            { name: "balance", type: "uint256", internalType: "uint256" },
            { name: "needed", type: "uint256", internalType: "uint256" },
          ],
        },
        {
          type: "error",
          name: "ERC20InvalidReceiver",
          inputs: [{ name: "receiver", type: "address", internalType: "address" }],
        },
      ],
    },
    // Uniswap V3 QuoterV2 on Base — used off-chain (eth_call simulation)
    // to derive minPayoutClawd / minBurnClawd on settle.
    QuoterV2: {
      address: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
      abi: [
        {
          type: "function",
          name: "quoteExactInput",
          inputs: [
            { name: "path", type: "bytes", internalType: "bytes" },
            { name: "amountIn", type: "uint256", internalType: "uint256" },
          ],
          outputs: [
            { name: "amountOut", type: "uint256", internalType: "uint256" },
            { name: "sqrtPriceX96AfterList", type: "uint160[]", internalType: "uint160[]" },
            { name: "initializedTicksCrossedList", type: "uint32[]", internalType: "uint32[]" },
            { name: "gasEstimate", type: "uint256", internalType: "uint256" },
          ],
          stateMutability: "nonpayable",
        },
      ],
    },
  },
} as const;

export default externalContracts satisfies GenericContractsDeclaration;
