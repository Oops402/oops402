/**
 * Plan Service
 * Handles CRUD operations for plans, approval, state transitions, and plan hashing
 */

import { getSupabaseClient } from '../shared/supabase.js';
import { logger } from '../shared/logger.js';
import type {
  Plan,
  PlanInput,
  PlanUpdate,
  PlanFilters,
  PlanListResponse,
  PlanStatus,
  PlanExecution,
  PlanIntegrity,
} from './types.js';
import {
  PlanNotFoundError,
  PlanLockedError,
  InvalidTransitionError,
} from './errors.js';

// Re-export for convenience
export { PlanNotFoundError } from './errors.js';
import crypto from 'node:crypto';

const supabase = getSupabaseClient();

/**
 * Create a new draft plan
 */
export async function createPlan(userId: string, planInput: PlanInput): Promise<Plan> {
  try {
    const execution: PlanExecution = {
      active_step_id: null,
      progress: {
        completed_steps: [],
        failed_steps: [],
      },
      spend: {
        total_usdc: '0.00',
        remaining_usdc: planInput.budget.not_to_exceed_usdc,
      },
    };

    const integrity: PlanIntegrity = {
      plan_hash: null,
      approved_at: null,
      approved_by: null,
    };

    const { data, error } = await supabase
      .from('oops402_plans')
      .insert({
        owner_id: userId,
        workspace_id: planInput.workspace_id || null,
        title: planInput.title,
        objective: planInput.objective,
        status: 'draft',
        spec: {
          scope: planInput.scope || {},
          steps: planInput.steps,
          tool_policy: planInput.tool_policy,
          budget: planInput.budget,
        },
        plan_hash: null,
        execution,
        integrity,
        tags: planInput.tags || [],
        metadata: planInput.metadata || {},
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to create plan', error as Error, { userId });
      throw new Error(`Failed to create plan: ${error.message}`);
    }

    return mapDbPlanToPlan(data);
  } catch (error) {
    logger.error('Error creating plan', error as Error, { userId });
    throw error;
  }
}

/**
 * Get plan by ID with access control
 */
export async function getPlan(planId: string, userId: string): Promise<Plan> {
  try {
    const { data, error } = await supabase
      .from('oops402_plans')
      .select('*')
      .eq('id', planId)
      .eq('owner_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new PlanNotFoundError(planId);
      }
      logger.error('Failed to get plan', error as Error, { planId, userId });
      throw new Error(`Failed to get plan: ${error.message}`);
    }

    return mapDbPlanToPlan(data);
  } catch (error) {
    if (error instanceof PlanNotFoundError) {
      throw error;
    }
    logger.error('Error getting plan', error as Error, { planId, userId });
    throw error;
  }
}

/**
 * List plans with filtering
 */
export async function listPlans(
  userId: string,
  filters: PlanFilters = {}
): Promise<PlanListResponse> {
  try {
    let query = supabase.from('oops402_plans').select('*', { count: 'exact' }).eq('owner_id', userId);

    // Filter by status
    if (filters.status) {
      if (Array.isArray(filters.status)) {
        query = query.in('status', filters.status);
      } else {
        query = query.eq('status', filters.status);
      }
    }

    // Filter by workspace
    if (filters.workspace_id) {
      query = query.eq('workspace_id', filters.workspace_id);
    }

    // Filter by tags (if any tag matches)
    if (filters.tags && filters.tags.length > 0) {
      query = query.contains('tags', filters.tags);
    }

    // Sorting
    if (filters.sort && filters.sort.length > 0) {
      for (const sort of filters.sort) {
        query = query.order(sort.field, { ascending: sort.direction === 'asc' });
      }
    } else {
      // Default: newest first
      query = query.order('created_at', { ascending: false });
    }

    // Pagination
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      logger.error('Failed to list plans', error as Error, { userId });
      throw new Error(`Failed to list plans: ${error.message}`);
    }

    return {
      plans: (data || []).map(mapDbPlanToPlan),
      total: count || 0,
      limit,
      offset,
    };
  } catch (error) {
    logger.error('Error listing plans', error as Error, { userId });
    throw error;
  }
}

/**
 * Update plan (only allowed when status is draft)
 */
