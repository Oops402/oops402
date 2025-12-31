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
  /** Search keyword(s) - matches resource URL or description. Can be a single string or array of strings. All keywords must match (AND logic). */
  keyword?: string | string[];
  /** Maximum number of results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Sort order - 'price_asc' for low to high, 'price_desc' for high to low */
  sortBy?: 'price_asc' | 'price_desc';
}

/**
 * Result of querying cached resources
 */
export interface QueryCachedResourcesResult {
  items: DiscoveryResource[];
  total: number;
  limit: number;
  offset: number;
  promotedResourceUrls?: Set<string>; // Set of promoted resource URLs for UI to mark as "Promoted"
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
  const maxRetries = 20; // Increased retries for persistent rate limiting
  const baseDelay = 2000; // 2 seconds base delay
  const maxDelay = 60000; // Cap at 60 seconds

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
    // Check for Retry-After header (in seconds)
    let delay = baseDelay * Math.pow(2, retryCount); // Exponential backoff
    
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const retryAfterSeconds = parseInt(retryAfter, 10);
      if (!isNaN(retryAfterSeconds)) {
        // Use Retry-After if it's longer than our calculated delay
        delay = Math.max(delay, retryAfterSeconds * 1000);
      }
    }
    
    // Cap the delay at maxDelay
    delay = Math.min(delay, maxDelay);
    
    // Add jitter (±20%) to avoid thundering herd
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    delay = Math.max(1000, delay + jitter);
    
    logger.debug('Rate limited, retrying after delay', {
      retryCount: retryCount + 1,
      delayMs: Math.round(delay),
      retryAfter: retryAfter || 'not provided',
      endpoint,
    });
    
    await new Promise((resolve) => setTimeout(resolve, Math.round(delay)));
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
 * Crawl all resources from the discovery API and save to Supabase database
 * Paginates through all pages to collect all resources
 * Uses upsert logic to prevent duplicates
 */
