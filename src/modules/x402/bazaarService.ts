/**
 * x402 Bazaar Service
 * Handles crawling and caching of x402-protected resources from the Coinbase Facilitator Bazaar Discovery API
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../shared/logger.js';
import { config } from '../../config.js';

/**
 * Parameters for listing discovery resources
 */
export interface ListDiscoveryResourcesParams {
  /** Filter by protocol type (e.g., "http", "mcp") */
  type?: string;
  /** Number of resources to return per page */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * Payment acceptance requirements for a resource
 */
export interface PaymentAccept {
  asset: string;
  network: string;
  scheme: string;
  maxAmountRequired: string;
  maxTimeoutSeconds: number;
  mimeType: string;
  description?: string;
  resource: string;
  payTo: string;
  outputSchema?: {
    input?: {
      type: string;
      method?: string;
      bodyType?: string;
      bodyFields?: Record<string, unknown>;
      queryParams?: Record<string, unknown>;
      headerFields?: Record<string, unknown>;
    };
    output?: Record<string, unknown>;
  };
  extra?: Record<string, unknown>;
  channel?: string;
}

/**
 * A discovered x402 resource from the bazaar
 */
export interface DiscoveryResource {
  /** The URL of the discovered resource */
  resource: string;
  /** The protocol type of the resource */
  type: string;
  /** Payment acceptance requirements */
  accepts: PaymentAccept[];
  /** Last update timestamp */
  lastUpdated: string;
  /** x402 protocol version */
  x402Version: number;
}

/**
 * Pagination information
 */
export interface Pagination {
  limit: number;
  offset: number;
  total: number;
}

/**
 * Response from the discovery API
 */
export interface DiscoveryResourcesResponse {
  /** Array of discovered resources */
  items: DiscoveryResource[];
  /** Pagination information */
  pagination: Pagination;
  /** x402 protocol version */
  x402Version: number;
}

/**
 * Parameters for querying cached resources
 */
export interface QueryCachedResourcesParams {
  /** Filter by protocol type */
  type?: string;
  /** Filter by resource URL substring */
  resource?: string;
  /** Search keyword - matches resource URL or description */
  keyword?: string;
  /** Maximum number of results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * Result of querying cached resources
 */
export interface QueryCachedResourcesResult {
  items: DiscoveryResource[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * List discovery resources from the Coinbase facilitator
 * Includes retry logic with exponential backoff for rate limiting
 */
async function listDiscoveryResources(
  params: ListDiscoveryResourcesParams = {},
  facilitatorUrl?: string,
  retryCount = 0
): Promise<DiscoveryResourcesResponse> {
  const baseUrl = facilitatorUrl || config.bazaar.facilitatorUrl;
  const maxRetries = 3;
  const baseDelay = 1000; // 1 second base delay

  // Build query parameters
  const queryParams = new URLSearchParams();
  if (params.type !== undefined) {
    queryParams.set('type', params.type);
  }
  if (params.limit !== undefined) {
    queryParams.set('limit', params.limit.toString());
  }
  if (params.offset !== undefined) {
    queryParams.set('offset', params.offset.toString());
  }

  const queryString = queryParams.toString();
  const endpoint = `${baseUrl}/discovery/resources${queryString ? `?${queryString}` : ''}`;

  // Prepare headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Make the request
  const response = await fetch(endpoint, {
    method: 'GET',
    headers,
  });

  // Handle rate limiting (429) with retry
  if (response.status === 429 && retryCount < maxRetries) {
    const delay = baseDelay * Math.pow(2, retryCount); // Exponential backoff
    logger.debug('Rate limited, retrying after delay', {
      retryCount: retryCount + 1,
      delayMs: delay,
      endpoint,
    });
    await new Promise((resolve) => setTimeout(resolve, delay));
    return listDiscoveryResources(params, facilitatorUrl, retryCount + 1);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(
      `Failed to list discovery resources (${response.status}): ${errorText}`
    );
  }

  return (await response.json()) as DiscoveryResourcesResponse;
}

/**
 * Crawl all resources from the discovery API and save to cache file
 * Paginates through all pages to collect all resources
 */
export async function crawlAllResources(): Promise<void> {
  const cacheFile = config.bazaar.cacheFile;
  const facilitatorUrl = config.bazaar.facilitatorUrl;

  logger.info('Starting bazaar resources crawl', { facilitatorUrl, cacheFile });

  try {
    const allResources: DiscoveryResource[] = [];
    let offset = 0;
    const limit = 100; // Fetch in batches of 100
    let total = 0;
    let hasMore = true;

    while (hasMore) {
      logger.debug('Fetching bazaar resources page', { offset, limit });

      try {
        const response = await listDiscoveryResources(
          { limit, offset },
          facilitatorUrl
        );

        allResources.push(...response.items);
        total = response.pagination.total;
        offset += response.items.length;

        // Check if we've fetched all resources
        hasMore = offset < total;

        logger.debug('Fetched bazaar resources page', {
          itemsInPage: response.items.length,
          totalFetched: allResources.length,
          totalAvailable: total,
        });

        // Add a delay between requests to avoid rate limiting
        // Only delay if there are more pages to fetch
        if (hasMore) {
          await new Promise((resolve) => setTimeout(resolve, 1000)); // 1 second delay
        }
      } catch (error) {
        // If we hit rate limiting and have some resources, save what we have
        if ((error as Error).message.includes('429') && allResources.length > 0) {
          logger.warning('Rate limited during crawl, saving partial results', {
            resourcesSaved: allResources.length,
            totalAvailable: total,
          });
          hasMore = false; // Stop crawling but save what we have
        } else {
          throw error; // Re-throw other errors
        }
      }
    }

    // Ensure cache directory exists
    const cacheDir = path.dirname(cacheFile);
    await fs.mkdir(cacheDir, { recursive: true });

    // Save to JSON file (even if partial)
    const cacheData = {
      resources: allResources,
      total: allResources.length,
      crawledAt: new Date().toISOString(),
      facilitatorUrl,
      partial: allResources.length < total,
    };

    await fs.writeFile(cacheFile, JSON.stringify(cacheData, null, 2), 'utf-8');

    logger.info('Bazaar resources crawl completed', {
      totalResources: allResources.length,
      cacheFile,
      partial: allResources.length < total,
    });
  } catch (error) {
    logger.error('Failed to crawl bazaar resources', error as Error, {
      facilitatorUrl,
      cacheFile,
    });
    throw error;
  }
}

/**
 * Load cached resources from the JSON file
 */
export async function loadCachedResources(): Promise<DiscoveryResource[]> {
  const cacheFile = config.bazaar.cacheFile;

  try {
    const fileContent = await fs.readFile(cacheFile, 'utf-8');
    const cacheData = JSON.parse(fileContent) as {
      resources: DiscoveryResource[];
      total: number;
      crawledAt: string;
      facilitatorUrl: string;
    };

    logger.debug('Loaded cached bazaar resources', {
      count: cacheData.resources.length,
      crawledAt: cacheData.crawledAt,
    });

    return cacheData.resources;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug('Bazaar cache file not found', { cacheFile });
      return [];
    }

    logger.error('Failed to load cached bazaar resources', error as Error, {
      cacheFile,
    });
    throw error;
  }
}

/**
 * Query cached resources with filtering and pagination
 */
export async function queryCachedResources(
  params: QueryCachedResourcesParams = {}
): Promise<QueryCachedResourcesResult> {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  try {
    const allResources = await loadCachedResources();

    // Apply filters
    let filtered = allResources;

    if (params.type) {
      filtered = filtered.filter((r) => r.type === params.type);
    }

    if (params.resource) {
      const resourceLower = params.resource.toLowerCase();
      filtered = filtered.filter((r) =>
        r.resource.toLowerCase().includes(resourceLower)
      );
    }

    if (params.keyword) {
      const keywordLower = params.keyword.toLowerCase();
      filtered = filtered.filter((r) => {
        // Search in resource URL
        const matchesResource = r.resource.toLowerCase().includes(keywordLower);
        // Search in description fields of accepts
        const matchesDescription = r.accepts.some(
          (accept) =>
            accept.description?.toLowerCase().includes(keywordLower)
        );
        return matchesResource || matchesDescription;
      });
    }

    // Apply pagination
    const paginated = filtered.slice(offset, offset + limit);

    return {
      items: paginated,
      total: filtered.length,
      limit,
      offset,
    };
  } catch (error) {
    logger.error('Failed to query cached bazaar resources', error as Error, {
      params,
    });
    // Return empty result on error rather than throwing
    return {
      items: [],
      total: 0,
      limit,
      offset,
    };
  }
}

