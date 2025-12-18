/**
 * PKP Smart Signer for EIP-7702 delegated transactions
 * 
 * This signer implements the Alchemy SmartAccountSigner interface to support
 * EIP-7702 delegation with the Lit Protocol PKP. It enables gasless transactions
 * through integration with Alchemy's gas sponsorship.
 * 
 * Unlike the Lit Actions version, this uses litNodeClient.pkpSign directly
 * outside of Lit Actions.
 */

import { ethers } from "ethers";
import type { Address, Hex } from "viem";
import { pkpSignTransaction, type PKPSessionSigs } from "./litService.js";
import { logger } from "../shared/logger.js";

export interface PKPSmartSignerConfig {
  pkpPublicKey: string;
  pkpAddress: Address;
  sessionSigs: PKPSessionSigs;
  chainId: number;
}

// SignableMessage from viem - can be string or object with raw property
type SignableMessage =
  | string
  | {
      raw: Hex | Uint8Array;
    };

// TypedDataDefinition compatible with viem
type TypedDataDefinition = {
  domain?: any;
  types?: any;
  primaryType?: string;
  message?: any;
};

// EIP-7702 types
type AuthorizationRequest = {
  address?: Address;
  contractAddress?: Address;
  chainId: number;
  nonce: number;
};

type SignedAuthorization = {
  address: Address;
  chainId: number;
  nonce: number;
  r: Hex;
  s: Hex;
  v?: bigint;
  yParity: number;
};

// SmartAccountSigner interface compatible with @account-kit/smart-contracts
export interface SmartAccountSigner<Inner = any> {
  signerType: string;
  inner: Inner;
  getAddress: () => Promise<Address>;
  signMessage: (message: SignableMessage) => Promise<Hex>;
  signTypedData: (params: TypedDataDefinition) => Promise<Hex>;
  signAuthorization?: (unsignedAuthorization: AuthorizationRequest) => Promise<SignedAuthorization>;
}

/**
 * Parse signature from Lit PKP into r, s, v components
 * The signature from pkpSignTransaction is already in the correct format: 0x{r}{s}{v}
 * where v is the recovery ID (0, 1, 27, or 28)
 */
function parseSignature(signature: string): { r: Hex; s: Hex; v: number; yParity: number } {
  // Signature is 65 bytes: r (32) + s (32) + v/recoveryId (1)
  // Extract r, s, v exactly as Lit Actions example does
  const rHex = signature.slice(2, 66); // 64 hex chars (32 bytes)
  const sHex = signature.slice(66, 130); // 64 hex chars (32 bytes)
  const vHex = signature.slice(130, 132); // 2 hex chars (1 byte)
  const v = parseInt(vHex, 16);
  
  // Extract recoveryId: if v is 27 or 28, recoveryId = v - 27, otherwise it's the recoveryId directly
  let recoveryId: number;
  if (v === 27 || v === 28) {
    recoveryId = v - 27;
  } else {
    recoveryId = v;
  }
  
  // Format r and s exactly as Lit Actions example: '0x' + hex.substring(2) or '0x' + hex
  // Since we extracted hex without 0x, just add it
  return {
    r: `0x${rHex}` as Hex,
    s: `0x${sHex}` as Hex,
    v: v, // v is 27, 28, or recoveryId (0/1)
    yParity: recoveryId,
  };
}

/**
 * Join signature components into a single hex string
 * Manually construct to match Alchemy SDK expectations exactly
 * The signature format should be: 0x{r}{s}{v} where:
 * - r and s are 32 bytes each (64 hex chars)
 * - v is 1 byte (2 hex chars): 27, 28, or recoveryId (0/1)
 */
function joinSignature({ r, s, v }: { r: Hex; s: Hex; v: number }): Hex {
  // Ensure r and s are exactly 64 hex characters (32 bytes)
  const rHex = r.startsWith('0x') ? r.slice(2).padStart(64, '0') : r.padStart(64, '0');
  const sHex = s.startsWith('0x') ? s.slice(2).padStart(64, '0') : s.padStart(64, '0');
  
  // v should be 27, 28, or recoveryId (0/1)
  // Convert to hex string (2 chars)
  const vHex = v.toString(16).padStart(2, '0');
  
  // Manually construct: 0x + r (64) + s (64) + v (2) = 132 chars total
  return `0x${rHex}${sHex}${vHex}` as Hex;
}

export class PKPSmartSigner implements SmartAccountSigner {
  readonly signerType = 'pkp-smart-signer';
  readonly inner: PKPSmartSignerConfig;
  private pkpPublicKey: string;
  private pkpAddress: Address;

  constructor(config: PKPSmartSignerConfig) {
    // Ensure public key doesn't have 0x prefix for consistency
    this.pkpPublicKey = config.pkpPublicKey.startsWith('0x') 
      ? config.pkpPublicKey.slice(2) 
      : config.pkpPublicKey;
    this.pkpAddress = config.pkpAddress;
    this.inner = config;
  }