export async function crawlAllResources(): Promise<void> {
  const facilitatorUrl = config.bazaar.facilitatorUrl;

  logger.info('Starting bazaar resources crawl', { facilitatorUrl });

  try {
    const allResources: DiscoveryResource[] = [];
    let offset = 0;
    const limit = 100; // Fetch in batches of 100
    let total = 0;
    let hasMore = true;
    let baseDelay = 2000; // Start with 2 seconds between requests
    let consecutiveRateLimits = 0;
    const maxConsecutiveRateLimits = 3; // After 3 consecutive rate limits, increase delay

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

        // Reset consecutive rate limit counter on success
        consecutiveRateLimits = 0;

        logger.debug('Fetched bazaar resources page', {
          itemsInPage: response.items.length,
          totalFetched: allResources.length,
          totalAvailable: total,
          progress: total > 0 ? `${((allResources.length / total) * 100).toFixed(1)}%` : '0%',
        });

        // Add a delay between requests to avoid rate limiting
        // Only delay if there are more pages to fetch
        if (hasMore) {
          // Add jitter to avoid synchronized requests
          const jitter = baseDelay * 0.1 * (Math.random() * 2 - 1);
          const delay = Math.max(1000, baseDelay + jitter);
          await new Promise((resolve) => setTimeout(resolve, Math.round(delay)));
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        
        // Handle rate limiting more gracefully
        if (errorMessage.includes('429')) {
          consecutiveRateLimits++;
          
          // If we've hit multiple consecutive rate limits, increase the base delay
          if (consecutiveRateLimits >= maxConsecutiveRateLimits) {
            baseDelay = Math.min(baseDelay * 1.5, 10000); // Cap at 10 seconds
            logger.info('Increasing request delay due to consecutive rate limits', {
              newBaseDelay: baseDelay,
              consecutiveRateLimits,
            });
            consecutiveRateLimits = 0; // Reset counter after adjusting
          }
          
          // Wait longer before retrying the same request
          const cooldownDelay = Math.min(baseDelay * 3, 30000); // Up to 30 seconds cooldown
          logger.warning('Rate limited during crawl, cooling down before continuing', {
            consecutiveRateLimits,
            cooldownMs: cooldownDelay,
            resourcesFetched: allResources.length,
            totalAvailable: total,
          });
          
          await new Promise((resolve) => setTimeout(resolve, cooldownDelay));
          
          // Continue the loop to retry the same offset
          continue;
        } else {
          // For non-rate-limit errors, throw immediately
          throw error;
        }
      }
    }

    // Save to Supabase database using upsert logic
    const { upsertBazaarResource } = await import('./bazaarDbService.js');
    
    let savedCount = 0;
    let errorCount = 0;
    
    for (const resource of allResources) {
      try {
        // Only update resources with source='bazaar' (don't overwrite promoted resources)
        // Check if resource exists and has source='promotion' - if so, skip it
        const { findBazaarResourceByUrl } = await import('./bazaarDbService.js');
        const existing = await findBazaarResourceByUrl(resource.resource);
        
        if (existing) {
          // Check if it's a promoted resource - if so, skip updating it
          const { supabase: dbSupabase } = await import('./bazaarDbService.js');
          const { data } = await dbSupabase
            .from('oops402_bazaar_resources')
            .select('source')
            .eq('resource_url', resource.resource)
            .single();
          
          if (data?.source === 'promotion') {
            logger.debug('Skipping update of promoted resource', {
              resourceUrl: resource.resource,
            });
            continue;
          }
        }
        
        await upsertBazaarResource(resource, 'bazaar');
        savedCount++;
        
        // Log progress every 100 resources
        if (savedCount % 100 === 0) {
          logger.info(`Crawl progress: ${savedCount}/${allResources.length} resources saved to database`);
        }
      } catch (error) {
        errorCount++;
        logger.error('Failed to save resource to database', error as Error, {
          resourceUrl: resource.resource,
        });
      }
    }

    logger.info('Bazaar resources crawl completed', {
      totalResources: allResources.length,
      saved: savedCount,
      errors: errorCount,
      partial: allResources.length < total,
    });
  } catch (error) {
    logger.error('Failed to crawl bazaar resources', error as Error, {
      facilitatorUrl,
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
 * Find bazaar resources that match a given payTo address
 * Returns resources where any accept has a matching payTo address
 */
export async function findResourcesByPayTo(
  payToAddress: string
): Promise<DiscoveryResource[]> {
  try {
    // Try to use database service first
    const { findBazaarResourcesByPayTo } = await import('./bazaarDbService.js');
    return await findBazaarResourcesByPayTo(payToAddress);
  } catch (error) {
    // Fallback to loading all resources and filtering
    logger.warning('Failed to find resources by payTo in database, using fallback', {
      error: (error as Error).message,
    });
    
    try {
      const allResources = await loadCachedResources();
      const payToLower = payToAddress.toLowerCase();
      
      return allResources.filter((resource) =>
        resource.accepts.some(
          (accept) => accept.payTo?.toLowerCase() === payToLower
        )
      );
    } catch (fallbackError) {
      logger.error('Failed to find resources by payTo', fallbackError as Error, {
        payToAddress,
      });
      return [];
    }
  }
}

/**
 * Query cached resources with filtering and pagination
 * Includes promotion merging - promoted results appear first
 * Uses Supabase database with fallback to JSON file
 */
export async function queryCachedResources(
  params: QueryCachedResourcesParams = {},
  sessionIdHash?: string // For tracking impressions
): Promise<QueryCachedResourcesResult> {
  try {
    // Try to use database service first
    const { queryBazaarResources } = await import('./bazaarDbService.js');
    return await queryBazaarResources(params, sessionIdHash);
  } catch (error) {
    // Fallback to original implementation using JSON file
    logger.warning('Failed to query database, falling back to JSON file', {
      error: (error as Error).message,
    });
    
    return await queryCachedResourcesFallback(params, sessionIdHash);
  }
}

/**
 * Fallback implementation using JSON file (for migration period)
 */
async function queryCachedResourcesFallback(
  params: QueryCachedResourcesParams = {},
  sessionIdHash?: string
): Promise<QueryCachedResourcesResult> {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  try {
    const allResources = await loadCachedResources();

    // Fetch active promotions for bazaar resources
    // When keyword is provided, also filter promotions by keyword to include
    // promoted resources that aren't in the cache
    const { getActivePromotions } = await import('../promotions/service.js');
    const { trackPromotedImpression } = await import('../analytics/service.js');
    
    const activePromotions = await getActivePromotions({
      resourceType: 'bazaar',
      keyword: params.keyword, // Filter promotions by keyword if provided
      resourceUrl: params.resource, // Only filter by exact resource URL if provided
    });

    // Create a map of promoted resource URLs for quick lookup
    const promotedResourceMap = new Map<string, string>(); // resource_url -> promotion_id
    for (const promotion of activePromotions) {
      promotedResourceMap.set(promotion.resource_url.toLowerCase(), promotion.id);
    }

    // Create a set of cached resource URLs for quick lookup
    const cachedResourceUrls = new Set<string>();
    for (const resource of allResources) {
      cachedResourceUrls.add(resource.resource.toLowerCase());
    }

    // For promoted resources that match the keyword but aren't in cache,
    // fetch their schema and create DiscoveryResource objects
    // Note: activePromotions are already filtered by keyword (including description)
    // via getActivePromotions, so we just need to check if they're not in cache
    const promotedResourcesNotInCache: DiscoveryResource[] = [];
    if (params.keyword) {
      for (const promotion of activePromotions) {
        const resourceUrlLower = promotion.resource_url.toLowerCase();
        // Check if this promoted resource isn't in cache
        // (keyword matching already done by getActivePromotions)
        if (!cachedResourceUrls.has(resourceUrlLower)) {
          try {
            // Fetch the x402 schema for this resource
            // Try both GET and POST methods (similar to promotion validation)
            const { validateX402Resource } = await import('../x402/schemaValidation.js');
            const methods = ['GET', 'POST'];
            let validation = null;
            
            for (const method of methods) {
              try {
                validation = await validateX402Resource(promotion.resource_url, method);
                if (validation.hasX402Schema && validation.schema) {
                  break; // Found valid schema, stop trying other methods
                }
              } catch (methodError) {
                // Try next method if this one fails
                continue;
              }
            }
            
            if (validation && validation.hasX402Schema && validation.schema) {
              // Create a DiscoveryResource from the schema
              const schema = validation.schema;
              const discoveryResource: DiscoveryResource = {
                resource: promotion.resource_url,
                type: schema.type || 'http',
                accepts: schema.accepts || [],
                lastUpdated: new Date().toISOString(),
                x402Version: schema.x402Version || 1,
              };
              promotedResourcesNotInCache.push(discoveryResource);
            }
          } catch (error) {
            logger.debug('Failed to fetch schema for promoted resource', {
              resourceUrl: promotion.resource_url,
              error: (error as Error).message,
            });
            // Continue with other promotions even if one fails
          }
        }
      }
    }

    // Track impressions for promoted resources (if sessionIdHash provided)
    // Use first keyword for tracking if array, or the string itself
    const keywordForTracking = params.keyword 
      ? (Array.isArray(params.keyword) ? params.keyword[0] : params.keyword)
      : undefined;
    
    if (sessionIdHash) {
      for (const promotion of activePromotions) {
        trackPromotedImpression({
          promotion_id: promotion.id,
          search_keyword: keywordForTracking,
          session_id_hash: sessionIdHash,
        }).catch((err) => {
          logger.error('Failed to track promotion impression', err as Error);
        });
      }
    }

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
      // Normalize to array: convert single string to array
      const keywords = Array.isArray(params.keyword) ? params.keyword : [params.keyword];
      const keywordsLower = keywords.map(k => k.toLowerCase());
      
      filtered = filtered.filter((r) => {
        // Check if ALL keywords match (AND logic)
        return keywordsLower.every((keywordLower) => {
          // Search in resource URL
          const matchesResource = r.resource.toLowerCase().includes(keywordLower);
          // Search in description fields of accepts
          const matchesDescription = r.accepts.some(
            (accept) =>
              accept.description?.toLowerCase().includes(keywordLower)
          );
          // At least one of these must match for this keyword
          return matchesResource || matchesDescription;
        });
      });
    }

    // Apply sorting
    if (params.sortBy === 'price_asc' || params.sortBy === 'price_desc') {
      filtered = filtered.sort((a, b) => {
        // Get minimum price from all accepts for each resource
        const getMinPrice = (resource: DiscoveryResource): number => {
          if (resource.accepts.length === 0) return Infinity;
          return Math.min(
            ...resource.accepts.map((accept) => {
              const amount = parseFloat(accept.maxAmountRequired);
              return isNaN(amount) ? Infinity : amount;
            })
          );
        };

        const priceA = getMinPrice(a);
        const priceB = getMinPrice(b);

        if (params.sortBy === 'price_asc') {
          return priceA - priceB;
        } else {
          return priceB - priceA;
        }
      });
    }

    // Separate promoted and organic results
    const promoted: DiscoveryResource[] = [];
    const organic: DiscoveryResource[] = [];
    const promotedUrls = new Set<string>();

    // Add promoted resources that aren't in cache first (these are already filtered by keyword)
    for (const resource of promotedResourcesNotInCache) {
      const resourceUrlLower = resource.resource.toLowerCase();
      promoted.push(resource);
      promotedUrls.add(resourceUrlLower);
    }

    // Process cached resources
    for (const resource of filtered) {
      const resourceUrlLower = resource.resource.toLowerCase();
      if (promotedResourceMap.has(resourceUrlLower)) {
        // Mark as promoted (add to promoted array)
        // Skip if already added from promotedResourcesNotInCache
        if (!promotedUrls.has(resourceUrlLower)) {
          promoted.push({
            ...resource,
            // We'll mark promoted in the result by checking if it's in the promoted array
          });
          promotedUrls.add(resourceUrlLower);
        }
      } else {
        organic.push(resource);
      }
    }

    // Merge: promoted first, then organic (excluding duplicates)
    const organicFiltered = organic.filter(
      (r) => !promotedUrls.has(r.resource.toLowerCase())
    );
    const merged = [...promoted, ...organicFiltered];

    // Apply pagination
    const paginated = merged.slice(offset, offset + limit);

    return {
      items: paginated,
      total: merged.length,
      limit,
      offset,
      promotedResourceUrls: promotedUrls, // Include promoted URLs set for UI
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

