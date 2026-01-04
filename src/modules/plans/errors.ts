/**
 * Plan + Execution API Error Classes
 */

export class PlanError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class PlanNotFoundError extends PlanError {
  constructor(planId: string) {
    super(`Plan not found: ${planId}`, 'PlanNotFound', 404, { planId });
  }
}

export class PlanLockedError extends PlanError {
  constructor(planId: string, currentStatus: string) {
    super(
      `Plan is locked and cannot be modified. Current status: ${currentStatus}`,
      'PlanLocked',
      409,
      { planId, currentStatus }
    );
  }
}

export class InvalidTransitionError extends PlanError {
  constructor(planId: string, fromStatus: string, toStatus: string) {
    super(
      `Invalid status transition from ${fromStatus} to ${toStatus}`,
      'InvalidTransition',
      409,
      { planId, fromStatus, toStatus }
    );
  }
}

export class BudgetExceededError extends PlanError {
  constructor(
    planId: string,
    attemptedAmount: string,
    currentTotal: string,
    budgetLimit: string
  ) {
    super(
      `Receipt would exceed plan budget. Attempted: ${attemptedAmount}, Current: ${currentTotal}, Limit: ${budgetLimit}`,
      'BudgetExceeded',
      402,
      {
        planId,
        attemptedAmount,
        currentTotal,
        budgetLimit,
      }
    );
  }
}

export class ToolNotAllowedError extends PlanError {
  constructor(planId: string, toolUrl: string) {
    super(
      `Tool URL is not in allowlist: ${toolUrl}`,
      'ToolNotAllowed',
      403,
      { planId, toolUrl }
    );
  }
}

export class ApprovalRequiredError extends PlanError {
  constructor(planId: string, stepId: string, amount: string, threshold: string) {
    super(
      `Step cost exceeds approval threshold. Amount: ${amount}, Threshold: ${threshold}`,
      'ApprovalRequired',
      409,
      { planId, stepId, amount, threshold }
    );
  }
}

export class StepNotFoundError extends PlanError {
  constructor(planId: string, stepId: string) {
    super(`Step not found in plan: ${stepId}`, 'StepNotFound', 400, { planId, stepId });
  }
}

export class InvalidSchemaError extends PlanError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(`Invalid plan schema: ${message}`, 'InvalidSchema', 400, details);
  }
}
