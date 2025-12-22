/**
 * Lit Protocol Service
 * Handles PKP wallet operations using Auth0 OAuth
 */

import { ethers } from "ethers";
import { LitContracts } from "@lit-protocol/contracts-sdk";
import { LitNetwork, AUTH_METHOD_SCOPE, AUTH_METHOD_TYPE, LIT_ABILITY } from "@lit-protocol/constants";
import { LitNodeClient } from "@lit-protocol/lit-node-client";
import { LitPKPResource } from "@lit-protocol/auth-helpers";
import { datil, datilDev, datilTest } from "@lit-protocol/contracts";
import IpfsHash from "ipfs-only-hash";
import bs58 from "bs58";
import { litActionCode } from "./litAction.js";
import { logger } from "../shared/logger.js";
import { addPayee } from "./addPayee.js";

export interface PKP {
  tokenId: string;
  publicKey: string;
  ethAddress: string;
}

export interface PKPSessionSigs {
  [key: string]: any;
}

interface CapacityToken {
  tokenId: string;
  URI: { description: string; image_data: string; name: string };
  capacity: {
    expiresAt: { formatted: string; timestamp: number };
    requestsPerMillisecond: number;
  };
  isExpired: boolean;
}

// Use "datil" network directly (supported in v7)
// LitNetwork is an enum object, so we need to use the string value
const LIT_NETWORK_ENV = (process.env.LIT_NETWORK || "datil").toLowerCase();
const LIT_NETWORK = LIT_NETWORK_ENV === "datil" ? LitNetwork.Datil : (LIT_NETWORK_ENV as any);
const LIT_RPC_URL = process.env.LIT_RPC_URL || "https://yellowstone-rpc.litprotocol.com";
const LIT_PRIVATE_KEY = process.env.LIT_PRIVATE_KEY;
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || "";
// Enable transaction simulation for debugging (disabled by default to reduce overhead)
// Set LIT_ENABLE_TX_SIMULATION=true to enable detailed revert reason decoding
const ENABLE_TX_SIMULATION = process.env.LIT_ENABLE_TX_SIMULATION === "true";

if (!LIT_PRIVATE_KEY) {
  throw new Error("LIT_PRIVATE_KEY environment variable is required");
}

// Map LitNetwork enum value to valid LitContracts network
// v7 supports: 'datil' | 'cayenne' | 'manzano' | 'habanero' | 'custom' | 'localhost'
function getLitContractsNetwork(network: string): string {
  const networkStr = network.toLowerCase();
  if (['datil', 'cayenne', 'manzano', 'habanero', 'custom', 'localhost'].includes(networkStr)) {
    return networkStr;
  }
  // Default to datil for unknown networks
  logger.warning(`Unknown network "${networkStr}", defaulting to "datil" for LitContracts`);
  return 'datil';
}

let litNodeClient: LitNodeClient | null = null;
let litContractsClient: LitContracts | null = null;
// Cache for capacity credit token ID - initialized at startup
let cachedCapacityTokenId: string | null = null;

function getProvider(): ethers.providers.JsonRpcProvider {
  return new ethers.providers.JsonRpcProvider(LIT_RPC_URL);
}

function getSigner(): ethers.Wallet {
  const provider = getProvider();
  // LIT_PRIVATE_KEY is checked at module load time, so it's safe here
  const privateKey = (LIT_PRIVATE_KEY as string).startsWith("0x") ? LIT_PRIVATE_KEY as string : `0x${LIT_PRIVATE_KEY}`;
  return new ethers.Wallet(privateKey, provider);
}

export async function getLitNodeClient(): Promise<LitNodeClient> {
  if (litNodeClient === null) {
    logger.debug("Connecting LitNode client", { network: LIT_NETWORK });
    litNodeClient = new LitNodeClient({
      litNetwork: LIT_NETWORK,
      debug: process.env.LIT_DEBUG === "true",
    });
    await litNodeClient.connect();
    logger.debug("Connected LitNode client", { network: LIT_NETWORK });
  }
  return litNodeClient;
}