  /**
   * Update session signatures (they expire after 10 minutes)
   */
  updateSessionSigs(sessionSigs: PKPSessionSigs): void {
    this.inner.sessionSigs = sessionSigs;
  }

  async getAddress(): Promise<Address> {
    return this.pkpAddress;
  }

  async signMessage(message: SignableMessage): Promise<Hex> {
    logger.debug("PKPSmartSigner: Signing message", { address: this.pkpAddress });
    
    // Handle message format exactly as Lit Actions example
    let messageToSign: string | Uint8Array;
    
    if (typeof message === 'string') {
      messageToSign = message;
    } else {
      // Handle raw message - convert to Uint8Array if it's a hex string
      messageToSign = typeof message.raw === 'string' 
        ? ethers.utils.arrayify(message.raw) 
        : message.raw;
    }

    // Always use ethers.utils.hashMessage - it handles both string and Uint8Array
    // For user operations, Alchemy may pass the hash, but hashMessage will handle it correctly
    const messageHash = ethers.utils.hashMessage(messageToSign);
    
    logger.debug("Message hash", { 
      messageHash,
      messageType: typeof messageToSign,
      isString: typeof messageToSign === 'string',
    });
    
    // Sign the hash using PKP - convert hash to bytes for signing
    const hashBytes = ethers.utils.arrayify(messageHash);
    const signature = await pkpSignTransaction(this.inner.sessionSigs, `0x${this.pkpPublicKey}`, messageHash);
    
    logger.debug("Signature from PKP", { signature, length: signature.length });
    
    // Parse signature exactly as Lit Actions example does
    const parsed = parseSignature(signature);
    
    // Format using ethers.utils.joinSignature exactly as example
    // Note: parsedSig.r might have 0x prefix, so we handle it like the example
    const r = parsed.r.startsWith('0x') ? parsed.r : `0x${parsed.r}`;
    const s = parsed.s.startsWith('0x') ? parsed.s : `0x${parsed.s}`;
    
    const formatted = ethers.utils.joinSignature({
      r: r.startsWith('0x') ? r : `0x${r}`,
      s: s.startsWith('0x') ? s : `0x${s}`,
      v: parsed.v,
    }) as Hex;
    
    logger.debug("Formatted signature", { 
      original: signature,
      formatted,
      parsedV: parsed.v,
    });
    
    return formatted;
  }

  async signTypedData(params: TypedDataDefinition): Promise<Hex> {
    logger.debug("PKPSmartSigner: Signing typed data", { address: this.pkpAddress });
    
    // Create the EIP-712 hash using ethers to match Alchemy's expectations
    const hash = ethers.utils._TypedDataEncoder.hash(
      params.domain || {},
      params.types || {},
      params.message || {},
    );
    
    // Sign the hash using PKP
    const signature = await pkpSignTransaction(this.inner.sessionSigs, `0x${this.pkpPublicKey}`, hash);
    
    logger.debug("Typed data signature from PKP", { signature, length: signature.length });
    
    // Parse and format using ethers.utils.joinSignature to match Lit Actions example exactly
    const parsed = parseSignature(signature);
    const formatted = ethers.utils.joinSignature({
      r: parsed.r,
      s: parsed.s,
      v: parsed.v,
    }) as Hex;
    
    logger.debug("Formatted typed data signature", { 
      original: signature,
      formatted,
      parsedV: parsed.v,
    });
    
    return formatted;
  }

  /**
   * Sign EIP-7702 authorization
   * Reference implementation from Viem SmartAccountSigner
   */
  async signAuthorization(
    unsignedAuthorization: AuthorizationRequest,
  ): Promise<SignedAuthorization> {
    logger.debug("PKPSmartSigner: Signing authorization", { 
      address: this.pkpAddress,
      authorization: unsignedAuthorization,
    });
    
    const { contractAddress, chainId, nonce } = unsignedAuthorization;

    if (!contractAddress || !chainId) {
      throw new Error('Invalid authorization: contractAddress and chainId are required');
    }

    // EIP-7702 authorization hash: keccak256(0x05 || RLP([chainId, contractAddress, nonce]))
    const rlpEncoded = ethers.utils.RLP.encode([
      ethers.utils.hexlify(chainId),
      contractAddress,
      nonce ? ethers.utils.hexlify(nonce) : '0x',
    ]);
    
    const hash = ethers.utils.keccak256(
      ethers.utils.hexConcat(['0x05', rlpEncoded])
    );

    // Sign the hash using PKP
    const signature = await pkpSignTransaction(
      this.inner.sessionSigs,
      `0x${this.pkpPublicKey}`,
      hash
    );
    
    // Parse signature
    const parsed = parseSignature(signature);

    return {
      address: (unsignedAuthorization.address || contractAddress) as Address,
      chainId: chainId,
      nonce: nonce,
      r: parsed.r,
      s: parsed.s,
      v: BigInt(parsed.v),
      yParity: parsed.yParity,
    };
  }
}

