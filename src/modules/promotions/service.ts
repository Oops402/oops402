/**
 * Promotion Service
 * Handles promotion CRUD operations and validation
 */

import { getSupabaseClient } from '../shared/supabase.js';
import { logger } from '../shared/logger.js';
import { validateX402Resource } from '../x402/schemaValidation.js';
import { config } from '../../config.js';
import { verifyPromotionPayment } from './transactionVerification.js';
import type {
  Promotion,
  CreatePromotionParams,
  GetActivePromotionsParams,
  PromotionAnalytics,
} from './types.js';

const supabase = getSupabaseClient();

/**
 * Create a new promotion
 */
export async function createPromotion(params: CreatePromotionParams): Promise<Promotion> {
  // Validate that the resource is a valid x402 resource (check both GET and POST methods)
  const methods = ['GET', 'POST'];
  const validations = await Promise.all(
    methods.map(method => validateX402Resource(params.resourceUrl, method))
  );

  // Resource is valid if at least one method returns a valid schema
  const hasValidSchema = validations.some(validation => validation.hasX402Schema);
  
  if (!hasValidSchema) {
    throw new Error('Resource does not have a valid x402 schema for GET or POST methods');
  }

  // Extract description and full schema from the first valid schema
  // Combine descriptions from all accepts to create a searchable description
  let extractedDescription: string | undefined;
  let fullSchema: any = null;
  for (const validation of validations) {
    if (validation.hasX402Schema && validation.schema) {
      fullSchema = validation.schema;
      const accepts = Array.isArray(validation.schema.accepts) ? validation.schema.accepts : [];
      const descriptions = accepts
        .map((accept: any) => accept.description)
        .filter((desc: any): desc is string => typeof desc === 'string' && desc.trim().length > 0);
      
      if (descriptions.length > 0) {
        // Combine all descriptions into one searchable string
        extractedDescription = descriptions.join(' ');
        break; // Use the first valid schema's descriptions
      }
    }
  }

  // Check for existing active promotion for this resource
  const { data: existing } = await supabase
    .from('oops402_promotions')
    .select('id')
    .eq('resource_url', params.resourceUrl)
    .eq('status', 'active')
    .single();

  if (existing) {
    throw new Error('An active promotion already exists for this resource');
  }

  // Validate days
  if (!params.days || params.days < 1) {
    throw new Error('Number of days must be at least 1');
  }

  // Calculate total payment amount from days * fee per day
  const feePerDay = BigInt(Math.floor(parseFloat(config.promotion.feePerDay) * 1e6)); // Convert to smallest USDC unit (6 decimals)
  const totalAmount = feePerDay * BigInt(params.days);
  const paymentAmount = totalAmount.toString();

  // Verify payment transaction before creating promotion
  logger.debug('Verifying promotion payment transaction', {
    txHash: params.paymentTxHash,
    expectedAmount: paymentAmount,
    expectedFrom: params.promotedByWallet,
  });

  const verification = await verifyPromotionPayment(
    params.paymentTxHash,
    paymentAmount,
    params.promotedByWallet.toLowerCase(),
    config.promotion.paymentRecipient
  );

  if (!verification.valid) {
    logger.error('Promotion payment verification failed', new Error(verification.error || 'Unknown error'), {
      txHash: params.paymentTxHash,
      expectedAmount: paymentAmount,
    });
    throw new Error(`Payment verification failed: ${verification.error || 'Transaction is invalid or does not match expected payment'}`);
  }

  logger.info('Promotion payment verified', {
    txHash: params.paymentTxHash,
    blockNumber: verification.transaction?.blockNumber.toString(),
  });

  // Calculate end date from days
  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + params.days);

  // Create the promotion
  const promotionData: any = {
    resource_url: params.resourceUrl,
    promoted_by_wallet: params.promotedByWallet.toLowerCase(),
    payment_amount: paymentAmount,
    payment_tx_hash: params.paymentTxHash,
    status: 'active',
    start_date: startDate.toISOString(),
    end_date: endDate.toISOString(),
    resource_type: params.resourceType || 'bazaar',
  };

  if (params.agentId) {
    promotionData.agent_id = params.agentId;
  }

  if (extractedDescription) {
    promotionData.description = extractedDescription;
  }

  const { data: promotion, error } = await supabase
    .from('oops402_promotions')
    .insert(promotionData)
    .select()
    .single();

  if (error) {
    logger.error('Failed to create promotion', error as Error, {
      resourceUrl: params.resourceUrl,
      days: params.days,
    });
    throw new Error(`Failed to create promotion: ${error.message}`);
  }

  logger.info('Promotion created', { promotion_id: promotion.id, resource_url: params.resourceUrl });

  // Store full x402 schema in bazaar_resources table if we have a valid schema
  if (fullSchema && fullSchema.accepts) {
    try {
      const { upsertBazaarResource } = await import('../x402/bazaarDbService.js');
      const discoveryResource = {
        resource: params.resourceUrl,
        type: fullSchema.type || 'http',
        accepts: Array.isArray(fullSchema.accepts) ? fullSchema.accepts : [],
        lastUpdated: new Date().toISOString(),
        x402Version: fullSchema.x402Version || 1,
      };
      
      await upsertBazaarResource(discoveryResource, 'promotion', promotion.id);
      logger.info('Stored full schema in bazaar_resources', {
        promotion_id: promotion.id,
        resource_url: params.resourceUrl,
      });
    } catch (error) {
      // Log error but don't fail promotion creation if schema storage fails
      logger.error('Failed to store full schema in bazaar_resources', error as Error, {
        promotion_id: promotion.id,
        resource_url: params.resourceUrl,
      });
    }
  }

  return promotion as Promotion;
}