async function getLitContractsClient(): Promise<LitContracts> {
  if (litContractsClient === null) {
    const signer = getSigner();
    const provider = getProvider();
    const contractsNetwork = getLitContractsNetwork(LIT_NETWORK);
    logger.debug("Connecting LitContracts client", { 
      litNetwork: LIT_NETWORK,
      contractsNetwork,
      rpcUrl: LIT_RPC_URL 
    });
    try {
      litContractsClient = new LitContracts({
        signer: signer as any,
        network: contractsNetwork as any, // LIT_NETWORKS_KEYS type
        // Explicitly pass provider to ensure it's available
        provider: provider as any,
      });
      await litContractsClient.connect();
      logger.debug("Connected LitContracts client", { 
        litNetwork: LIT_NETWORK,
        contractsNetwork 
      });
    } catch (error) {
      logger.error("Failed to connect LitContracts client", error as Error, {
        litNetwork: LIT_NETWORK,
        contractsNetwork,
        rpcUrl: LIT_RPC_URL
      });
      throw error;
    }
  }
  return litContractsClient;
}

/**
 * Initialize Lit services at startup
 * This pre-initializes the singleton clients to avoid lazy initialization on first request
 * Also pre-queries and caches the capacity credit token to avoid delays on user requests
 */
export async function initializeLitServices(): Promise<void> {
  logger.info("Initializing Lit services", { network: LIT_NETWORK });
  try {
    // Initialize both clients in parallel for faster startup
    await Promise.all([
      getLitNodeClient(),
      getLitContractsClient(),
    ]);
    
    // Pre-query and cache capacity credit token at startup
    // This avoids the ~20 second delay on first user request
    logger.info("Pre-querying capacity credit token", { network: LIT_NETWORK });
    try {
      const signer = getSigner();
      
      // Check environment variable first
      if (process.env.LIT_CAPACITY_CREDIT_TOKEN_ID) {
        cachedCapacityTokenId = process.env.LIT_CAPACITY_CREDIT_TOKEN_ID;
        logger.info("Using capacity credit from environment variable", { 
          capacityTokenId: cachedCapacityTokenId 
        });
      } else {
        // Query existing capacity credits to find a non-expired one
        const capacityTokens = await queryCapacityCredits(signer);
        const nonExpiredToken = capacityTokens.find((token) => !token.isExpired);
        
        if (nonExpiredToken) {
          cachedCapacityTokenId = nonExpiredToken.tokenId;
          logger.info("Cached existing non-expired capacity credit", { 
            capacityTokenId: cachedCapacityTokenId 
          });
        } else {
          // Mint a new one if none exist
          const litContracts = await getLitContractsClient();
          logger.info("No non-expired capacity credits found, minting new one");
          const result = await litContracts.mintCapacityCreditsNFT({
            requestsPerKilosecond: 10,
            daysUntilUTCMidnightExpiration: 1,
          });
          cachedCapacityTokenId = result.capacityTokenIdStr;
          logger.info("Minted and cached new capacity credit", { 
            capacityTokenId: cachedCapacityTokenId 
          });
        }
      }
    } catch (error) {
      logger.warning("Failed to pre-query capacity credit, will query on first request", { 
        error: (error as Error).message 
      });
      // Don't fail startup if capacity credit query fails - we can query it later
    }
    
    logger.info("Lit services initialized successfully", { 
      network: LIT_NETWORK,
      capacityTokenCached: !!cachedCapacityTokenId
    });
  } catch (error) {
    logger.error("Failed to initialize Lit services", error as Error, { network: LIT_NETWORK });
    throw error;
  }
}

function getOAuthAuthMethodInfo(userId: string) {
  return {
    authMethodType: ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("AUTH0_AUTH_METHOD_V09")
    ),
    authMethodId: ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(`oauth:${userId}`)
    ),
  };
}

async function getLitActionCodeIpfsCid(): Promise<string> {
  const litActionIpfsCid = await IpfsHash.of(litActionCode);
  return litActionIpfsCid;
}

async function getPkpMintCost(litContracts: LitContracts): Promise<ethers.BigNumber> {
  try {
    const mintCost = await litContracts.pkpNftContract.read.mintCost();
    logger.debug("Fetched PKP mint cost from contract", {
      mintCost: mintCost?.toString(),
      mintCostHex: mintCost?.toHexString(),
      mintCostType: typeof mintCost,
      isBigNumber: ethers.BigNumber.isBigNumber(mintCost),
    });
    return mintCost;
  } catch (error) {
    logger.error("Failed to fetch PKP mint cost", error as Error);
    throw error;
  }
}

async function getPkpInfoFromMintReceipt(
  txReceipt: ethers.ContractReceipt,
  litContractsClient: LitContracts
): Promise<PKP> {
  const pkpMintedEvent = txReceipt.events?.find(
    (event) =>
      event.topics[0] ===
      "0x3b2cc0657d0387a736293d66389f78e4c8025e413c7a1ee67b7707d4418c46b8"
  );

  if (!pkpMintedEvent || !pkpMintedEvent.data) {
    throw new Error("PKP minted event not found in transaction receipt");
  }

  const publicKey = "0x" + pkpMintedEvent.data.slice(130, 260);
  const tokenId = ethers.utils.keccak256(publicKey);
  const ethAddress = await litContractsClient.pkpNftContract.read.getEthAddress(tokenId);

  return {
    tokenId: ethers.BigNumber.from(tokenId).toString(),
    publicKey,
    ethAddress,
  };
}

