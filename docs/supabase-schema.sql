-- x402 Promotion & Analytics System Schema
-- All tables use oops402_ prefix to avoid conflicts with existing tables
--
-- Migration note: If upgrading an existing database, run:
--   ALTER TABLE oops402_promotions ADD COLUMN IF NOT EXISTS description TEXT;
--   CREATE INDEX IF NOT EXISTS idx_promotions_description ON oops402_promotions(description) WHERE description IS NOT NULL;
--   -- For bazaar resources migration:
--   -- See oops402_bazaar_resources table definition below

-- Promotions table - stores active and inactive promotions
CREATE TABLE IF NOT EXISTS oops402_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_url TEXT NOT NULL,
  agent_id TEXT, -- For ERC8004 agent promotions (nullable)
  promoted_by_wallet TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'inactive', 'expired'
  start_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_date TIMESTAMPTZ, -- Nullable for indefinite promotions
  payment_amount TEXT NOT NULL, -- Payment amount for promotion (as string to handle large numbers)
  payment_tx_hash TEXT NOT NULL, -- Transaction hash of promotion payment
  resource_type TEXT, -- 'bazaar' or 'agent'
  description TEXT, -- Description extracted from x402 schema accepts (for keyword search)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- Note: Unique constraints with WHERE clauses are created as partial unique indexes below
);

-- Payments table - tracks ALL payments processed through the system
CREATE TABLE IF NOT EXISTS oops402_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_wallet TEXT NOT NULL,
  resource_url TEXT NOT NULL,
  amount TEXT NOT NULL, -- Amount as string to handle large numbers
  tx_hash TEXT NOT NULL UNIQUE,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Promotion payments link table - links payments to promotions for promotion-specific analytics
CREATE TABLE IF NOT EXISTS oops402_promotion_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES oops402_promotions(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES oops402_payments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_promotion_payment UNIQUE (promotion_id, payment_id)
);

-- Search analytics table - tracks search queries
CREATE TABLE IF NOT EXISTS oops402_search_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id_hash TEXT NOT NULL, -- Hashed session ID for privacy
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Click analytics table - tracks clicks on promoted results
CREATE TABLE IF NOT EXISTS oops402_click_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES oops402_promotions(id) ON DELETE CASCADE,
  resource_url TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id_hash TEXT NOT NULL, -- Hashed session ID for privacy
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Promotion impressions table - tracks when promoted results are shown in search
CREATE TABLE IF NOT EXISTS oops402_promotion_impressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES oops402_promotions(id) ON DELETE CASCADE,
  search_keyword TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id_hash TEXT NOT NULL, -- Hashed session ID for privacy
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance

-- Promotions indexes
CREATE INDEX IF NOT EXISTS idx_promotions_resource_url ON oops402_promotions(resource_url);
CREATE INDEX IF NOT EXISTS idx_promotions_agent_id ON oops402_promotions(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_promotions_status ON oops402_promotions(status);
CREATE INDEX IF NOT EXISTS idx_promotions_active ON oops402_promotions(status, start_date, end_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_promotions_wallet ON oops402_promotions(promoted_by_wallet);
CREATE INDEX IF NOT EXISTS idx_promotions_description ON oops402_promotions(description) WHERE description IS NOT NULL;

-- Enforce "only one active promotion per resource_url" using partial unique index
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_promotion
  ON oops402_promotions (resource_url)
  WHERE status = 'active';

-- Enforce "only one active promotion per agent_id when agent_id is not null" using partial unique index
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_agent_promotion
  ON oops402_promotions (agent_id)
  WHERE status = 'active' AND agent_id IS NOT NULL;

-- Payments indexes
CREATE INDEX IF NOT EXISTS idx_payments_resource_url ON oops402_payments(resource_url);
CREATE INDEX IF NOT EXISTS idx_payments_payer_wallet ON oops402_payments(payer_wallet);
CREATE INDEX IF NOT EXISTS idx_payments_timestamp ON oops402_payments(timestamp);
CREATE INDEX IF NOT EXISTS idx_payments_tx_hash ON oops402_payments(tx_hash);

-- Promotion payments indexes
CREATE INDEX IF NOT EXISTS idx_promotion_payments_promotion_id ON oops402_promotion_payments(promotion_id);
CREATE INDEX IF NOT EXISTS idx_promotion_payments_payment_id ON oops402_promotion_payments(payment_id);

-- Search analytics indexes
CREATE INDEX IF NOT EXISTS idx_search_analytics_keyword ON oops402_search_analytics(keyword);
CREATE INDEX IF NOT EXISTS idx_search_analytics_timestamp ON oops402_search_analytics(timestamp);

-- Click analytics indexes
CREATE INDEX IF NOT EXISTS idx_click_analytics_promotion_id ON oops402_click_analytics(promotion_id);
CREATE INDEX IF NOT EXISTS idx_click_analytics_timestamp ON oops402_click_analytics(timestamp);

-- Impression analytics indexes
CREATE INDEX IF NOT EXISTS idx_promotion_impressions_promotion_id ON oops402_promotion_impressions(promotion_id);
CREATE INDEX IF NOT EXISTS idx_promotion_impressions_timestamp ON oops402_promotion_impressions(timestamp);

-- Updated at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for updated_at on promotions
CREATE TRIGGER update_promotions_updated_at BEFORE UPDATE ON oops402_promotions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- User preferences table - stores user preferences for budget limits and discovery filters
CREATE TABLE IF NOT EXISTS oops402_user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE, -- Auth0 user ID (sub claim)
  per_request_max_atomic TEXT, -- Max per request in atomic units (nullable)
  session_budget_atomic TEXT, -- Session budget in atomic units (nullable)
  only_promoted BOOLEAN NOT NULL DEFAULT false, -- Only show promoted resources/agents
  min_agent_score NUMERIC(5,2), -- Minimum average score for agents (0-100, nullable)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON oops402_user_preferences(user_id);

-- Trigger for updated_at on user preferences
CREATE TRIGGER update_user_preferences_updated_at BEFORE UPDATE ON oops402_user_preferences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Bazaar resources table - stores all x402-protected resources (both crawled from bazaar and manually promoted)
CREATE TABLE IF NOT EXISTS oops402_bazaar_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_url TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL, -- 'http', 'mcp', etc.
  accepts JSONB NOT NULL, -- Full accepts array with all payment options
  last_updated TIMESTAMPTZ NOT NULL,
  x402_version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'bazaar', -- 'bazaar' (crawled) or 'promotion' (manually added)
  promotion_id UUID REFERENCES oops402_promotions(id) ON DELETE SET NULL, -- Link to promotion if manually added
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_bazaar_resources_resource_url ON oops402_bazaar_resources(resource_url);
CREATE INDEX IF NOT EXISTS idx_bazaar_resources_type ON oops402_bazaar_resources(type);
CREATE INDEX IF NOT EXISTS idx_bazaar_resources_source ON oops402_bazaar_resources(source);
CREATE INDEX IF NOT EXISTS idx_bazaar_resources_promotion_id ON oops402_bazaar_resources(promotion_id) WHERE promotion_id IS NOT NULL;

-- Full-text search on accepts descriptions (for keyword search)
CREATE INDEX IF NOT EXISTS idx_bazaar_resources_accepts_gin ON oops402_bazaar_resources USING gin(accepts jsonb_path_ops);

-- Trigger for updated_at on bazaar resources
CREATE TRIGGER update_bazaar_resources_updated_at BEFORE UPDATE ON oops402_bazaar_resources
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