export async function updatePlan(
  planId: string,
  userId: string,
  updates: PlanUpdate
): Promise<Plan> {
  try {
    // First, get the plan to check status
    const plan = await getPlan(planId, userId);

    if (plan.status !== 'draft') {
      throw new PlanLockedError(planId, plan.status);
    }

    // Build update object
    const updateData: Record<string, unknown> = {};

    if (updates.title !== undefined) updateData.title = updates.title;
    if (updates.objective !== undefined) updateData.objective = updates.objective;
    if (updates.scope !== undefined) {
      updateData.spec = {
        ...plan.spec,
        scope: updates.scope,
      };
    }
    if (updates.steps !== undefined) {
      updateData.spec = {
        ...plan.spec,
        steps: updates.steps,
      };
    }
    if (updates.tool_policy !== undefined) {
      updateData.spec = {
        ...plan.spec,
        tool_policy: updates.tool_policy,
      };
    }
    if (updates.budget !== undefined) {
      updateData.spec = {
        ...plan.spec,
        budget: updates.budget,
      };
      // Update remaining budget
      const execution = { ...plan.execution };
      execution.spend.remaining_usdc = updates.budget.not_to_exceed_usdc;
      updateData.execution = execution;
    }
    if (updates.tags !== undefined) updateData.tags = updates.tags;
    if (updates.metadata !== undefined) updateData.metadata = updates.metadata;

    const { data, error } = await supabase
      .from('oops402_plans')
      .update(updateData)
      .eq('id', planId)
      .eq('owner_id', userId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to update plan', error as Error, { planId, userId });
      throw new Error(`Failed to update plan: ${error.message}`);
    }

    return mapDbPlanToPlan(data);
  } catch (error) {
    if (error instanceof PlanLockedError || error instanceof PlanNotFoundError) {
      throw error;
    }
    logger.error('Error updating plan', error as Error, { planId, userId });
    throw error;
  }
}

/**
 * Approve and start plan (combined operation)
 */
export async function approveAndStartPlan(planId: string, userId: string): Promise<Plan> {
  try {
    const plan = await getPlan(planId, userId);

    // Natural idempotency: if already approved/running, return existing plan
    if (plan.status === 'approved' || plan.status === 'running') {
      return plan;
    }

    // Validate transition
    if (plan.status !== 'draft') {
      throw new InvalidTransitionError(planId, plan.status, 'running');
    }

    // Compute plan hash
    const planHash = computePlanHash(plan);

    // Update plan: approve and start
    const integrity: PlanIntegrity = {
      plan_hash: planHash,
      approved_at: new Date().toISOString(),
      approved_by: userId,
    };

    const execution: PlanExecution = {
      ...plan.execution,
      active_step_id: plan.spec.steps.length > 0 ? plan.spec.steps[0].id : null,
    };

    const { data, error } = await supabase
      .from('oops402_plans')
      .update({
        status: 'running',
        plan_hash: planHash,
        integrity,
        execution,
      })
      .eq('id', planId)
      .eq('owner_id', userId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to approve and start plan', error as Error, { planId, userId });
      throw new Error(`Failed to approve and start plan: ${error.message}`);
    }

    return mapDbPlanToPlan(data);
  } catch (error) {
    if (
      error instanceof PlanNotFoundError ||
      error instanceof InvalidTransitionError
    ) {
      throw error;
    }
    logger.error('Error approving and starting plan', error as Error, { planId, userId });
    throw error;
  }
}

/**
 * Cancel plan
 */
export async function cancelPlan(planId: string, userId: string): Promise<Plan> {
  try {
    const plan = await getPlan(planId, userId);

    // Validate transition
    const allowedStatuses: PlanStatus[] = ['approved', 'running', 'paused'];
    if (!allowedStatuses.includes(plan.status)) {
      throw new InvalidTransitionError(planId, plan.status, 'canceled');
    }

    // Natural idempotency: if already canceled, return existing plan
    if (plan.status === 'canceled') {
      return plan;
    }

    const { data, error } = await supabase
      .from('oops402_plans')
      .update({
        status: 'canceled',
      })
      .eq('id', planId)
      .eq('owner_id', userId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to cancel plan', error as Error, { planId, userId });
      throw new Error(`Failed to cancel plan: ${error.message}`);
    }

    return mapDbPlanToPlan(data);
  } catch (error) {
    if (
      error instanceof PlanNotFoundError ||
      error instanceof InvalidTransitionError
    ) {
      throw error;
    }
    logger.error('Error canceling plan', error as Error, { planId, userId });
    throw error;
  }
}