/**
 * Get RateLimitNFT contract instance for querying capacity credits
 */
function getRateLimitNFTContract(): ethers.Contract {
  const signer = getSigner();
  
  // Get contract data from @lit-protocol/contracts package based on network
  let contractsData: any;
  const networkStr = LIT_NETWORK_ENV.toLowerCase();
  
  if (networkStr === "datil-dev") {
    contractsData = datilDev.data as any;
  } else if (networkStr === "datil-test") {
    contractsData = datilTest.data as any;
  } else {
    // Default to datil
    contractsData = datil.data as any;
  }
  
  const contractData = contractsData.find(
    (contract: any) => contract.name === "RateLimitNFT"
  );
  
  if (!contractData) {
    throw new Error(`RateLimitNFT contract not found for network ${networkStr}`);
  }
  
  const contract = contractData.contracts[0];
  return new ethers.Contract(
    contract.address_hash,
    contract.ABI,
    signer
  );
}

/**
 * Normalize token URI from base64 encoded JSON
 */
function normalizeTokenURI(tokenURI: string): { description: string; image_data: string; name: string } {
  const base64 = tokenURI[0];
  const data = base64.split("data:application/json;base64,")[1];
  const dataToString = Buffer.from(data, "base64").toString("binary");
  return JSON.parse(dataToString);
}

/**
 * Normalize capacity data from contract response
 */
function normalizeCapacity(capacity: any): { requestsPerMillisecond: number; expiresAt: { formatted: string; timestamp: number } } {
  const [requestsPerMillisecond, expiresAt] = capacity[0];
  const timestamp = parseInt(expiresAt.toString());
  return {
    requestsPerMillisecond: parseInt(requestsPerMillisecond.toString()),
    expiresAt: {
      timestamp,
      formatted: new Date(timestamp * 1000).toISOString(),
    },
  };
}

/**
 * Query a single capacity credit token
 */
async function queryCapacityCredit(
  contract: ethers.Contract,
  owner: string,
  tokenIndexForUser: number
): Promise<CapacityToken> {
  const tokenId = (
    await contract.functions.tokenOfOwnerByIndex(owner, tokenIndexForUser)
  ).toString();

  try {
    const [URI, capacity, isExpired] = await Promise.all([
      contract.functions.tokenURI(tokenId).then(normalizeTokenURI),
      contract.functions.capacity(tokenId).then(normalizeCapacity),
      contract.functions.isExpired(tokenId),
    ]);

    return {
      tokenId,
      URI,
      capacity,
      isExpired: isExpired[0],
    };
  } catch (e) {
    throw new Error(
      `Failed to fetch details for capacity token ${tokenId}: ${e}`
    );
  }
}

/**
 * Query all capacity credits owned by the signer
 */
async function queryCapacityCredits(signer: ethers.Wallet): Promise<CapacityToken[]> {
  const contract = getRateLimitNFTContract();
  const balanceResult = await contract.functions.balanceOf(signer.address);
  const count = parseInt(balanceResult[0].toString());

  if (count === 0) {
    return [];
  }

  return Promise.all(
    [...new Array(count)].map((_, i) =>
      queryCapacityCredit(contract, signer.address, i)
    )
  );
}

