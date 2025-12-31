/**
 * User Preferences Types
 */

export interface UserPreferences {
  id: string;
  user_id: string;
  per_request_max_atomic: string | null;
  session_budget_atomic: string | null;
  only_promoted: boolean;
  min_agent_score: number | null;
  created_at: string;
  updated_at: string;
}

export interface UserPreferencesInput {
  perRequestMaxAtomic?: string | null;
  sessionBudgetAtomic?: string | null;
  onlyPromoted?: boolean;
  minAgentScore?: number | null;
}

export interface BudgetLimits {
  perRequestMaxAtomic: string | null;
  sessionBudgetAtomic: string | null;
}

export interface DiscoveryFilters {
  onlyPromoted: boolean;
  minAgentScore: number | null;
}

