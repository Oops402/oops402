/**
 * Lit Protocol Service
 * Handles PKP wallet operations using Auth0 OAuth
 */

import { ethers } from "ethers";
import { LitContracts } from "@lit-protocol/contracts-sdk";
import { LitNetwork, AUTH_METHOD_SCOPE, AUTH_METHOD_TYPE, LIT_ABILITY } from "@lit-protocol/constants";
import { LitNodeClient } from "@lit-protocol/lit-node-client";
import { LitPKPResource } from "@lit-protocol/auth-helpers";
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

function getProvider(): ethers.providers.JsonRpcProvider {
  return new ethers.providers.JsonRpcProvider(LIT_RPC_URL);
}

function getSigner(): ethers.Wallet {
  const provider = getProvider();
  // LIT_PRIVATE_KEY is checked at module load time, so it's safe here
  const privateKey = (LIT_PRIVATE_KEY as string).startsWith("0x") ? LIT_PRIVATE_KEY as string : `0x${LIT_PRIVATE_KEY}`;
  return new ethers.Wallet(privateKey, provider);
}

async function getLitNodeClient(): Promise<LitNodeClient> {
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
 */
export async function initializeLitServices(): Promise<void> {
  logger.info("Initializing Lit services", { network: LIT_NETWORK });
  try {
    // Initialize both clients in parallel for faster startup
    await Promise.all([
      getLitNodeClient(),
      getLitContractsClient(),
    ]);
    logger.info("Lit services initialized successfully", { network: LIT_NETWORK });
  } catch (error) {
    logger.error("Failed to initialize Lit services", error as Error, { network: LIT_NETWORK });
    throw error;
  }
}

function getOAuthAuthMethodInfo(userId: string) {
  return {
    authMethodType: ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("AUTH0_AUTH_METHOD_V04")
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

async function getCapacityCredit(): Promise<string> {
  const signer = getSigner();
  const litContracts = await getLitContractsClient();

  let capacityTokenId = process.env.LIT_CAPACITY_CREDIT_TOKEN_ID;

  if (!capacityTokenId) {
    logger.debug("Minting Capacity Credits NFT");
    const result = await litContracts.mintCapacityCreditsNFT({
      requestsPerKilosecond: 10,
      daysUntilUTCMidnightExpiration: 1,
    });
    capacityTokenId = result.capacityTokenIdStr;
    logger.debug("Minted Capacity Credit", { capacityTokenId });
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
 * Mint a new PKP wallet for a user
 */
export async function mintPKP(
  userId: string,
  oauthAccessToken: string
): Promise<PKP> {
  const signer = getSigner();
  const litContracts = await getLitContractsClient();
  const pkpMintCost = await getPkpMintCost(litContracts);
  const { authMethodType, authMethodId } = getOAuthAuthMethodInfo(userId);
  const litActionIpfsCid = await getLitActionCodeIpfsCid();

  logger.debug("Minting new PKP", { userId });

  // Ensure mint cost is a BigNumber
  const mintCostValue = ethers.BigNumber.from(pkpMintCost);
  
  // Convert authMethodType (keccak256 hex string) to BigNumber for uint256 array
  // The contract expects uint256[], so we need to convert the hex string to BigNumber
  const authMethodTypeBigNumber = ethers.BigNumber.from(authMethodType);
  
  // Ensure all uint256 values are BigNumbers for consistency
  const litActionTypeBigNumber = ethers.BigNumber.from(AUTH_METHOD_TYPE.LitAction);
  
  // Prepare parameters - ensure all uint256 values are BigNumbers
  const permittedAuthMethodTypes = [litActionTypeBigNumber, authMethodTypeBigNumber];
  const permittedAuthMethodIds = [
    `0x${Buffer.from(bs58.decode(litActionIpfsCid)).toString("hex")}`,
    authMethodId,
  ];
  const permittedAuthMethodPubkeys = ["0x", "0x"];
  // Ensure scope values are also BigNumbers
  const permittedAuthMethodScopes = [
    [ethers.BigNumber.from(AUTH_METHOD_SCOPE.SignAnything)],
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

  logger.debug("Minting PKP with parameters", {
    keyType: AUTH_METHOD_TYPE.LitAction,
    permittedAuthMethodTypes: permittedAuthMethodTypes.map(bn => bn.toString()),
    permittedAuthMethodIds,
    permittedAuthMethodScopes: permittedAuthMethodScopes.map(scopes => scopes.map(s => s.toString())),
    mintCost: mintCostValue.toString(),
    mintCostHex: mintCostValue.toHexString(),
    authMethodType: authMethodType,
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

  // Transaction simulation: Simulates the transaction before sending to catch revert reasons early
  // This is useful for debugging but adds overhead. Disabled by default.
  // Enable with LIT_ENABLE_TX_SIMULATION=true environment variable
  if (ENABLE_TX_SIMULATION) {
    try {
    await pkpHelperContract.callStatic.mintNextAndAddAuthMethods(
      litActionTypeBigNumber,
      permittedAuthMethodTypes,
      permittedAuthMethodIds,
      permittedAuthMethodPubkeys,
      permittedAuthMethodScopes,
      true, // addPkpEthAddressAsPermittedAddress
      true, // sendPkpToItself
      { value: mintCostValue }
    );
    logger.debug("Transaction simulation successful - should not revert");
  } catch (simulateError: any) {
    // Decode revert reason from simulation
    let revertReason = "Unknown revert reason";
    let errorDetails: any = {};
    
    // Try to extract revert reason from error message (for require() statements)
    if (simulateError.message) {
      // Look for revert reason in the error message
      const reasonMatch = simulateError.message.match(/reason="([^"]+)"/);
      if (reasonMatch) {
        revertReason = reasonMatch[1];
      } else {
        // Try to find error message in the full error string
        const fullError = simulateError.toString();
        const errorMsgMatch = fullError.match(/PKPHelper: ([^"]+)/);
        if (errorMsgMatch) {
          revertReason = `PKPHelper: ${errorMsgMatch[1]}`;
        } else {
          revertReason = simulateError.message;
        }
      }
    }
    
    // Try to decode error data if present
    if (simulateError.data && simulateError.data !== "0x") {
      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const abiPath = path.join(process.cwd(), '.tmp/lit-wallet-with-oauth/PkPhelper.abi');
        const abiJson = await fs.readFile(abiPath, 'utf-8');
        const abi = JSON.parse(abiJson);
        const iface = new ethers.utils.Interface(abi);
        
        // Try to decode the error
        const decoded = iface.parseError(simulateError.data);
        revertReason = `${decoded.name}: ${JSON.stringify(decoded.args)}`;
        errorDetails.decodedError = decoded;
      } catch (decodeError: any) {
        errorDetails.decodeError = decodeError.message;
      }
      errorDetails.errorData = simulateError.data;
    }
    
    // If error data is empty, the revert might be from a nested call
    // Check if it's a common issue like insufficient value
    if (!simulateError.data || simulateError.data === "0x") {
      // Try to call the underlying PKPNFT contract to see if mintNext would work
      // Use the actual contract address and full ABI
      const PKPNFT_ADDRESS = "0x487A9D096BB4B7Ac1520Cb12370e31e677B175EA";
      
      // Load the full ABI from file
      let PKPNFT_ABI: any[];
      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const abiPath = path.join(process.cwd(), '.tmp/lit-wallet-with-oauth/PkpNft.abi');
        const abiJson = await fs.readFile(abiPath, 'utf-8');
        PKPNFT_ABI = JSON.parse(abiJson);
      } catch (abiError: any) {
        // Fallback to minimal ABI if file read fails
        PKPNFT_ABI = [
          {
            "inputs": [],
            "name": "CallerNotOwner",
            "type": "error"
          },
          {
            "inputs": [],
            "name": "mintCost",
            "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
            "stateMutability": "view",
            "type": "function"
          },
          {
            "inputs": [{"internalType": "uint256", "name": "keyType", "type": "uint256"}],
            "name": "mintNext",
            "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
            "stateMutability": "payable",
            "type": "function"
          }
        ];
        errorDetails.abiLoadError = abiError.message;
      }
      
      try {
        const pkpNftContract = new ethers.Contract(
          PKPNFT_ADDRESS,
          PKPNFT_ABI,
          getProvider()
        );
        
        // Check the actual mint cost from PKPNFT contract directly
        const actualMintCost = await pkpNftContract.mintCost();
        errorDetails.actualMintCost = actualMintCost.toString();
        errorDetails.expectedMintCost = mintCostValue.toString();
        errorDetails.mintCostMatch = actualMintCost.eq(mintCostValue);
        
        // The contract requires EXACT equality (== not >=) - line 186 of PkpNft.sol
        // require(msg.value == s().mintCost, "You must pay exactly mint cost");
        if (!actualMintCost.eq(mintCostValue)) {
          revertReason = `Mint cost mismatch: PKPNFT expects exactly ${actualMintCost.toString()} wei, but we're sending ${mintCostValue.toString()} wei. The contract requires EXACT equality (==, not >=).`;
        } else {
          // Also check what PKPHelper thinks the mint cost is
          const helperMintCost = await litContracts.pkpNftContract.read.mintCost();
          errorDetails.helperMintCost = helperMintCost.toString();
          errorDetails.helperVsDirectMatch = helperMintCost.eq(actualMintCost);
          
          if (!helperMintCost.eq(actualMintCost)) {
            revertReason = `Mint cost mismatch between PKPHelper view (${helperMintCost.toString()}) and PKPNFT direct (${actualMintCost.toString()})`;
          } else {
            // Try the actual mintNext call to see what the real error is
            // Potential revert reasons from PkpNft.sol:
            // 1. Line 186: "You must pay exactly mint cost" (msg.value != mintCost) - CHECKED ✓
            // 2. Line 188: getNextDerivedKeyId() uses blockhash(block.number - 1) - might fail in same block
            // 3. Line 189-192: router.getDerivedPubkey() might fail
            // 4. Line 194: routeDerivedKey() -> router.setRoutingData() might fail
            // 5. Line 268: "This PKP has not been routed yet" (router.isRouted(tokenId) == false)
            // 6. _safeMint might revert if token exists or recipient issues
            
            // Check router and staking addresses first
            try {
              const routerAddress = await pkpNftContract.getRouterAddress();
              const stakingAddress = await pkpNftContract.getStakingAddress();
              errorDetails.routerAddress = routerAddress;
              errorDetails.stakingAddress = stakingAddress;
              
              // Check if router contract exists and is callable
              const routerCode = await getProvider().getCode(routerAddress);
              const stakingCode = await getProvider().getCode(stakingAddress);
              errorDetails.routerHasCode = routerCode !== "0x";
              errorDetails.stakingHasCode = stakingCode !== "0x";
              
              if (routerCode === "0x") {
                revertReason = `PKPNFT router contract at ${routerAddress} has no code (not deployed or wrong address)`;
              } else if (stakingCode === "0x") {
                revertReason = `PKPNFT staking contract at ${stakingAddress} has no code (not deployed or wrong address)`;
              }
            } catch (addrError: any) {
              errorDetails.addressCheckError = addrError.message;
            }
            
            // Only try mintNext if addresses are valid
            if (!revertReason || revertReason === "Unknown revert reason") {
              try {
                await pkpNftContract.callStatic.mintNext(litActionTypeBigNumber, { value: mintCostValue });
              } catch (mintError: any) {
                // Try to decode the error from PKPNFT using the full ABI
                if (mintError.data && mintError.data !== "0x") {
                  try {
                    const iface = new ethers.utils.Interface(PKPNFT_ABI);
                    const decoded = iface.parseError(mintError.data);
                    revertReason = `PKPNFT.mintNext error: ${decoded.name} - ${JSON.stringify(decoded.args)}`;
                    errorDetails.decodedError = decoded;
                  } catch (decodeError: any) {
                    // Try to decode as Error(string) - common messages:
                    // - "You must pay exactly mint cost" (line 186)
                    // - "This PKP has not been routed yet" (line 268)
                    if (mintError.data.startsWith("0x08c379a0")) {
                      try {
                        const decoded = ethers.utils.defaultAbiCoder.decode(['string'], '0x' + mintError.data.slice(10));
                        revertReason = `PKPNFT.mintNext error: ${decoded[0]}`;
                        errorDetails.errorString = decoded[0];
                      } catch {}
                    }
                    errorDetails.decodeError = decodeError.message;
                  }
                }
                if (!revertReason || revertReason === "Unknown revert reason") {
                  revertReason = `PKPNFT.mintNext failed: ${mintError.message || mintError.reason || 'unknown error'}`;
                }
                errorDetails.mintError = mintError.message || mintError.toString();
                errorDetails.mintErrorData = mintError.data;
                
                // Check for specific known error messages from the contract
                const errorMsg = mintError.message || mintError.toString();
                if (errorMsg.includes("You must pay exactly mint cost")) {
                  revertReason = `PKPNFT.mintNext: You must pay exactly mint cost. Expected: ${actualMintCost.toString()} wei, Sent: ${mintCostValue.toString()} wei`;
                } else if (errorMsg.includes("This PKP has not been routed yet")) {
                  revertReason = `PKPNFT.mintNext: This PKP has not been routed yet. This suggests routeDerivedKey() or router.setRoutingData() failed.`;
                } else if (errorMsg.includes("ERC721: token already minted")) {
                  revertReason = `PKPNFT.mintNext: Token already exists (collision in tokenId calculation)`;
                }
              }
            }
          }
        }
      } catch (nftError: any) {
        if (!revertReason || revertReason === "Unknown revert reason") {
          revertReason = `PKPNFT contract call failed: ${nftError.message || nftError.reason || 'unknown error'}`;
        }
        errorDetails.nftError = nftError.message || nftError.toString();
        errorDetails.nftErrorData = nftError.data;
      }
    }
    
      logger.error("Transaction simulation failed - will revert", new Error(revertReason), {
        ...errorDetails,
        errorCode: simulateError.code,
        errorData: simulateError.data,
        fullError: simulateError.toString(),
      });
      throw new Error(`Transaction will revert: ${revertReason}`);
    }
  }

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

  logger.debug("Creating capacity delegation auth sig", { pkpAddress: pkp.ethAddress });

  const { capacityDelegationAuthSig } =
    await litNodeClient.createCapacityDelegationAuthSig({
      dAppOwnerWallet: signer as any,
      capacityTokenId,
      delegateeAddresses: [pkp.ethAddress],
      uses: "1",
    });


  logger.debug("Getting Lit Action session signatures", { pkpPublicKey: pkp.publicKey });

  // Use getLitActionSessionSigs when authentication is via Lit Action
  // See: https://developer.litprotocol.com/sdk/authentication/session-sigs/get-lit-action-session-sigs
  // Note: capacity delegation is not needed since the PKP is registered as a payee via addPayee
  const litClient = litNodeClient as any;
  
  if (!litClient.getLitActionSessionSigs) {
    throw new Error("getLitActionSessionSigs method not found in LitNodeClient. Please ensure you're using a compatible SDK version.");
  }

  const sessionSignatures = await litClient.getLitActionSessionSigs({
    pkpPublicKey: pkp.publicKey,
    capabilityAuthSigs: [capacityDelegationAuthSig],
    //capabilityAuthSigs: [], // Empty since PKP is registered as payee
    litActionCode: Buffer.from(litActionCode).toString("base64"),
    debug: process.env.LIT_DEBUG === "true",
    jsParams: {
      oauthUserData: JSON.stringify({
        accessToken: oauthAccessToken,
      }),
      pkpTokenId: pkp.tokenId,
    },
    resourceAbilityRequests: [
      {
        resource: new LitPKPResource("*"),
        ability: LIT_ABILITY.PKPSigning,
      },
    ],
    expiration: new Date(Date.now() + 1000 * 60 * 10).toISOString(), // 10 minutes
  });

  logger.debug("Got PKP session signatures");
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