async function getCapacityCredit(): Promise<string> {
  // Use cached value if available (set at startup)
  if (cachedCapacityTokenId) {
    // Verify the cached token is still valid (not expired)
    try {
      const contract = getRateLimitNFTContract();
      const isExpired = await contract.functions.isExpired(cachedCapacityTokenId);
      
      if (!isExpired[0]) {
        logger.debug("Using cached capacity credit", { capacityTokenId: cachedCapacityTokenId });
        return cachedCapacityTokenId;
      } else {
        logger.debug("Cached capacity credit expired, will refresh", { 
          expiredTokenId: cachedCapacityTokenId 
        });
        cachedCapacityTokenId = null; // Clear expired cache
      }
    } catch (error) {
      logger.warning("Failed to verify cached capacity credit, will refresh", { error });
      cachedCapacityTokenId = null; // Clear invalid cache
    }
  }

  // Fallback: query or mint if cache is empty or expired
  const signer = getSigner();
  const litContracts = await getLitContractsClient();

  // Check environment variable
  let capacityTokenId = process.env.LIT_CAPACITY_CREDIT_TOKEN_ID;

  if (!capacityTokenId) {
    // Query existing capacity credits to find a non-expired one
    logger.debug("Querying existing capacity credits");
    try {
      const capacityTokens = await queryCapacityCredits(signer);
      const nonExpiredToken = capacityTokens.find((token) => !token.isExpired);
      
      if (nonExpiredToken) {
        capacityTokenId = nonExpiredToken.tokenId;
        cachedCapacityTokenId = capacityTokenId; // Update cache
        logger.debug("Found existing non-expired capacity credit", { capacityTokenId });
        return capacityTokenId;
      }
      
      logger.debug("No non-expired capacity credits found, will mint new one");
    } catch (error) {
      logger.warning("Failed to query existing capacity credits, will mint new one", { error });
    }

    // Only mint if no non-expired token exists
    logger.debug("Minting Capacity Credits NFT");
    const result = await litContracts.mintCapacityCreditsNFT({
      requestsPerKilosecond: 10,
      daysUntilUTCMidnightExpiration: 1,
    });
    capacityTokenId = result.capacityTokenIdStr;
    cachedCapacityTokenId = capacityTokenId; // Update cache
    logger.debug("Minted Capacity Credit", { capacityTokenId });
  } else {
    // Environment variable set - cache it
    cachedCapacityTokenId = capacityTokenId;
  }

  return capacityTokenId;
}

/**
 * Get PKPs for a given Auth0 user ID
 */
export async function getPKPsForAuthMethod(userId: string): Promise<PKP[]> {
  const litContracts = await getLitContractsClient();
  const { authMethodType, authMethodId } = getOAuthAuthMethodInfo(userId);

  try {
    const tokenIds = await litContracts.pkpPermissionsContract.read.getTokenIdsForAuthMethod(
      authMethodType,
      authMethodId
    );

    const pkps: PKP[] = [];
    for (const tokenId of tokenIds) {
      try {
        const pubkey = await litContracts.pkpPermissionsContract.read.getPubkey(tokenId);
        if (pubkey) {
          const ethAddress = ethers.utils.computeAddress(pubkey);
          pkps.push({
            tokenId: ethers.BigNumber.from(tokenId).toString(),
            publicKey: pubkey,
            ethAddress,
          });
        }
      } catch (error) {
        logger.warning("Failed to get PKP info", { tokenId, error });
      }
    }

    return pkps;
  } catch (error) {
    logger.error("Failed to get PKPs for auth method", error as Error, { userId });
    throw new Error("Unable to get PKPs for auth method");
  }
}

/**
 * Verify PKP auth methods and scopes
 * Checks that the PKP was minted with the correct auth methods and scopes
 */
export async function verifyPkpAuthMethods(pkp: PKP): Promise<{
  hasLitAction: boolean;
  litActionHasSignAnything: boolean;
  issues: string[];
}> {
  const litContracts = await getLitContractsClient();
  const litActionIpfsCid = await getLitActionCodeIpfsCid();
  const expectedLitActionId = `0x${Buffer.from(bs58.decode(litActionIpfsCid)).toString("hex")}`;
  const litActionType = ethers.BigNumber.from(AUTH_METHOD_TYPE.LitAction);
  const signAnythingScope = ethers.BigNumber.from(AUTH_METHOD_SCOPE.SignAnything);
  
  const issues: string[] = [];
  let hasLitAction = false;
  let litActionHasSignAnything = false;
  
  try {
    // Get all auth methods for this PKP
    const authMethods = await litContracts.pkpPermissionsContract.read.getPermittedAuthMethods(
      pkp.tokenId
    );
    
    logger.debug("Checking PKP auth methods", {
      tokenId: pkp.tokenId,
      authMethodCount: authMethods.length,
    });
    
    // Check each auth method
    for (const method of authMethods) {
      const methodType = ethers.BigNumber.from(method.authMethodType);
      const methodId = method.id;
      
      // Check if it's a Lit Action
      if (methodType.eq(litActionType)) {
        hasLitAction = true;
        
        // Verify it's the correct Lit Action CID
        if (methodId.toLowerCase() !== expectedLitActionId.toLowerCase()) {
          const cid = bs58.encode(Buffer.from(methodId.replace(/^0x/, ""), "hex"));
          issues.push(`Lit Action CID mismatch: got ${cid}, expected ${litActionIpfsCid}`);
          logger.warning("Lit Action CID mismatch", {
            tokenId: pkp.tokenId,
            got: cid,
            expected: litActionIpfsCid,
          });
        }
        
        // Check if SignAnything scope is present
        const hasScope = await litContracts.pkpPermissionsContract.read.isPermittedAuthMethodScopePresent(
          pkp.tokenId,
          litActionType,
          methodId,
          signAnythingScope
        );
        
        if (hasScope) {
          litActionHasSignAnything = true;
          logger.debug("Lit Action has SignAnything scope", { tokenId: pkp.tokenId });
        } else {
          issues.push(`Lit Action missing SignAnything scope (scope 2)`);
          logger.warning("Lit Action missing SignAnything scope", { tokenId: pkp.tokenId });
        }
      }
    }
    
    if (!hasLitAction) {
      issues.push("PKP does not have a Lit Action auth method");
      logger.warning("PKP missing Lit Action auth method", { tokenId: pkp.tokenId });
    }
    
    return {
      hasLitAction,
      litActionHasSignAnything,
      issues,
    };
  } catch (error) {
    logger.error("Failed to verify PKP auth methods", error as Error, { tokenId: pkp.tokenId });
    throw error;
  }
}