/**
 * Get active promotions matching search criteria
 */
export async function getActivePromotions(
  params: GetActivePromotionsParams = {}
): Promise<Promotion[]> {
  try {
    let query = supabase
      .from('oops402_promotions')
      .select('*')
      .eq('status', 'active')
      .lte('start_date', new Date().toISOString()) // Promotion has started (start_date <= now)
      .order('start_date', { ascending: false });

    // Filter by resource type if provided
    if (params.resourceType) {
      query = query.eq('resource_type', params.resourceType);
    }

    // Filter by resource URL if provided
    if (params.resourceUrl) {
      query = query.eq('resource_url', params.resourceUrl);
    }

    // Filter by agent ID if provided
    if (params.agentId) {
      query = query.eq('agent_id', params.agentId);
    }

    const { data: promotions, error } = await query;

    if (error) throw error;

    // Filter by keyword if provided (client-side filtering for flexibility)
    // Supports both single keyword (string) and multiple keywords (array)
    // All keywords must match (AND logic)
    let filtered = promotions || [];
    if (params.keyword) {
      // Normalize to array: convert single string to array
      const keywords = Array.isArray(params.keyword) ? params.keyword : [params.keyword];
      const keywordsLower = keywords.map(k => k.toLowerCase());
      
      filtered = filtered.filter((p) => {
        // Check if ALL keywords match (AND logic)
        return keywordsLower.every((keywordLower) => {
          return (
            p.resource_url.toLowerCase().includes(keywordLower) ||
            (p.agent_id && p.agent_id.toLowerCase().includes(keywordLower)) ||
            (p.description && p.description.toLowerCase().includes(keywordLower))
          );
        });
      });
    }

    // Filter out expired promotions (end_date check)
    const now = new Date().toISOString();
    filtered = filtered.filter(
      (p) => !p.end_date || new Date(p.end_date) >= new Date(now)
    );

    return filtered as Promotion[];
  } catch (error) {
    logger.error('Failed to get active promotions', error as Error, {
      resourceType: params.resourceType,
      keyword: params.keyword,
    });
    return [];
  }
}

/**
 * Get a promotion by ID
 */
export async function getPromotionById(promotionId: string): Promise<Promotion | null> {
  try {
    const { data: promotion, error } = await supabase
      .from('oops402_promotions')
      .select('*')
      .eq('id', promotionId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      throw error;
    }

    return promotion as Promotion;
  } catch (error) {
    logger.error('Failed to get promotion by ID', error as Error, { promotionId });
    return null;
  }
}

