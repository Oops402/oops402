/**
 * Custom viem Account implementation using Lit PKP signing
 */

import type { Account, SignMessageReturnType, SignTypedDataReturnType } from "viem";
import { hashMessage, hashTypedData, serializeTransaction, keccak256, type Hash, type Hex, type SignableMessage, type TypedDataDefinition } from "viem";
import { pkpSign, pkpSignTransaction, type PKPSessionSigs } from "./litService.js";
import { logger } from "../shared/logger.js";

export interface PKPAccountOptions {
  address: `0x${string}`;
  publicKey: `0x${string}`;
  sessionSigs: PKPSessionSigs;
}

/**
 * Custom viem Account that uses Lit PKP for signing
 */
export class PKPAccount {
  readonly type = "local";
  readonly address: `0x${string}`;
  readonly publicKey: `0x${string}`;
  private sessionSigs: PKPSessionSigs;

  constructor(options: PKPAccountOptions) {
    this.address = options.address;
    this.publicKey = options.publicKey;
    this.sessionSigs = options.sessionSigs;
  }

  /**
   * Update session signatures (they expire after 10 minutes)
   */
  updateSessionSigs(sessionSigs: PKPSessionSigs): void {
    this.sessionSigs = sessionSigs;
  }

  async signMessage({ message }: { message: SignableMessage }): Promise<SignMessageReturnType> {
    logger.debug("Signing message with PKP", { address: this.address });
    
    const messageHash = hashMessage(message);
    const signature = await pkpSign(this.sessionSigs, this.publicKey, messageHash);
    
    return signature as `0x${string}`;
  }

  async signTypedData<const TTypedData extends TypedDataDefinition | { name: string; type: string; value: unknown }[], TPrimaryType extends string = string>({
    domain,
    types,
    primaryType,
    message,
  }: {
    domain: TypedDataDefinition["domain"];
    types: TTypedData;
    primaryType: TPrimaryType;
    message: TypedDataDefinition["message"];
  }): Promise<SignTypedDataReturnType> {
    logger.debug("Signing typed data with PKP", { address: this.address });
    
    const hash = hashTypedData({ domain, types: types as any, primaryType, message } as any);
    const signature = await pkpSign(this.sessionSigs, this.publicKey, hash);
    
    return signature as `0x${string}`;
  }

  async signTransaction(transaction: Parameters<NonNullable<Account["signTransaction"]>>[0]): Promise<Hash> {
    // Log transaction details without BigInt values to avoid serialization issues
    const transactionForLog = {
      to: transaction.to,
      data: transaction.data,
      nonce: transaction.nonce,
      gasPrice: transaction.gasPrice?.toString(),
      gas: transaction.gas?.toString(),
      value: transaction.value?.toString(),
      chainId: transaction.chainId,
      type: transaction.type,
    };
    logger.debug("Signing transaction with PKP", { address: this.address, transaction: transactionForLog });
    
    // Serialize the transaction (RLP-encoded hex string)
    const serialized = serializeTransaction(transaction);
    
    logger.debug("Serialized transaction for signing", {
      serialized,
      serializedLength: serialized.length,
    });
    
    // Hash the serialized transaction to get the transaction hash
    // This is what needs to be signed for EIP-155 transactions
    const transactionHash = keccak256(serialized as Hex);
    
    logger.debug("Transaction hash to sign", {
      transactionHash,
    });
    
    // Sign the transaction hash using the transaction-specific signing function
    // which properly handles hex strings (doesn't convert to UTF-8)
    const signature = await pkpSignTransaction(this.sessionSigs, this.publicKey, transactionHash);
    
    logger.debug("Transaction signature received", {
      signature,
      signatureLength: signature.length,
    });
    
    return signature as Hash;
  }
}