/**
 * Mint a new PKP wallet for a user (direct contract call)
 */
export async function mintPKPDirectly(
  userId: string,
  permittedAuthMethodTypes: ethers.BigNumber[],
  permittedAuthMethodIds: string[],
  permittedAuthMethodPubkeys: string[],
  permittedAuthMethodScopes: ethers.BigNumber[][],
  litActionTypeBigNumber: ethers.BigNumber
): Promise<PKP> {
  const signer = getSigner();
  const litContracts = await getLitContractsClient();
  const pkpMintCost = await getPkpMintCost(litContracts);

  logger.debug("Minting new PKP", { userId });

  // Ensure mint cost is a BigNumber
  const mintCostValue = ethers.BigNumber.from(pkpMintCost);

  logger.debug("Minting PKP with parameters", {
    keyType: AUTH_METHOD_TYPE.LitAction,
    permittedAuthMethodTypes: permittedAuthMethodTypes.map(bn => bn.toString()),
    permittedAuthMethodIds,
    permittedAuthMethodScopes: permittedAuthMethodScopes.map(scopes => scopes.map(s => s.toString())),
    mintCost: mintCostValue.toString(),
    mintCostHex: mintCostValue.toHexString(),
    arrayLengths: {
      types: permittedAuthMethodTypes.length,
      ids: permittedAuthMethodIds.length,
      pubkeys: permittedAuthMethodPubkeys.length,
      scopes: permittedAuthMethodScopes.length,
    },
  });

  // Use populateTransaction first to get transaction data (like the working example)
  const pkpHelperContract = litContracts.pkpHelperContract.write;
  const mintTxData = await pkpHelperContract.populateTransaction.mintNextAndAddAuthMethods(
    litActionTypeBigNumber, // keyType as BigNumber
    permittedAuthMethodTypes,
    permittedAuthMethodIds,
    permittedAuthMethodPubkeys,
    permittedAuthMethodScopes,
    true, // addPkpEthAddressAsPermittedAddress
    true, // sendPkpToItself
    { value: mintCostValue }
  );

  // Manually estimate gas with error handling (like the working example)
  // This helps avoid gas estimation failures that can cause transaction reverts
  let gasLimit: ethers.BigNumber;
  const provider = getProvider();
  try {
    gasLimit = await provider.estimateGas(mintTxData);
    // Add buffer (multiply by percentage, then divide by 100)
    // Default to 200% (double) if env var not set, matching working example pattern
    const gasIncreasePercentage = parseInt(process.env.GAS_LIMIT_INCREASE_PERCENTAGE || "200");
    gasLimit = gasLimit.mul(ethers.BigNumber.from(gasIncreasePercentage)).div(ethers.BigNumber.from(100));
    logger.debug("Estimated and adjusted gas limit", { 
      gasLimit: gasLimit.toString(),
      gasIncreasePercentage 
    });
  } catch (e) {
    logger.warning("Error estimating gas, using default", { error: e });
    // Use default gas limit if estimation fails
    gasLimit = ethers.BigNumber.from(5000000);
  }

  // Execute the transaction with explicit gas limit
  let tx;
  try {
    tx = await pkpHelperContract.mintNextAndAddAuthMethods(
      litActionTypeBigNumber, // keyType as BigNumber
      permittedAuthMethodTypes,
      permittedAuthMethodIds,
      permittedAuthMethodPubkeys,
      permittedAuthMethodScopes,
      true, // addPkpEthAddressAsPermittedAddress
      true, // sendPkpToItself
      { value: mintCostValue, gasLimit }
    );
  } catch (error: any) {
    logger.error("Transaction send failed", error as Error, {
      gasLimit: gasLimit.toString(),
      mintCost: mintCostValue.toString(),
    });
    throw error;
  }

  let receipt;
  try {
    receipt = await tx.wait();
    logger.debug("PKP minted", { transactionHash: receipt.transactionHash });
  } catch (error: any) {
    // Transaction was sent but reverted
    if (error.receipt) {
      logger.error("Transaction reverted", error as Error, {
        transactionHash: error.receipt.transactionHash,
        status: error.receipt.status,
        gasUsed: error.receipt.gasUsed?.toString(),
        blockNumber: error.receipt.blockNumber,
      });
    }
    throw error;
  }

  const mintedPKP = await getPkpInfoFromMintReceipt(receipt, litContracts);

  // Add the new PKP as a payee
  try {
    await addPayee(mintedPKP.ethAddress);
  } catch (err) {
    console.warn('Failed to add payee', err);
    throw err;
  }

  return mintedPKP;
}

