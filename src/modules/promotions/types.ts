/**
 * Promotion types for x402 resource and agent promotion system
 */

export type PromotionStatus = 'active' | 'inactive' | 'expired';

export interface Promotion {
  id: string;
  resource_url: string;
  agent_id?: string;
  promoted_by_wallet: string;
  status: PromotionStatus;
  start_date: string;
  end_date?: string;
  payment_amount: string;
  payment_tx_hash: string;
  resource_type?: 'bazaar' | 'agent';
  description?: string; // Description extracted from x402 schema accepts (for keyword search)
  created_at: string;
  updated_at: string;
}

export interface CreatePromotionParams {
  resourceUrl: string;
  agentId?: string;
  promotedByWallet: string;
  days: number; // Number of days to promote
  paymentTxHash: string;
  resourceType?: 'bazaar' | 'agent';
}

export interface GetActivePromotionsParams {
  resourceType?: string;
  keyword?: string | string[]; // Support both single keyword and multiple keywords (AND logic)
  resourceUrl?: string;
  agentId?: string;
}

export interface PromotionAnalytics {
  promotion_id: string;
  clicks: number;
  impressions: number;
  ctr: number; // Click-through rate (clicks / impressions)
  payments_received: number;
  payment_volume: string; // Total payment amount received
  conversion_rate: number; // Payments / clicks
  top_keywords: Array<{ keyword: string; count: number }>;
}

