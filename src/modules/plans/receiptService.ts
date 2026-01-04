/**
 * Receipt Service
 * Handles receipt creation with budget validation and auto-completion checking
 */

import { getSupabaseClient } from '../shared/supabase.js';
import { logger } from '../shared/logger.js';
import type { Receipt, ReceiptInput } from './types.js';
import { getPlan } from './service.js';
import { validateBudgetRules } from './budgetEnforcer.js';
import { autoCompletePlan } from './service.js';
import { PlanNotFoundError } from './errors.js';

const supabase = getSupabaseClient();

/**
 * Create receipt with budget validation
 * Includes natural idempotency check and auto-completion
 */
export async function createReceipt(
  planId: string,
  userId: string,
  receiptInput: ReceiptInput
): Promise<Receipt> {
  try {
    // Get plan to validate budget
    const plan = await getPlan(planId, userId);

    // Check for existing receipt (natural idempotency)
    if (receiptInput.x402?.payment_reference) {
      const existing = await getReceiptByPaymentReference(
        planId,
        receiptInput.step_id,
        receiptInput.x402.payment_reference
      );
      if (existing) {
        logger.debug('Receipt already exists, returning existing receipt', {
          planId,
          stepId: receiptInput.step_id,
          paymentReference: receiptInput.x402.payment_reference,
        });
        return existing;
      }
    }

    // Validate budget rules
    validateBudgetRules(plan, receiptInput);

    // Calculate new total spend
    const currentSpend = parseFloat(plan.execution.spend.total_usdc || '0');
    const receiptAmount = parseFloat(receiptInput.cost.amount);
    const newTotal = (currentSpend + receiptAmount).toFixed(6);
    const budgetLimit = parseFloat(plan.spec.budget.not_to_exceed_usdc);
    const remaining = (budgetLimit - parseFloat(newTotal)).toFixed(6);

    // Create receipt
    const { data, error } = await supabase
      .from('oops402_plan_receipts')
      .insert({
        plan_id: planId,
        step_id: receiptInput.step_id,
        tool: receiptInput.tool,
        cost: receiptInput.cost,
        x402: receiptInput.x402 || {},
        output: receiptInput.output || null,
        notes: receiptInput.notes || null,
      })
      .select()
      .single();

    if (error) {
      // Check if it's a unique constraint violation (duplicate)
      if (error.code === '23505') {
        // Try to get the existing receipt
        if (receiptInput.x402?.payment_reference) {
          const existing = await getReceiptByPaymentReference(
            planId,
            receiptInput.step_id,
            receiptInput.x402.payment_reference
          );
          if (existing) {
            return existing;
          }
        }
      }
      logger.error('Failed to create receipt', error as Error, { planId, userId });
      throw new Error(`Failed to create receipt: ${error.message}`);
    }

    // Update plan spend
    await updatePlanSpend(planId, newTotal, remaining);

    // Check for auto-completion
    await checkPlanCompletion(planId);

    return mapDbReceiptToReceipt(data);
  } catch (error) {
    if (error instanceof PlanNotFoundError) {
      throw error;
    }
    logger.error('Error creating receipt', error as Error, { planId, userId });
    throw error;
  }
}

/**
 * Get receipts for a plan
 */
export async function getReceipts(
  planId: string,
  userId: string,
  pagination?: { limit?: number; offset?: number }
): Promise<Receipt[]> {
  try {
    // Verify plan exists and user has access
    await getPlan(planId, userId);

    let query = supabase
      .from('oops402_plan_receipts')
      .select('*')
      .eq('plan_id', planId)
      .order('created_at', { ascending: true });

    if (pagination) {
      const limit = pagination.limit || 50;
      const offset = pagination.offset || 0;
      query = query.range(offset, offset + limit - 1);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to get receipts', error as Error, { planId, userId });
      throw new Error(`Failed to get receipts: ${error.message}`);
    }

    return (data || []).map(mapDbReceiptToReceipt);
  } catch (error) {
    if (error instanceof PlanNotFoundError) {
      throw error;
    }
    logger.error('Error getting receipts', error as Error, { planId, userId });
    throw error;
  }
}

/**
 * Check if plan should be auto-completed and complete it if so
 */
export async function checkPlanCompletion(planId: string): Promise<void> {
  try {
    await autoCompletePlan(planId);
  } catch (error) {
    // Log but don't throw - auto-completion is best effort
    logger.error('Error checking plan completion', error as Error, { planId });
  }
}

/**
 * Update plan spend totals
 */
async function updatePlanSpend(
  planId: string,
  totalUsdc: string,
  remainingUsdc: string
): Promise<void> {
  try {
    const { error } = await supabase
      .from('oops402_plans')
      .update({
        execution: {
          active_step_id: null, // Preserve existing, we'll update spend only
          progress: {
            completed_steps: [],
            failed_steps: [],
          },
          spend: {
            total_usdc: totalUsdc,
            remaining_usdc: remainingUsdc,
          },
        },
      })
      .eq('id', planId);

    if (error) {
      logger.error('Failed to update plan spend', error as Error, { planId });
      // Don't throw - this is a best-effort update
    }
  } catch (error) {
    logger.error('Error updating plan spend', error as Error, { planId });
    // Don't throw - this is a best-effort update
  }
}

/**
 * Get receipt by payment reference (for idempotency check)
 */
async function getReceiptByPaymentReference(
  planId: string,
  stepId: string,
  paymentReference: string
): Promise<Receipt | null> {
  try {
    const { data, error } = await supabase
      .from('oops402_plan_receipts')
      .select('*')
      .eq('plan_id', planId)
      .eq('step_id', stepId)
      .eq('x402->>payment_reference', paymentReference)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      throw error;
    }

    return mapDbReceiptToReceipt(data);
  } catch (error) {
    logger.error('Error getting receipt by payment reference', error as Error, {
      planId,
      stepId,
      paymentReference,
    });
    return null;
  }
}

/**
 * Map database receipt to Receipt type
 */
function mapDbReceiptToReceipt(dbReceipt: any): Receipt {
  return {
    id: dbReceipt.id,
    plan_id: dbReceipt.plan_id,
    step_id: dbReceipt.step_id,
    tool: dbReceipt.tool,
    cost: dbReceipt.cost,
    x402: dbReceipt.x402 || {},
    output: dbReceipt.output || undefined,
    notes: dbReceipt.notes || undefined,
    created_at: dbReceipt.created_at,
  };
}
