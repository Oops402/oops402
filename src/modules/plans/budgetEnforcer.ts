/**
 * Budget Enforcement Logic
 * Validates budget constraints for plan receipts
 */

import type { Plan, ReceiptInput, BudgetLimits, ToolPolicy } from './types.js';
import {
  BudgetExceededError,
  ToolNotAllowedError,
  ApprovalRequiredError,
  StepNotFoundError,
} from './errors.js';
import { logger } from '../shared/logger.js';

/**
 * Validate all budget rules for a receipt
 */
export function validateBudgetRules(plan: Plan, receipt: ReceiptInput): void {
  // Check tool allowlist
  matchToolAllowlist(plan.spec.tool_policy, receipt.tool.url);

  // Find the step to get step-specific limits
  const step = plan.spec.steps.find((s) => s.id === receipt.step_id);
  if (!step) {
    throw new StepNotFoundError(plan.id, receipt.step_id);
  }

  // Check per-step cap
  checkPerRequestLimit(plan.spec.budget, step, receipt);

  // Check per-tool cap
  checkPerToolLimit(plan.spec.budget, receipt);

  // Check total budget
  checkTotalBudget(plan, receipt);

  // Check approval threshold
  checkApprovalThreshold(plan.spec.budget, receipt);
}

/**
 * Check if tool URL matches allowlist patterns
 */
export function matchToolAllowlist(toolPolicy: ToolPolicy, toolUrl: string): void {
  if (!toolPolicy.require_allowlist) {
    return; // Allowlist not required
  }

  // Check denylist first
  if (toolPolicy.denylist) {
    for (const pattern of toolPolicy.denylist) {
      if (matchesPattern(toolUrl, pattern)) {
        throw new ToolNotAllowedError('', toolUrl); // planId will be set by caller
      }
    }
  }

  // Check allowlist
  for (const pattern of toolPolicy.allowlist) {
    if (matchesPattern(toolUrl, pattern)) {
      return; // Matched, allowed
    }
  }

  // No match found in allowlist
  throw new ToolNotAllowedError('', toolUrl); // planId will be set by caller
}

/**
 * Check per-step cost limit
 */
export function checkPerRequestLimit(
  budget: BudgetLimits,
  step: { max_cost_usdc?: string },
  receipt: ReceiptInput
): void {
  const receiptAmount = parseFloat(receipt.cost.amount);
  if (isNaN(receiptAmount)) {
    throw new Error(`Invalid receipt amount: ${receipt.cost.amount}`);
  }

  // Check step-specific max cost first
  if (step.max_cost_usdc) {
    const stepMax = parseFloat(step.max_cost_usdc);
    if (receiptAmount > stepMax) {
      throw new BudgetExceededError('', receipt.cost.amount, '0', step.max_cost_usdc);
    }
  }

  // Check default per-step cap
  if (budget.per_step_default_cap_usdc) {
    const defaultCap = parseFloat(budget.per_step_default_cap_usdc);
    if (receiptAmount > defaultCap) {
      throw new BudgetExceededError('', receipt.cost.amount, '0', budget.per_step_default_cap_usdc);
    }
  }
}

/**
 * Check per-tool cost limit
 */
export function checkPerToolLimit(budget: BudgetLimits, receipt: ReceiptInput): void {
  if (!budget.per_tool_caps_usdc) {
    return; // No per-tool caps configured
  }

  const receiptAmount = parseFloat(receipt.cost.amount);
  if (isNaN(receiptAmount)) {
    throw new Error(`Invalid receipt amount: ${receipt.cost.amount}`);
  }

  // Check each tool cap pattern
  for (const [pattern, capStr] of Object.entries(budget.per_tool_caps_usdc)) {
    if (matchesPattern(receipt.tool.url, pattern)) {
      const cap = parseFloat(capStr);
      if (receiptAmount > cap) {
        throw new BudgetExceededError('', receipt.cost.amount, '0', capStr);
      }
      return; // Matched pattern, checked
    }
  }
}

/**
 * Check total budget limit
 */
export function checkTotalBudget(plan: Plan, receipt: ReceiptInput): void {
  const receiptAmount = parseFloat(receipt.cost.amount);
  if (isNaN(receiptAmount)) {
    throw new Error(`Invalid receipt amount: ${receipt.cost.amount}`);
  }

  const currentTotal = parseFloat(plan.execution.spend.total_usdc || '0');
  const budgetLimit = parseFloat(plan.spec.budget.not_to_exceed_usdc);

  if (currentTotal + receiptAmount > budgetLimit) {
    throw new BudgetExceededError(
      plan.id,
      receipt.cost.amount,
      plan.execution.spend.total_usdc,
      plan.spec.budget.not_to_exceed_usdc
    );
  }
}

/**
 * Check approval threshold
 */
export function checkApprovalThreshold(budget: BudgetLimits, receipt: ReceiptInput): void {
  if (!budget.approval_threshold_usdc) {
    return; // No approval threshold configured
  }

  const receiptAmount = parseFloat(receipt.cost.amount);
  if (isNaN(receiptAmount)) {
    throw new Error(`Invalid receipt amount: ${receipt.cost.amount}`);
  }

  const threshold = parseFloat(budget.approval_threshold_usdc);
  if (receiptAmount > threshold) {
    throw new ApprovalRequiredError('', receipt.step_id, receipt.cost.amount, budget.approval_threshold_usdc);
  }
}

/**
 * Match URL against pattern (supports wildcards)
 * Examples:
 * - "https://api.example.com/*" matches "https://api.example.com/v1/endpoint"
 * - "https://api.example.com/v1/*" matches "https://api.example.com/v1/endpoint"
 * - "https://api.example.com" matches "https://api.example.com" exactly
 */
function matchesPattern(url: string, pattern: string): boolean {
  // Exact match
  if (url === pattern) {
    return true;
  }

  // Wildcard pattern
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return url.startsWith(prefix);
  }

  // No match
  return false;
}