/**
 * Get promotions by wallet address
 */
export async function getPromotionsByWallet(
  walletAddress: string,
  includeInactive: boolean = false
): Promise<Promotion[]> {
  try {
    let query = supabase
      .from('oops402_promotions')
      .select('*')
      .eq('promoted_by_wallet', walletAddress.toLowerCase())
      .order('created_at', { ascending: false });

    if (!includeInactive) {
      query = query.eq('status', 'active');
    }

    const { data: promotions, error } = await query;

    if (error) throw error;

    return (promotions || []) as Promotion[];
  } catch (error) {
    logger.error('Failed to get promotions by wallet', error as Error, { walletAddress });
    return [];
  }
}

/**
 * Check if a resource has an active promotion
 */
export async function hasActivePromotion(resourceUrl: string): Promise<Promotion | null> {
  try {
    const promotions = await getActivePromotions({ resourceUrl });
    return promotions.length > 0 ? promotions[0] : null;
  } catch (error) {
    logger.error('Failed to check active promotion', error as Error, { resourceUrl });
    return null;
  }
}

/**
 * Get detailed analytics for a promotion
 */
export async function getPromotionAnalytics(promotionId: string): Promise<PromotionAnalytics> {
  try {
    // Get clicks
    const { data: clicks, error: clicksError } = await supabase
      .from('oops402_click_analytics')
      .select('id')
      .eq('promotion_id', promotionId);

    if (clicksError) throw clicksError;

    // Get impressions
    const { data: impressions, error: impressionsError } = await supabase
      .from('oops402_promotion_impressions')
      .select('id, search_keyword')
      .eq('promotion_id', promotionId);

    if (impressionsError) throw impressionsError;

    // Get payments linked to this promotion
    const { data: promotionPayments, error: paymentsError } = await supabase
      .from('oops402_promotion_payments')
      .select('payment_id, oops402_payments!inner(amount)')
      .eq('promotion_id', promotionId);

    if (paymentsError) throw paymentsError;

    const clicksCount = clicks?.length || 0;
    const impressionsCount = impressions?.length || 0;
    const ctr = impressionsCount > 0 ? (clicksCount / impressionsCount) * 100 : 0;
    const paymentsReceived = promotionPayments?.length || 0;

    // Calculate total payment volume
    let paymentVolume = 0n;
    if (promotionPayments) {
      for (const pp of promotionPayments) {
        const payment = (pp as any).oops402_payments;
        // Handle both array and object cases from Supabase join
        const paymentData = Array.isArray(payment) ? payment[0] : payment;
        if (paymentData && typeof paymentData === 'object' && 'amount' in paymentData && paymentData.amount) {
          paymentVolume += BigInt(paymentData.amount);
        }
      }
    }

    const conversionRate = clicksCount > 0 ? (paymentsReceived / clicksCount) * 100 : 0;

    // Get top keywords from impressions
    const keywordMap = new Map<string, number>();
    if (impressions) {
      for (const impression of impressions) {
        const keyword = impression.search_keyword;
        if (keyword) {
          keywordMap.set(keyword, (keywordMap.get(keyword) || 0) + 1);
        }
      }
    }

    const topKeywords = Array.from(keywordMap.entries())
      .map(([keyword, count]) => ({ keyword, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      promotion_id: promotionId,
      clicks: clicksCount,
      impressions: impressionsCount,
      ctr,
      payments_received: paymentsReceived,
      payment_volume: paymentVolume.toString(),
      conversion_rate: conversionRate,
      top_keywords: topKeywords,
    };
  } catch (error) {
    logger.error('Failed to get promotion analytics', error as Error, { promotionId });
    return {
      promotion_id: promotionId,
      clicks: 0,
      impressions: 0,
      ctr: 0,
      payments_received: 0,
      payment_volume: '0',
      conversion_rate: 0,
      top_keywords: [],
    };
  }
}