/**
 * Auto-complete plan when all steps have receipts
 */
export async function autoCompletePlan(planId: string): Promise<Plan | null> {
  try {
    const { data: planData, error: planError } = await supabase
      .from('oops402_plans')
      .select('*')
      .eq('id', planId)
      .single();

    if (planError || !planData) {
      logger.error('Plan not found for auto-completion', planError as Error, { planId });
      return null;
    }

    const plan = mapDbPlanToPlan(planData);

    // Only auto-complete if plan is running or paused
    if (plan.status !== 'running' && plan.status !== 'paused') {
      return null;
    }

    // Get all receipts for this plan
    const { data: receipts, error: receiptsError } = await supabase
      .from('oops402_plan_receipts')
      .select('step_id')
      .eq('plan_id', planId);

    if (receiptsError) {
      logger.error('Failed to get receipts for auto-completion', receiptsError as Error, { planId });
      return null;
    }

    // Get unique step IDs from receipts
    const receiptStepIds = new Set((receipts || []).map((r) => r.step_id));

    // Check if all plan steps have at least one receipt
    const allStepsHaveReceipts = plan.spec.steps.every((step) => receiptStepIds.has(step.id));

    if (allStepsHaveReceipts) {
      // Update plan status to completed
      const { data, error } = await supabase
        .from('oops402_plans')
        .update({
          status: 'completed',
        })
        .eq('id', planId)
        .select()
        .single();

      if (error) {
        logger.error('Failed to auto-complete plan', error as Error, { planId });
        return null;
      }

      return mapDbPlanToPlan(data);
    }

    return null;
  } catch (error) {
    logger.error('Error auto-completing plan', error as Error, { planId });
    return null;
  }
}

/**
 * Calculate current spend from receipts
 */
export async function getPlanSpend(planId: string): Promise<string> {
  try {
    const { data, error } = await supabase
      .from('oops402_plan_receipts')
      .select('cost')
      .eq('plan_id', planId);

    if (error) {
      logger.error('Failed to get plan spend', error as Error, { planId });
      throw new Error(`Failed to get plan spend: ${error.message}`);
    }

    let total = 0;
    for (const receipt of data || []) {
      const amount = parseFloat(receipt.cost.amount || '0');
      if (!isNaN(amount)) {
        total += amount;
      }
    }

    return total.toFixed(6); // USDC has 6 decimals
  } catch (error) {
    logger.error('Error calculating plan spend', error as Error, { planId });
    throw error;
  }
}

/**
 * Canonicalize plan JSON for hashing
 */
export function canonicalizePlan(plan: Plan): string {
  // Create a copy without mutable fields
  const canonical = {
    title: plan.title,
    objective: plan.objective,
    spec: plan.spec,
    tags: plan.tags.sort(), // Sort tags for consistency
    metadata: plan.metadata,
  };

  // Convert to JSON with sorted keys
  return JSON.stringify(canonical, Object.keys(canonical).sort());
}

/**
 * Compute SHA256 hash of canonicalized plan
 */
export function computePlanHash(plan: Plan): string {
  const canonical = canonicalizePlan(plan);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Map database plan to Plan type
 */
function mapDbPlanToPlan(dbPlan: any): Plan {
  return {
    id: dbPlan.id,
    owner_id: dbPlan.owner_id,
    workspace_id: dbPlan.workspace_id || undefined,
    title: dbPlan.title,
    objective: dbPlan.objective,
    status: dbPlan.status as PlanStatus,
    spec: dbPlan.spec,
    plan_hash: dbPlan.plan_hash,
    execution: dbPlan.execution,
    integrity: dbPlan.integrity,
    tags: dbPlan.tags || [],
    metadata: dbPlan.metadata || {},
    created_at: dbPlan.created_at,
    updated_at: dbPlan.updated_at,
  };
}
