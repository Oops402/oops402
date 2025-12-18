/**
 * x402 Payment Service
 * Handles payments to x402-protected resources using PKP wallets
 */

import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactEvmSchemeV1, NETWORKS as V1_NETWORKS } from "@x402/evm/v1";
import { wrapFetchWithPayment } from "@x402/fetch";
import { getAddress, recoverAddress, hashTypedData, type Address } from "viem";
import { PKPAccount } from "../wallet/pkpSigner.js";
import { logger } from "../shared/logger.js";

const X402_FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";

/**
 * Adapter to convert PKPAccount to the signer format expected by x402 ExactEvmScheme
 * x402 expects: { address, signTypedData }
 */
function createX402Signer(pkpAccount: PKPAccount) {
  // Ensure address is checksummed for x402 compatibility
  const checksummedAddress = getAddress(pkpAccount.address);
  
  logger.debug("Creating x402 signer", {
    originalAddress: pkpAccount.address,
    checksummedAddress,
  });
  
  return {
    address: checksummedAddress,
    signTypedData: async (message: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`> => {
      logger.debug("Signing typed data with PKP", {
        address: checksummedAddress,
        primaryType: message.primaryType,
      });
      
      // Convert the simpler x402 format to viem's TypedDataDefinition format
      const signature = await pkpAccount.signTypedData({
        domain: message.domain as any,
        types: message.types as any,
        primaryType: message.primaryType,
        message: message.message as any,
      });
      
      // Verify the signature can be recovered to the correct address
      try {
        const hash = hashTypedData({
          domain: message.domain as any,
          types: message.types as any,
          primaryType: message.primaryType,
          message: message.message as any,
        });
        
        // recoverAddress may be async in some viem versions
        const recoveredAddressResult = recoverAddress({
          hash: hash as `0x${string}`,
          signature: signature as `0x${string}`,
        });
        
        // Handle both sync and async cases
        const recoveredAddress: Address = recoveredAddressResult instanceof Promise 
          ? await recoveredAddressResult 
          : recoveredAddressResult;
        
        const expectedLower = checksummedAddress.toLowerCase();
        const recoveredLower = recoveredAddress.toLowerCase();
        
        logger.debug("Signature verification", {
          expectedAddress: checksummedAddress,
          recoveredAddress,
          match: recoveredLower === expectedLower,
        });
        
        if (recoveredLower !== expectedLower) {
          logger.warning("Signature recovery mismatch", {
            expected: checksummedAddress,
            recovered: recoveredAddress,
            hash,
            signature,
          });
        }
      } catch (verifyError) {
        logger.warning("Failed to verify signature", {
          error: verifyError instanceof Error ? verifyError.message : String(verifyError),
        });
      }
      
      logger.debug("Signed typed data with PKP", {
        address: checksummedAddress,
        signatureLength: signature.length,
      });
      
      return signature;
    },
  };
}

/**
 * Create a fetch function wrapped with x402 payment handling using PKP signer
 */
export async function createBuyerFetch(
  pkpAccount: PKPAccount,
  maxAmountPerRequest?: bigint
): Promise<typeof fetch> {
  logger.debug("Creating x402 buyer fetch", { 
    address: pkpAccount.address,
    maxAmount: maxAmountPerRequest?.toString() 
  });

  const x402Signer = createX402Signer(pkpAccount);
  
  // Create client with V2 support (default)
  const client = new x402Client()
    .register("eip155:*", new ExactEvmScheme(x402Signer));
  
  // Register V1 support for all V1 networks
  const v1Scheme = new ExactEvmSchemeV1(x402Signer);
  for (const network of V1_NETWORKS) {
    client.registerV1(network, v1Scheme);
  }
  
  // Add hooks
  client
    .onBeforePaymentCreation(async (context) => {
      logger.debug("Before payment creation", {
        network: context.selectedRequirements.network,
        scheme: context.selectedRequirements.scheme,
        signerAddress: x402Signer.address,
      });
    })
    .onAfterPaymentCreation(async (context) => {
      logger.debug("After payment creation", {
        version: context.paymentPayload.x402Version,
        payload: JSON.stringify(context.paymentPayload, (key, value) => {
          // Handle BigInt serialization
          if (typeof value === 'bigint') {
            return value.toString();
          }
          return value;
        }),
      });
    })
    .onPaymentCreationFailure(async (context) => {
      logger.warning("Payment creation failed", {
        error: context.error?.message,
        stack: context.error?.stack,
      });
    });

  if (maxAmountPerRequest) {
    // Set max amount per request if provided
    // Note: This may need to be set via client configuration if the SDK supports it
  }

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  return fetchWithPayment;
}

/**
 * Make a payment to an x402-protected resource
 */
export async function makePayment(
  pkpAccount: PKPAccount,
  resourceUrl: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    maxAmountPerRequest?: bigint;
  } = {}
): Promise<{
  response: Response;
  paymentResponse?: any;
}> {
  const fetchWithPayment = await createBuyerFetch(
    pkpAccount,
    options.maxAmountPerRequest
  );

  logger.debug("Making payment request", {
    url: resourceUrl,
    method: options.method || "GET",
  });

  const response = await fetchWithPayment(resourceUrl, {
    method: (options.method || "GET") as RequestInit["method"],
    headers: options.headers,
    body: options.body,
  });

  // Extract payment response from headers if present
  const paymentResponseHeader = response.headers.get("X-PAYMENT-RESPONSE");
  let paymentResponse = null;
  
  if (paymentResponseHeader) {
    try {
      const { x402HTTPClient } = await import("@x402/fetch");
      const x402Signer = createX402Signer(pkpAccount);
      const client = new x402Client()
        .register("eip155:*", new ExactEvmScheme(x402Signer));
      
      // Register V1 support
      const v1Scheme = new ExactEvmSchemeV1(x402Signer);
      for (const network of V1_NETWORKS) {
        client.registerV1(network, v1Scheme);
      }
      
      const httpClient = new x402HTTPClient(client);
      paymentResponse = httpClient.getPaymentSettleResponse((name) =>
        response.headers.get(name)
      );
    } catch (error) {
      logger.warning("Failed to decode payment response", { error });
    }
  }

  logger.debug("Payment request completed", {
    status: response.status,
    hasPaymentResponse: !!paymentResponse,
  });

  return {
    response,
    paymentResponse,
  };
}

