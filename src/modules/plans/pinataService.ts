/**
 * Pinata x402 Integration Service
 * Handles uploading files to IPFS via Pinata x402 and retrieving private files
 */

import { logger } from '../shared/logger.js';
import type { PKPAccount } from '../wallet/pkpSigner.js';
import { createBuyerFetch } from '../x402/service.js';

const PINATA_X402_BASE_URL = process.env.PINATA_X402_BASE_URL || 'https://402.pinata.cloud';
const PINATA_X402_NETWORK = process.env.PINATA_X402_NETWORK || 'public';

/**
 * Upload file to Pinata x402 (public or private IPFS)
 * Returns the CID of the uploaded file
 */
export async function uploadFileToPinata(
  file: File | Buffer | Uint8Array,
  fileSize: number,
  network: 'public' | 'private' = PINATA_X402_NETWORK as 'public' | 'private',
  pkpAccount: PKPAccount
): Promise<{ cid: string; gatewayUrl?: string }> {
  try {
    // Step 1: Request presigned URL from Pinata x402
    const pinUrl = `${PINATA_X402_BASE_URL}/v1/pin/${network}`;
    
    logger.debug('Requesting Pinata x402 upload URL', {
      network,
      fileSize,
      url: pinUrl,
    });

    // Use x402 fetch wrapper to handle payment
    const fetchWithPayment = await createBuyerFetch(pkpAccount);

    const response = await fetchWithPayment(pinUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileSize,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to get Pinata upload URL', new Error(errorText), {
        status: response.status,
        network,
        fileSize,
      });
      throw new Error(`Failed to get Pinata upload URL: ${response.status} ${errorText}`);
    }

    const { url: presignedUrl } = (await response.json()) as { url: string };

    logger.debug('Got presigned URL from Pinata', {
      network,
      presignedUrlLength: presignedUrl.length,
    });

    // Step 2: Upload file to presigned URL
    const formData = new FormData();
    formData.append('network', network);
    
    // Convert file to Blob if needed
    let fileBlob: Blob;
    if (file instanceof File) {
      fileBlob = file;
    } else if (Buffer.isBuffer(file)) {
      fileBlob = new Blob([file], { type: 'application/octet-stream' });
    } else {
      fileBlob = new Blob([file], { type: 'application/octet-stream' });
    }
    
    formData.append('file', fileBlob);

    const uploadResponse = await fetch(presignedUrl, {
      method: 'POST',
      body: formData,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      logger.error('Failed to upload file to Pinata', new Error(errorText), {
        status: uploadResponse.status,
        network,
      });
      throw new Error(`Failed to upload file to Pinata: ${uploadResponse.status} ${errorText}`);
    }

    const uploadResult = (await uploadResponse.json()) as { IpfsHash: string };

    const cid = uploadResult.IpfsHash;
    const gatewayUrl = network === 'public' 
      ? `https://ipfs.io/ipfs/${cid}`
      : undefined;

    logger.debug('File uploaded to Pinata', {
      cid,
      network,
      gatewayUrl,
    });

    return {
      cid,
      gatewayUrl,
    };
  } catch (error) {
    logger.error('Error uploading file to Pinata', error as Error, {
      network,
      fileSize,
    });
    throw error;
  }
}

/**
 * Retrieve private file from Pinata x402
 * Returns a temporary access URL
 */
export async function retrievePrivateFile(
  cid: string,
  pkpAccount: PKPAccount
): Promise<{ url: string }> {
  try {
    const retrieveUrl = `${PINATA_X402_BASE_URL}/v1/retrieve/private/${cid}`;

    logger.debug('Requesting private file from Pinata x402', {
      cid,
      url: retrieveUrl,
    });

    // Use x402 fetch wrapper to handle payment
    const fetchWithPayment = await createBuyerFetch(pkpAccount);

    const response = await fetchWithPayment(retrieveUrl, {
      method: 'GET',
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to retrieve private file from Pinata', new Error(errorText), {
        status: response.status,
        cid,
      });
      throw new Error(`Failed to retrieve private file: ${response.status} ${errorText}`);
    }

    const { url } = (await response.json()) as { url: string };

    logger.debug('Got private file access URL from Pinata', {
      cid,
      urlLength: url.length,
    });

    return { url };
  } catch (error) {
    logger.error('Error retrieving private file from Pinata', error as Error, { cid });
    throw error;
  }
}
