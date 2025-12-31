/**
 * Bazaar Resources Database Service
 * Handles storage and retrieval of x402-protected resources in Supabase
 */

import { getSupabaseClient } from '../shared/supabase.js';
import { logger } from '../shared/logger.js';
import type {
  DiscoveryResource,
  PaymentAccept,
  QueryCachedResourcesParams,
  QueryCachedResourcesResult,
} from './bazaarService.js';

// Export supabase client for use in bazaarService
export const supabase = getSupabaseClient();

/**
 * Upsert a bazaar resource (insert or update)
 * Checks for existing resource_url to prevent duplicates
 */
export async function upsertBazaarResource(
  resource: DiscoveryResource,
  source: 'bazaar' | 'promotion',
  promotionId?: string
): Promise<void> {
  try {
    const resourceData = {
      resource_url: resource.resource,
      type: resource.type,
      accepts: resource.accepts,
      last_updated: resource.lastUpdated,
      x402_version: resource.x402Version,
      source,
      promotion_id: promotionId || null,
    };

    // Use upsert with conflict resolution on resource_url
    const { error } = await supabase
      .from('oops402_bazaar_resources')
      .upsert(resourceData, {
        onConflict: 'resource_url',
        ignoreDuplicates: false, // Update if exists
      });

    if (error) {
      logger.error('Failed to upsert bazaar resource', error as Error, {
        resourceUrl: resource.resource,
        source,
      });
      throw error;
    }

    logger.debug('Upserted bazaar resource', {
      resourceUrl: resource.resource,
      source,
      promotionId,
    });
  } catch (error) {
    logger.error('Error upserting bazaar resource', error as Error, {
      resourceUrl: resource.resource,
    });
    throw error;
  }
}

/**
 * Load all bazaar resources from database
 */
export async function loadBazaarResources(): Promise<DiscoveryResource[]> {
  try {
    const { data, error } = await supabase
      .from('oops402_bazaar_resources')
      .select('*')
      .order('last_updated', { ascending: false });

    if (error) {
      logger.error('Failed to load bazaar resources', error as Error);
      throw error;
    }

    if (!data) {
      return [];
    }

    // Convert database records to DiscoveryResource format
    const resources: DiscoveryResource[] = data.map((row: any) => ({
      resource: row.resource_url,
      type: row.type,
      accepts: row.accepts,
      lastUpdated: row.last_updated,
      x402Version: row.x402_version,
    }));

    logger.debug('Loaded bazaar resources from database', {
      count: resources.length,
    });

    return resources;
  } catch (error) {
    logger.error('Error loading bazaar resources', error as Error);
    throw error;
  }
}

/**
 * Find a bazaar resource by URL
 */
export async function findBazaarResourceByUrl(
  resourceUrl: string
): Promise<DiscoveryResource | null> {
  try {
    const { data, error } = await supabase
      .from('oops402_bazaar_resources')
      .select('*')
      .eq('resource_url', resourceUrl)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // Not found
        return null;
      }
      logger.error('Failed to find bazaar resource by URL', error as Error, {
        resourceUrl,
      });
      throw error;
    }

    if (!data) {
      return null;
    }

    return {
      resource: data.resource_url,
      type: data.type,
      accepts: data.accepts,
      lastUpdated: data.last_updated,
      x402Version: data.x402_version,
    };
  } catch (error) {
    logger.error('Error finding bazaar resource by URL', error as Error, {
      resourceUrl,
    });
    throw error;
  }
}

/**
 * Find bazaar resources by payTo address
 */
export async function findBazaarResourcesByPayTo(
  payToAddress: string
): Promise<DiscoveryResource[]> {
  try {
    const payToLower = payToAddress.toLowerCase();

    // Query using JSONB path operations to search within accepts array
    const { data, error } = await supabase
      .from('oops402_bazaar_resources')
      .select('*');

    if (error) {
      logger.error('Failed to find resources by payTo', error as Error, {
        payToAddress,
      });
      throw error;
    }

    if (!data) {
      return [];
    }

    // Filter resources where any accept has matching payTo
    const resources: DiscoveryResource[] = data
      .map((row: any) => ({
        resource: row.resource_url,
        type: row.type,
        accepts: row.accepts,
        lastUpdated: row.last_updated,
        x402Version: row.x402_version,
      }))
      .filter((resource) =>
        resource.accepts.some(
          (accept: PaymentAccept) => accept.payTo?.toLowerCase() === payToLower
        )
      );

    return resources;
  } catch (error) {
    logger.error('Error finding resources by payTo', error as Error, {
      payToAddress,
    });
    throw error;
  }
}