/**
 * Mint a new PKP wallet for a user using the Lit relayer
 */
export async function mintPKPWithRelayer(
  userId: string,
  permittedAuthMethodTypes: ethers.BigNumber[],
  permittedAuthMethodIds: string[],
  permittedAuthMethodPubkeys: string[],
  permittedAuthMethodScopes: ethers.BigNumber[][],
  litActionTypeBigNumber: ethers.BigNumber
): Promise<PKP> {
  const litContracts = await getLitContractsClient();

  logger.debug("Minting new PKP with relayer", { userId });

  // Convert BigNumbers to strings for JSON serialization
  const permittedAuthMethodTypesStr = permittedAuthMethodTypes.map(bn => bn.toString());
  const permittedAuthMethodScopesStr = permittedAuthMethodScopes.map(scopes => 
    scopes.map(s => s.toString())
  );

  // Determine relayer URL based on network
  const relayerBaseUrl = process.env.LIT_RELAYER_URL || 
    (LIT_NETWORK_ENV === "datil" 
      ? "https://datil-relayer.getlit.dev" 
      : `https://${LIT_NETWORK_ENV}-relayer.getlit.dev`);
  const relayerUrl = `${relayerBaseUrl}/mint-next-and-add-auth-methods`;
  const relayerApiKey = process.env.LIT_RELAYER_API_KEY || "test-api-key";

  logger.debug("Calling relayer", {
    relayerUrl,
    keyType: litActionTypeBigNumber.toString(),
    permittedAuthMethodTypes: permittedAuthMethodTypesStr,
  });

  const requestBody = {
    keyType: litActionTypeBigNumber.toString(),
    permittedAuthMethodTypes: permittedAuthMethodTypesStr,
    permittedAuthMethodIds,
    permittedAuthMethodPubkeys,
    permittedAuthMethodScopes: permittedAuthMethodScopesStr,
    addPkpEthAddressAsPermittedAddress: true,
    sendPkpToItself: true,
  };

  const relayerResponse = await fetch(relayerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": relayerApiKey,
    },
    body: JSON.stringify(requestBody),
  });

  if (!relayerResponse.ok) {
    const errorText = await relayerResponse.text();
    logger.error("Relayer request failed", new Error(errorText), {
      status: relayerResponse.status,
      statusText: relayerResponse.statusText,
      relayerUrl,
    });
    throw new Error(
      `Failed to mint PKP via relayer: ${relayerResponse.status} ${relayerResponse.statusText} - ${errorText}`
    );
  }

  const relayerResponseJson = await relayerResponse.json() as { requestId?: string };
  const txHash = relayerResponseJson.requestId;

  if (!txHash) {
    throw new Error("Relayer response missing requestId/transaction hash");
  }

  logger.debug("Relayer transaction submitted", { txHash });

  // Wait for transaction and verify
  const provider = getProvider();
  let txReceipt: ethers.ContractReceipt;
  try {
    txReceipt = await provider.waitForTransaction(txHash);
  } catch (error) {
    logger.error("Failed to wait for relayer transaction", error as Error, { txHash });
    throw error;
  }

  if (txReceipt.status !== 1) {
    const error = new Error(
      `Transaction failed with status: ${txReceipt.status}. Transaction hash: ${txHash}`
    );
    logger.error("Relayer transaction failed", error, { txHash, status: txReceipt.status });
    throw error;
  }

  logger.debug("Relayer transaction confirmed", { txHash });

  // Extract PKP info from transaction receipt
  const mintedPKP = await getPkpInfoFromMintReceipt(txReceipt, litContracts);

  // Add the new PKP as a payee
  try {
    await addPayee(mintedPKP.ethAddress);
  } catch (err) {
    logger.warning("Failed to add payee", { error: err });
    // Don't throw - payee addition is not critical for PKP creation
  }

  logger.debug("PKP minted via relayer", {
    tokenId: mintedPKP.tokenId,
    ethAddress: mintedPKP.ethAddress,
    txHash,
  });

  return mintedPKP;
}

