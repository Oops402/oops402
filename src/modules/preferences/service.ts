/**
 * Preferences Service
 * Handles user preferences CRUD operations (Supabase) and session spending tracking (Redis)
 */

import { getSupabaseClient } from '../shared/supabase.js';
import { redisClient } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import type {
  UserPreferences,
  UserPreferencesInput,
  BudgetLimits,
  DiscoveryFilters,
} from './types.js';

const supabase = getSupabaseClient();

/**
 * Get user preferences from Supabase
 */
export async function getUserPreferences(userId: string): Promise<UserPreferences | null> {
  try {
    const { data, error } = await supabase
      .from('oops402_user_preferences')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // Not found - return null (user hasn't set preferences yet)
        return null;
      }
      throw error;
    }

    return data as UserPreferences;
  } catch (error) {
    logger.error('Failed to get user preferences', error as Error, { userId });
    throw new Error(`Failed to get user preferences: ${(error as Error).message}`);
  }
}

/**
 * Set user preferences in Supabase (upsert)
 */
export async function setUserPreferences(
  userId: string,
  preferences: UserPreferencesInput
): Promise<UserPreferences> {
  try {
    // Convert input format to database format
    const dbPreferences: any = {};
    if (preferences.perRequestMaxAtomic !== undefined) {
      dbPreferences.per_request_max_atomic = preferences.perRequestMaxAtomic;
    }
    if (preferences.sessionBudgetAtomic !== undefined) {
      dbPreferences.session_budget_atomic = preferences.sessionBudgetAtomic;
    }
    if (preferences.onlyPromoted !== undefined) {
      dbPreferences.only_promoted = preferences.onlyPromoted;
    }
    if (preferences.minAgentScore !== undefined) {
      dbPreferences.min_agent_score = preferences.minAgentScore;
    }

    const { data, error } = await supabase
      .from('oops402_user_preferences')
      .upsert(
        {
          user_id: userId,
          ...dbPreferences,
        },
        {
          onConflict: 'user_id',
        }
      )
      .select()
      .single();

    if (error) throw error;

    logger.info('User preferences updated', { userId, preferences: dbPreferences });
    return data as UserPreferences;
  } catch (error) {
    logger.error('Failed to set user preferences', error as Error, { userId, preferences });
    throw new Error(`Failed to set user preferences: ${(error as Error).message}`);
  }
}

/**
 * Get budget limits for a user
 */
export async function getBudgetLimits(userId: string): Promise<BudgetLimits> {
  const preferences = await getUserPreferences(userId);
  return {
    perRequestMaxAtomic: preferences?.per_request_max_atomic ?? null,
    sessionBudgetAtomic: preferences?.session_budget_atomic ?? null,
  };
}

/**
 * Get discovery filters for a user
 */
export async function getDiscoveryFilters(userId: string): Promise<DiscoveryFilters> {
  const preferences = await getUserPreferences(userId);
  return {
    onlyPromoted: preferences?.only_promoted ?? false,
    minAgentScore: preferences?.min_agent_score ?? null,
  };
}

/**
 * Get session spending from Redis
 */
export async function getSessionSpent(sessionId: string): Promise<string> {
  try {
    const spent = await redisClient.get(`session:${sessionId}:spent`);
    return spent || '0';
  } catch (error) {
    logger.error('Failed to get session spent', error as Error, { sessionId });
    return '0'; // Return 0 on error to avoid blocking
  }
}

/**
 * Add to session spending in Redis
 */
export async function addSessionSpent(sessionId: string, amountAtomic: string): Promise<void> {
  try {
    const current = await getSessionSpent(sessionId);
    const currentBigInt = BigInt(current);
    const amountBigInt = BigInt(amountAtomic);
    const updated = (currentBigInt + amountBigInt).toString();

    // Store with same expiry as session (7 days default, or use existing TTL)
    await redisClient.set(`session:${sessionId}:spent`, updated);
    
    logger.debug('Session spending updated', { sessionId, amountAtomic, updated });
  } catch (error) {
    logger.error('Failed to add session spent', error as Error, { sessionId, amountAtomic });
    throw new Error(`Failed to add session spent: ${(error as Error).message}`);
  }
}

/**
 * Reset session spending to 0
 */
export async function resetSessionSpent(sessionId: string): Promise<void> {
  try {
    await redisClient.set(`session:${sessionId}:spent`, '0');
    logger.debug('Session spending reset', { sessionId });
  } catch (error) {
    logger.error('Failed to reset session spent', error as Error, { sessionId });
    throw new Error(`Failed to reset session spent: ${(error as Error).message}`);
  }
}

/**
 * Calculate remaining budget for a session
 */
export async function getRemainingBudget(
  userId: string,
  sessionId: string
): Promise<string | null> {
  try {
    const budgetLimits = await getBudgetLimits(userId);
    if (!budgetLimits.sessionBudgetAtomic) {
      return null; // No budget limit set
    }

    const sessionSpent = await getSessionSpent(sessionId);
    const budgetBigInt = BigInt(budgetLimits.sessionBudgetAtomic);
    const spentBigInt = BigInt(sessionSpent);
    const remaining = budgetBigInt - spentBigInt;

    return remaining >= 0n ? remaining.toString() : '0';
  } catch (error) {
    logger.error('Failed to calculate remaining budget', error as Error, { userId, sessionId });
    return null;
  }
}

