/**
 * Chain Service
 * Handles balance checks and ERC20 token transfers on any EVM chain
 * Defaults to Base network and USDC token
 */

import { 
  createPublicClient, 
  createWalletClient, 
  http, 
  formatEther, 
  formatUnits, 
  parseUnits, 
  serializeTransaction,
  encodeFunctionData,
  toBytes,
  toHex,
  toRlp,
  type Address, 
  type Hex,
  type Chain
} from "viem";
import { base } from "viem/chains";
import { defineChain } from "viem";
import { ethers } from "ethers";
import { PKPAccount } from "./pkpSigner.js";
import { logger } from "../shared/logger.js";
import { sendGasSponsoredTransaction, waitForUserOperationTransaction, type GasSponsoredConfig } from "./gasSponsoredService.js";
import type { PKPSessionSigs } from "./litService.js";

// Default USDC contract address on Base
const DEFAULT_USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEFAULT_USDC_DECIMALS = 6;
const DEFAULT_CHAIN_ID = 8453; // Base

// Alchemy configuration
const ALCHEMY_BASE_RPC = process.env.ALCHEMY_BASE_RPC;
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const ALCHEMY_GAS_POLICY_ID = process.env.ALCHEMY_GAS_POLICY_ID;

// ERC20 ABI (minimal - just what we need)
const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    type: "function",
  },
  {
    constant: false,
    inputs: [
      { name: "_to", type: "address" },
      { name: "_value", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
] as const;

/**
 * Get chain configuration from chain ID
 * Supports common chains, defaults to Base
 */
function getChain(chainId?: number): Chain {
  if (!chainId || chainId === DEFAULT_CHAIN_ID) {
    return base;
  }
  
  // Support for other common chains
  // You can extend this with more chains as needed
  switch (chainId) {
    case 1: // Ethereum Mainnet
      return defineChain({
        id: 1,
        name: "Ethereum",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: {
          default: { http: ["https://eth.llamarpc.com"] },
        },
      });
    case 11155111: // Sepolia
      return defineChain({
        id: 11155111,
        name: "Sepolia",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: {
          default: { http: ["https://sepolia.infura.io/v3"] },
        },
      });
    default:
      // For unknown chains, create a basic chain definition
      // In production, you might want to use a chain registry or require RPC URL
      logger.warning(`Unknown chain ID ${chainId}, using Base as fallback`);
      return base;
  }
}

/**
 * Get RPC URL for a chain
 * Currently defaults to Alchemy Base RPC, but can be extended
 */
function getRpcUrl(chainId?: number): string {
  if (!chainId || chainId === DEFAULT_CHAIN_ID) {
    if (!ALCHEMY_BASE_RPC) {
      throw new Error("ALCHEMY_BASE_RPC environment variable is required for Base network");
    }
    return ALCHEMY_BASE_RPC;
  }
  
  // For other chains, you could use environment variables or a chain registry
  // For now, throw an error if not Base
  throw new Error(`RPC URL not configured for chain ID ${chainId}. Currently only Base (8453) is supported.`);
}

/**
 * Get public client for a chain
 */
function getPublicClient(chainId?: number) {
  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId);
  
  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
}

/**
 * Get wallet client using PKPAccount
 */
function getWalletClient(pkpAccount: PKPAccount, chainId?: number) {
  const chain = getChain(chainId);
  const rpcUrl = getRpcUrl(chainId);
  
  return createWalletClient({
    account: pkpAccount as any,
    chain,
    transport: http(rpcUrl),
  });
}

/**
 * Get token decimals dynamically from contract
 */
async function getTokenDecimals(tokenAddress: Address, chainId?: number): Promise<number> {
  try {
    const publicClient = getPublicClient(chainId);
    const decimals = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "decimals",
    }) as number;
    return decimals;
  } catch (error) {
    logger.warning(`Failed to get token decimals for ${tokenAddress}, defaulting to 18`, { error });
    return 18; // Default to 18 decimals
  }
}

/**
 * Get native token (ETH) and ERC20 token balances for a wallet address
 */