/**
 * Query bazaar resources with filtering and pagination
 * Includes promotion merging - promoted results appear first
 */
export async function queryBazaarResources(
  params: QueryCachedResourcesParams = {},
  sessionIdHash?: string
): Promise<QueryCachedResourcesResult> {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  try {
    // Start building query
    let query = supabase.from('oops402_bazaar_resources').select('*', { count: 'exact' });

    // Apply filters
    if (params.type) {
      query = query.eq('type', params.type);
    }

    if (params.resource) {
      const resourceLower = params.resource.toLowerCase();
      query = query.ilike('resource_url', `%${resourceLower}%`);
    }

    // For keyword search, we need to search both resource_url and accepts descriptions
    // Since Supabase PostgREST doesn't easily support OR conditions across different columns,
    // we'll fetch all resources and filter in memory to ensure we catch matches in both
    // resource_url and accepts JSONB (including descriptions)
    // Note: We could optimize this with a PostgreSQL function/RPC, but this approach is simpler

    // Execute query
    const { data, error, count } = await query;

    if (error) {
      logger.error('Failed to query bazaar resources', error as Error, {
        params,
      });
      throw error;
    }

    if (!data) {
      return {
        items: [],
        total: 0,
        limit,
        offset,
      };
    }

    // Convert to DiscoveryResource format
    // Ensure accepts is parsed if it's a string (Supabase JSONB might return as string in some cases)
    let resources: DiscoveryResource[] = data.map((row: any) => {
      let accepts = row.accepts;
      // Parse accepts if it's a string
      if (typeof accepts === 'string') {
        try {
          accepts = JSON.parse(accepts);
        } catch (e) {
          logger.warning('Failed to parse accepts JSON', { resourceUrl: row.resource_url });
          accepts = [];
        }
      }
      
      return {
        resource: row.resource_url,
        type: row.type,
        accepts: Array.isArray(accepts) ? accepts : [],
        lastUpdated: row.last_updated,
        x402Version: row.x402_version,
      };
    });

    // Apply keyword filter (search in resource URL and accepts descriptions)
    // Supports both single keyword (string) and multiple keywords (array)
    // All keywords must match (AND logic)
    if (params.keyword) {
      // Normalize to array: convert single string to array
      const keywords = Array.isArray(params.keyword) ? params.keyword : [params.keyword];
      const keywordsLower = keywords.map(k => k.toLowerCase());
      
      resources = resources.filter((r) => {
        // Check if ALL keywords match (AND logic)
        return keywordsLower.every((keywordLower) => {
          // Search in resource URL
          const matchesResource = r.resource.toLowerCase().includes(keywordLower);
          
          // Search in description fields of accepts
          const matchesDescription = r.accepts.some(
            (accept: PaymentAccept) =>
              accept.description?.toLowerCase().includes(keywordLower)
          );
          
          // Also search in the entire accepts JSONB as text (catches any field)
          // This ensures we find keywords in any part of the accepts structure
          const acceptsAsText = JSON.stringify(r.accepts).toLowerCase();
          const matchesAcceptsText = acceptsAsText.includes(keywordLower);
          
          // At least one of these must match for this keyword
          return matchesResource || matchesDescription || matchesAcceptsText;
        });
      });
    }

    // Fetch active promotions for bazaar resources
    const { getActivePromotions } = await import('../promotions/service.js');
    const { trackPromotedImpression } = await import('../analytics/service.js');

    const activePromotions = await getActivePromotions({
      resourceType: 'bazaar',
      keyword: params.keyword,
      resourceUrl: params.resource,
    });

    // Create a map of promoted resource URLs for quick lookup
    const promotedResourceMap = new Map<string, string>();
    for (const promotion of activePromotions) {
      promotedResourceMap.set(promotion.resource_url.toLowerCase(), promotion.id);
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

    // Apply sorting
    if (params.sortBy === 'price_asc' || params.sortBy === 'price_desc') {
      resources = resources.sort((a, b) => {
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

    // For promoted resources that match the keyword but aren't in the resources array,
    // load them from the database
    const promotedResourcesNotInResults: DiscoveryResource[] = [];
    if (params.keyword && activePromotions.length > 0) {
      const resourceUrlsInResults = new Set(resources.map(r => r.resource.toLowerCase()));
      
      for (const promotion of activePromotions) {
        const resourceUrlLower = promotion.resource_url.toLowerCase();
        // If this promoted resource isn't in our results, load it from database
        if (!resourceUrlsInResults.has(resourceUrlLower)) {
          try {
            const promotedResource = await findBazaarResourceByUrl(promotion.resource_url);
            if (promotedResource) {
              // Check if it matches ALL keywords (AND logic)
              // Normalize keyword to array for matching
              const keywords = Array.isArray(params.keyword) ? params.keyword : [params.keyword];
              const keywordsLower = keywords.map(k => k.toLowerCase());
              
              const matchesAllKeywords = keywordsLower.every((keywordLower) => {
                const matchesResource = promotedResource.resource.toLowerCase().includes(keywordLower);
                const matchesDescription = promotedResource.accepts.some(
                  (accept: PaymentAccept) =>
                    accept.description?.toLowerCase().includes(keywordLower)
                );
                const acceptsAsText = JSON.stringify(promotedResource.accepts).toLowerCase();
                const matchesAcceptsText = acceptsAsText.includes(keywordLower);
                return matchesResource || matchesDescription || matchesAcceptsText;
              });
              
              if (matchesAllKeywords) {
                promotedResourcesNotInResults.push(promotedResource);
              }
            }
          } catch (error) {
            logger.debug('Failed to load promoted resource from database', {
              resourceUrl: promotion.resource_url,
              error: (error as Error).message,
            });
          }
        }
      }
    }

    // Separate promoted and organic results
    const promoted: DiscoveryResource[] = [];
    const organic: DiscoveryResource[] = [];
    const promotedUrls = new Set<string>();

    // Add promoted resources that weren't in initial results
    for (const resource of promotedResourcesNotInResults) {
      const resourceUrlLower = resource.resource.toLowerCase();
      promoted.push(resource);
      promotedUrls.add(resourceUrlLower);
    }

    for (const resource of resources) {
      const resourceUrlLower = resource.resource.toLowerCase();
      if (promotedResourceMap.has(resourceUrlLower)) {
        promoted.push(resource);
        promotedUrls.add(resourceUrlLower);
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
      promotedResourceUrls: promotedUrls,
    };
  } catch (error) {
    logger.error('Failed to query bazaar resources', error as Error, {
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

/**
 * Migrate existing JSON file data to Supabase database
 * This is a one-time migration function
 */
export async function migrateJsonToDatabase(): Promise<void> {
  try {
    const { loadCachedResources } = await import('./bazaarService.js');
    
    logger.info('Starting migration of JSON bazaar resources to database');
    
    // Load resources from JSON file (using the old function)
    const resources = await loadCachedResources();
    
    logger.info(`Found ${resources.length} resources to migrate`);
    
    // Upsert each resource
    let successCount = 0;
    let errorCount = 0;
    
    for (const resource of resources) {
      try {
        await upsertBazaarResource(resource, 'bazaar');
        successCount++;
        
        // Log progress every 100 resources
        if (successCount % 100 === 0) {
          logger.info(`Migration progress: ${successCount}/${resources.length} resources migrated`);
        }
      } catch (error) {
        errorCount++;
        logger.error('Failed to migrate resource', error as Error, {
          resourceUrl: resource.resource,
        });
      }
    }
    
    logger.info('Migration completed', {
      total: resources.length,
      success: successCount,
      errors: errorCount,
    });
  } catch (error) {
    logger.error('Migration failed', error as Error);
    throw error;
  }
}

