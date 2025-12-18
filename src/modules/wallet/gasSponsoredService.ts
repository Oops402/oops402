/**
 * Gas Sponsored Transaction Service
 * 
 * Implements gas sponsorship using Alchemy Account Kit with EIP-7702
 * Based on Alchemy's official documentation and examples
 */

import type { Address, Hex } from "viem";
import { PKPSmartSigner } from "./pkpSmartSigner.js";
import { logger } from "../shared/logger.js";

/**
 * Configuration for gas-sponsored transactions
 */
export interface GasSponsoredConfig {
  pkpPublicKey: string;
  pkpAddress: Address;
  sessionSigs: any; // PKPSessionSigs
  chainId: number;
  alchemyApiKey: string;
  alchemyPolicyId: string;
}

/**
 * Send a gas-sponsored transaction using EIP-7702
 * 
 * This follows Alchemy's official pattern:
 * 1. Create smart account client with EIP-7702 mode
 * 2. Build user operation
 * 3. Sign user operation
 * 4. Send raw user operation
 * 
 * @param config - Configuration including PKP details and Alchemy credentials
 * @param to - Recipient address
 * @param value - Value to send (in wei)
 * @param data - Transaction calldata
 * @returns UserOperation hash
 */
export async function sendGasSponsoredTransaction(
  config: GasSponsoredConfig,
  to: Address,
  value: bigint,
  data: Hex
): Promise<Hex> {
  // Dynamic import to avoid errors if packages aren't installed
  let createModularAccountV2Client: any;
  let alchemy: any;
  let chain: any;
  
  try {
    const accountKit = await import('@account-kit/smart-contracts');
    const infra = await import('@account-kit/infra');
    createModularAccountV2Client = accountKit.createModularAccountV2Client;
    alchemy = infra.alchemy;
    
    // Get chain from @account-kit/infra
    const { base, mainnet, sepolia } = infra;
    switch (config.chainId) {
      case 8453: // Base
        chain = base;
        break;
      case 1: // Ethereum Mainnet
        chain = mainnet;
        break;
      case 11155111: // Sepolia
        chain = sepolia;
        break;
      default:
        throw new Error(`Chain ID ${config.chainId} not supported. Supported: 8453 (Base), 1 (Mainnet), 11155111 (Sepolia)`);
    }
  } catch (error) {
    throw new Error(
      'Gas sponsorship requires @account-kit packages. Install with: npm install @account-kit/infra @account-kit/smart-contracts. ' +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  logger.debug("Creating PKP Smart Signer", {
    pkpAddress: config.pkpAddress,
    chainId: config.chainId,
  });

  // Create PKP Smart Signer (implements SmartAccountSigner interface)
  const pkpSigner = new PKPSmartSigner({
    pkpPublicKey: config.pkpPublicKey,
    pkpAddress: config.pkpAddress,
    sessionSigs: config.sessionSigs,
    chainId: config.chainId,
  });

  // Create Smart Account Client with EIP-7702 mode and gas sponsorship
  // This matches Alchemy's official pattern exactly
  const smartAccountClient = await createModularAccountV2Client({
    mode: '7702' as const,
    transport: alchemy({ apiKey: config.alchemyApiKey }),
    chain: chain,
    signer: pkpSigner,
    policyId: config.alchemyPolicyId, // Gas sponsorship policy ID
  });

  logger.debug("Smart account client created", {
    accountAddress: smartAccountClient.account.address,
  });

  // Prepare the user operation
  const userOperation = {
    target: to,
    value: value,
    data: data,
  };

  logger.debug("Building user operation", { userOperation });

  // Build the user operation (this includes gas estimates and paymaster data)
  const uoStruct = await smartAccountClient.buildUserOperation({
    uo: userOperation,
    account: smartAccountClient.account,
  });

  logger.debug("User operation built", { 
    uoStruct: {
      sender: uoStruct.sender,
      nonce: uoStruct.nonce?.toString(),
      callData: uoStruct.callData,
      hasPaymaster: !!uoStruct.paymaster,
    }
  });

  // Sign the user operation
  // This calls signMessage on our PKPSmartSigner with the user operation hash
  const signedUserOperation = await smartAccountClient.signUserOperation({
    account: smartAccountClient.account,
    uoStruct,
  });

  logger.debug("User operation signed", { 
    signedUserOperation: {
      sender: (signedUserOperation as any).sender,
      nonce: (signedUserOperation as any).nonce?.toString(),
      signature: typeof (signedUserOperation as any).signature === 'string' 
        ? (signedUserOperation as any).signature.slice(0, 20) + '...' 
        : 'object',
      hasEip7702Auth: !!(signedUserOperation as any).eip7702Auth,
    },
  });

  // Get entry point address
  const entryPoint = smartAccountClient.account.getEntryPoint();

  // Send the raw user operation
  // This is the final step - sends to Alchemy's bundler
  const uoHash = await smartAccountClient.sendRawUserOperation(
    signedUserOperation,
    entryPoint.address
  );

  logger.debug("User operation sent", { 
    userOpHash: uoHash,
    hashType: typeof uoHash,
    hashValue: String(uoHash),
  });

  // Ensure we return a proper hex string
  // sendRawUserOperation should return a Hex string, but let's normalize it
  let hash: string;
  if (typeof uoHash === 'string') {
    hash = uoHash;
  } else if (uoHash && typeof uoHash === 'object' && 'toString' in uoHash) {
    hash = uoHash.toString();
  } else {
    hash = String(uoHash);
  }
  
  // Ensure it starts with 0x
  if (!hash.startsWith('0x')) {
    hash = `0x${hash}`;
  }
  
  // Normalize to lowercase for consistency
  hash = hash.toLowerCase();
  
  logger.debug("Normalized hash", { 
    original: uoHash,
    normalized: hash,
    length: hash.length,
  });
  
  return hash as Hex;
}

/**
 * Wait for a user operation to be mined and return the transaction hash
 */
export async function waitForUserOperationTransaction(
  uoHash: Hex,
  config: GasSponsoredConfig
): Promise<{ hash: Hex }> {
  // Validate hash
  if (!uoHash || typeof uoHash !== 'string' || !uoHash.startsWith('0x')) {
    throw new Error(`Invalid user operation hash: ${uoHash} (type: ${typeof uoHash})`);
  }

  logger.debug("Waiting for user operation transaction", { 
    uoHash,
    hashLength: uoHash.length,
  });

  let createModularAccountV2Client: any;
  let alchemy: any;
  let chain: any;
  
  try {
    const accountKit = await import('@account-kit/smart-contracts');
    const infra = await import('@account-kit/infra');
    createModularAccountV2Client = accountKit.createModularAccountV2Client;
    alchemy = infra.alchemy;
    
    // Get chain from @account-kit/infra
    const { base, mainnet, sepolia } = infra;
    switch (config.chainId) {
      case 8453:
        chain = base;
        break;
      case 1:
        chain = mainnet;
        break;
      case 11155111:
        chain = sepolia;
        break;
      default:
        throw new Error(`Chain ID ${config.chainId} not supported`);
    }
  } catch (error) {
    throw new Error(
      'Gas sponsorship requires @account-kit packages. Install with: npm install @account-kit/infra @account-kit/smart-contracts'
    );
  }

  const pkpSigner = new PKPSmartSigner({
    pkpPublicKey: config.pkpPublicKey,
    pkpAddress: config.pkpAddress,
    sessionSigs: config.sessionSigs,
    chainId: config.chainId,
  });

  const smartAccountClient = await createModularAccountV2Client({
    mode: '7702' as const,
    transport: alchemy({ apiKey: config.alchemyApiKey }),
    chain: chain,
    signer: pkpSigner,
    policyId: config.alchemyPolicyId,
  });

  // Ensure hash is a string and properly formatted
  // The hash must be exactly as returned from sendRawUserOperation
  let hashString: string;
  if (typeof uoHash === 'string') {
    hashString = uoHash;
  } else if (uoHash != null && typeof uoHash === 'object' && 'toString' in uoHash) {
    hashString = (uoHash as any).toString();
  } else {
    hashString = String(uoHash);
  }
  
  // Ensure it's a valid hex string
  if (!hashString || !hashString.startsWith('0x')) {
    throw new Error(`Invalid user operation hash: ${hashString} (type: ${typeof uoHash})`);
  }

  logger.debug("Calling waitForUserOperationTransaction", { 
    originalHash: uoHash,
    hashString,
    hashType: typeof uoHash,
    stringType: typeof hashString,
    hashLength: hashString.length,
    isValidHex: /^0x[0-9a-fA-F]+$/.test(hashString),
    firstChars: hashString.slice(0, 10),
    lastChars: hashString.slice(-10),
  });

  // waitForUserOperationTransaction expects an object with a 'hash' property, not just the hash string
  // Based on the SDK type definition: waitForUserOperationTransaction({ hash: "0x...", retries?: {...} })
  logger.debug("About to call waitForUserOperationTransaction", {
    hashString,
    hashStringType: typeof hashString,
    hashStringLength: hashString.length,
  });
  
  const result = await smartAccountClient.waitForUserOperationTransaction({
    hash: hashString as Hex,
  });

  logger.debug("User operation transaction received", { 
    result,
    resultType: typeof result,
  });

  // The SDK returns the transaction hash directly as a Hex string
  // Based on the type definition: Promise<Hex>
  if (typeof result === 'string') {
    return { hash: result as Hex };
  } else {
    // Fallback: if it's somehow an object, try to extract hash
    logger.warning("Unexpected result format from waitForUserOperationTransaction", { result });
    if (result && typeof result === 'object' && 'hash' in result) {
      return { hash: (result as any).hash as Hex };
    }
    // Last resort: convert to string
    return { hash: String(result) as Hex };
  }
}