export async function getBalances(
  walletAddress: Address,
  options?: {
    chainId?: number;
    tokenAddress?: Address;
  }
): Promise<{
  native: string; // Native token balance (ETH, etc.)
  token: string; // ERC20 token balance
  tokenAddress: Address;
  chainId: number;
}> {
  const chainId = options?.chainId || DEFAULT_CHAIN_ID;
  const tokenAddress = options?.tokenAddress || DEFAULT_USDC_ADDRESS;
  
  logger.debug("Getting balances", { walletAddress, chainId, tokenAddress });

  const publicClient = getPublicClient(chainId);

  // Get native token balance
  const nativeBalance = await publicClient.getBalance({ address: walletAddress });
  const nativeFormatted = formatEther(nativeBalance);

  // Get ERC20 token balance
  const tokenBalance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [walletAddress],
  }) as bigint;
  
  // Get token decimals dynamically
  const tokenDecimals = await getTokenDecimals(tokenAddress, chainId);
  const tokenFormatted = formatUnits(tokenBalance, tokenDecimals);

  logger.debug("Balances retrieved", {
    walletAddress,
    chainId,
    native: nativeFormatted,
    token: tokenFormatted,
    tokenAddress,
  });

  return {
    native: nativeFormatted,
    token: tokenFormatted,
    tokenAddress,
    chainId,
  };
}


/**
 * Transfer ERC20 token on any EVM chain
 * Uses gas sponsorship with EIP-7702 if ALCHEMY_GAS_POLICY_ID is configured,
 * otherwise falls back to standard transaction signing
 */
export async function transferToken(
  pkpAccount: PKPAccount,
  to: Address,
  amount: string,
  options?: {
    chainId?: number;
    tokenAddress?: Address;
    tokenDecimals?: number;
    sessionSigs?: PKPSessionSigs; // Required for gas sponsorship
  }
): Promise<{
  transactionHash: Hex;
  chainId: number;
  tokenAddress: Address;
}> {
  const chainId = options?.chainId || DEFAULT_CHAIN_ID;
  const tokenAddress = options?.tokenAddress || DEFAULT_USDC_ADDRESS;
  
  logger.debug("Transferring token", {
    from: pkpAccount.address,
    to,
    amount,
    chainId,
    tokenAddress,
    useGasSponsorship: !!ALCHEMY_GAS_POLICY_ID,
  });

  // Get token decimals (use provided or fetch from contract)
  let tokenDecimals: number;
  if (options?.tokenDecimals !== undefined) {
    tokenDecimals = options.tokenDecimals;
  } else {
    const publicClient = getPublicClient(chainId);
    tokenDecimals = await getTokenDecimals(tokenAddress, chainId);
  }

  // Parse amount to token units
  const amountInUnits = parseUnits(amount, tokenDecimals);

  // Encode the function call
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, amountInUnits] as [Address, bigint],
  });

  // Use gas sponsorship - it's required for this implementation
  if (!ALCHEMY_GAS_POLICY_ID || !ALCHEMY_API_KEY || !options?.sessionSigs) {
    throw new Error(
      'Gas sponsorship is required. Please configure ALCHEMY_GAS_POLICY_ID, ALCHEMY_API_KEY, and provide sessionSigs.'
    );
  }

  logger.debug("Sending gas-sponsored transaction with EIP-7702");
  
  const gasSponsoredConfig: GasSponsoredConfig = {
    pkpPublicKey: pkpAccount.publicKey,
    pkpAddress: pkpAccount.address,
    sessionSigs: options.sessionSigs,
    chainId,
    alchemyApiKey: ALCHEMY_API_KEY,
    alchemyPolicyId: ALCHEMY_GAS_POLICY_ID,
  };

  // Send gas-sponsored transaction
  const uoHash = await sendGasSponsoredTransaction(
    gasSponsoredConfig,
    tokenAddress,
    0n, // value is 0 for ERC20 transfers
    data
  );

  logger.debug("Gas-sponsored user operation sent", { userOpHash: uoHash });

  // Wait for the user operation to be mined
  const result = await waitForUserOperationTransaction(uoHash, gasSponsoredConfig);

  logger.debug("Gas-sponsored transaction confirmed", {
    transactionHash: result.hash,
    chainId,
    tokenAddress,
  });

  return {
    transactionHash: result.hash,
    chainId,
    tokenAddress,
  };
}