/**
 * Mint a new PKP wallet for a user
 * Tries relayer first, falls back to direct minting if relayer fails
 */
export async function mintPKP(
  userId: string,
  oauthAccessToken: string
): Promise<PKP> {
  const { authMethodType, authMethodId } = getOAuthAuthMethodInfo(userId);
  const litActionIpfsCid = await getLitActionCodeIpfsCid();

  // Convert authMethodType (keccak256 hex string) to BigNumber for uint256 array
  // The contract expects uint256[], so we need to convert the hex string to BigNumber
  const authMethodTypeBigNumber = ethers.BigNumber.from(authMethodType);
  
  // Ensure all uint256 values are BigNumbers for consistency
  const litActionTypeBigNumber = ethers.BigNumber.from(AUTH_METHOD_TYPE.LitAction);
  
  // Prepare parameters - ensure all uint256 values are BigNumbers
  // These are shared between both direct and relayer minting methods
  const permittedAuthMethodTypes = [litActionTypeBigNumber, authMethodTypeBigNumber];
  const permittedAuthMethodIds = [
    `0x${Buffer.from(bs58.decode(litActionIpfsCid)).toString("hex")}`,
    authMethodId,
  ];
  const permittedAuthMethodPubkeys = ["0x", "0x"];
  // Ensure scope values are also BigNumbers
  // Note: PKPSigning ability requires PersonalSign scope (2), not just SignAnything (1)
  // Include both SignAnything and PersonalSign for maximum compatibility
  const permittedAuthMethodScopes = [
    [
      ethers.BigNumber.from(AUTH_METHOD_SCOPE.SignAnything),
      ethers.BigNumber.from(AUTH_METHOD_SCOPE.PersonalSign),
    ],
    [ethers.BigNumber.from(AUTH_METHOD_SCOPE.NoPermissions)],
  ];
  
  // Validate array lengths match (as per contract requirements)
  if (permittedAuthMethodTypes.length !== permittedAuthMethodIds.length) {
    throw new Error(`Array length mismatch: permittedAuthMethodTypes (${permittedAuthMethodTypes.length}) != permittedAuthMethodIds (${permittedAuthMethodIds.length})`);
  }
  if (permittedAuthMethodTypes.length !== permittedAuthMethodPubkeys.length) {
    throw new Error(`Array length mismatch: permittedAuthMethodTypes (${permittedAuthMethodTypes.length}) != permittedAuthMethodPubkeys (${permittedAuthMethodPubkeys.length})`);
  }
  if (permittedAuthMethodTypes.length !== permittedAuthMethodScopes.length) {
    throw new Error(`Array length mismatch: permittedAuthMethodTypes (${permittedAuthMethodTypes.length}) != permittedAuthMethodScopes (${permittedAuthMethodScopes.length})`);
  }

  // Try relayer first
  try {
    logger.debug("Attempting to mint PKP via relayer", { userId });
    return await mintPKPWithRelayer(
      userId,
      permittedAuthMethodTypes,
      permittedAuthMethodIds,
      permittedAuthMethodPubkeys,
      permittedAuthMethodScopes,
      litActionTypeBigNumber
    );
  } catch (error) {
    logger.warning("Relayer minting failed, falling back to direct minting", {
      userId,
      error: (error as Error).message,
    });
    
    // Fall back to direct minting
    logger.debug("Using direct minting for PKP", { userId });
    return await mintPKPDirectly(
      userId,
      permittedAuthMethodTypes,
      permittedAuthMethodIds,
      permittedAuthMethodPubkeys,
      permittedAuthMethodScopes,
      litActionTypeBigNumber
    );
  }
}

/**
 * Get PKP session signatures for signing
 */
export async function getPkpSessionSigs(
  userId: string,
  oauthAccessToken: string,
  pkp: PKP
): Promise<PKPSessionSigs> {
  const litNodeClient = await getLitNodeClient();

  const signer = getSigner();
  const capacityTokenId = await getCapacityCredit();

  logger.debug("Creating capacity delegation auth sig", { 
    pkpAddress: pkp.ethAddress,
    capacityTokenId,
    signerAddress: signer.address,
    network: LIT_NETWORK_ENV,
  });

  const { capacityDelegationAuthSig } =
    await litNodeClient.createCapacityDelegationAuthSig({
      dAppOwnerWallet: signer as any,
      capacityTokenId,
      delegateeAddresses: [pkp.ethAddress],
      uses: "1",
    });

  logger.debug("Created capacity delegation auth sig", {
    capacityTokenId,
    pkpAddress: pkp.ethAddress,
  });

  logger.debug("Getting Lit Action session signatures", { 
    pkpPublicKey: pkp.publicKey,
    pkpTokenId: pkp.tokenId,
    pkpEthAddress: pkp.ethAddress,
  });

  // Use getLitActionSessionSigs when authentication is via Lit Action
  // See: https://developer.litprotocol.com/sdk/authentication/session-sigs/get-lit-action-session-sigs
  // Note: capacity delegation is not needed since the PKP is registered as a payee via addPayee
  const litClient = litNodeClient as any;

  // Log detailed information for debugging production vs localhost differences
  const litActionCodeBase64 = Buffer.from(litActionCode).toString("base64");
  
  // Sign the OAuth token with LIT_PRIVATE_KEY signer to get the expected audience address
  // The Lit Action will recover this address from the signature to validate the token audience
  const oauthTokenSignature = await signer.signMessage(oauthAccessToken);
  
  const jsParams = {
    oauthUserData: JSON.stringify({
      accessToken: oauthAccessToken,
    }),
    pkpTokenId: pkp.tokenId,
    oauthTokenSignature: oauthTokenSignature,
  };
  const resourceAbilityRequests = [
    {
      resource: new LitPKPResource("*"),
      ability: LIT_ABILITY.PKPSigning,
    },
  ];
  // Session signature duration - configurable via env var, defaults to 10 minutes
  // Should match or be shorter than the MAX_TOKEN_AGE_SECONDS constant in litAction.ts (600 seconds = 10 minutes)
  const sessionSigDurationMinutes = parseInt(process.env.LIT_SESSION_SIG_DURATION_MINUTES || "10", 10);
  const expiration = new Date(Date.now() + 1000 * 60 * sessionSigDurationMinutes).toISOString();

  const sessionSignatures = await litClient.getLitActionSessionSigs({
    pkpPublicKey: pkp.publicKey,
    capabilityAuthSigs: [capacityDelegationAuthSig],
    litActionCode: litActionCodeBase64,
    debug: process.env.LIT_DEBUG === "true",
    jsParams,
    resourceAbilityRequests,
    expiration,
  });

  logger.debug("Got PKP session signatures", {
    sessionSigsKeys: Object.keys(sessionSignatures),
    sessionSigsCount: Object.keys(sessionSignatures).length,
  });
  return sessionSignatures;
}

/**
 * Sign data with PKP
 * For messages and typed data, dataToSign is already a hash (hex string)
 * We should treat it as hex bytes directly, not as UTF-8 text
 */
export async function pkpSign(
  sessionSigs: PKPSessionSigs,
  pkpPublicKey: string,
  dataToSign: string
): Promise<string> {
  const litNodeClient = await getLitNodeClient();

  logger.debug("Signing data with PKP", { pkpPublicKey });

  // dataToSign is already a hash (hex string), so treat it as hex bytes directly
  // This matches how pkpSignTransaction handles transaction hashes
  const hashBytes = ethers.utils.arrayify(dataToSign);

  const res = await litNodeClient.pkpSign({
    pubKey: pkpPublicKey,
    sessionSigs,
    toSign: hashBytes,
  });

  logger.debug("Signed data with PKP");
  return res.signature;
}

/**
 * Sign transaction hash with PKP
 * For transactions, we sign the keccak256 hash of the RLP-encoded transaction
 */
export async function pkpSignTransaction(
  sessionSigs: PKPSessionSigs,
  pkpPublicKey: string,
  transactionHash: string
): Promise<string> {
  const litNodeClient = await getLitNodeClient();

  logger.debug("Signing transaction hash with PKP", { pkpPublicKey });

  // transactionHash is already a keccak256 hash (hex string)
  // Convert hex string to bytes directly (not UTF-8)
  const hashBytes = ethers.utils.arrayify(transactionHash);

  const res = await litNodeClient.pkpSign({
    pubKey: pkpPublicKey,
    sessionSigs,
    toSign: hashBytes,
  });

  logger.debug("Signed transaction hash with PKP");
  return res.signature;
}

