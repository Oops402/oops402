/**
 * Plan + Execution API Type Definitions
 */

export type PlanStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'canceled' | 'failed';

export interface PlanStep {
  id: string;
  title: string;
  tool: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    url: string;
  };
  inputs?: Record<string, unknown>;
  success_criteria?: string;
  estimated_cost_usdc?: string;
  max_cost_usdc?: string;
  fallback?: string;
  requires_evidence?: boolean;
}

export interface BudgetLimits {
  currency: string;
  not_to_exceed_usdc: string;
  approval_threshold_usdc?: string;
  per_tool_caps_usdc?: Record<string, string>;
  per_step_default_cap_usdc?: string;
}

export interface ToolPolicy {
  allowlist: string[];
  denylist?: string[];
  require_allowlist: boolean;
}

export interface PlanScope {
  assumptions?: string[];
  acceptance_criteria?: string[];
}

export interface PlanSpec {
  scope?: PlanScope;
  steps: PlanStep[];
  tool_policy: ToolPolicy;
  budget: BudgetLimits;
}

export interface PlanExecution {
  active_step_id: string | null;
  progress: {
    completed_steps: string[];
    failed_steps: string[];
  };
  spend: {
    total_usdc: string;
    remaining_usdc: string | null;
  };
}

export interface PlanIntegrity {
  plan_hash: string | null;
  approved_at: string | null;
  approved_by: string | null;
}

export interface Plan {
  id: string;
  owner_id: string;
  workspace_id?: string;
  title: string;
  objective: string;
  status: PlanStatus;
  spec: PlanSpec;
  plan_hash: string | null;
  execution: PlanExecution;
  integrity: PlanIntegrity;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PlanInput {
  title: string;
  objective: string;
  scope?: PlanScope;
  steps: PlanStep[];
  tool_policy: ToolPolicy;
  budget: BudgetLimits;
  tags?: string[];
  metadata?: Record<string, unknown>;
  workspace_id?: string;
}

export interface PlanUpdate {
  title?: string;
  objective?: string;
  scope?: PlanScope;
  steps?: PlanStep[];
  tool_policy?: ToolPolicy;
  budget?: BudgetLimits;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface Receipt {
  id: string;
  plan_id: string;
  step_id: string;
  tool: {
    method: string;
    url: string;
  };
  cost: {
    currency: string;
    amount: string;
  };
  x402: {
    payment_reference?: string;
    request_id?: string;
    response_status?: number;
  };
  output?: {
    type?: string;
    ref?: string;
    summary?: string;
    cid?: string | null;
  };
  notes?: string;
  created_at: string;
}

export interface ReceiptInput {
  step_id: string;
  tool: {
    method: string;
    url: string;
  };
  cost: {
    currency: string;
    amount: string;
  };
  x402: {
    payment_reference?: string;
    request_id?: string;
    response_status?: number;
  };
  output?: {
    type?: string;
    ref?: string;
    summary?: string;
    cid?: string | null;
  };
  notes?: string;
}

export interface Deliverable {
  id: string;
  plan_id: string;
  type: string;
  title: string;
  storage: {
    kind: 'ipfs';
    cid: string;
    gateway_url?: string | null;
  };
  evidence?: {
    screenshots?: Array<{
      cid: string;
      description?: string;
    }>;
    sources?: Array<{
      label: string;
      url: string;
    }>;
  };
  checksum?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DeliverableInput {
  type: string;
  title: string;
  storage: {
    kind: 'ipfs';
    cid: string;
    gateway_url?: string | null;
  };
  evidence?: {
    screenshots?: Array<{
      cid: string;
      description?: string;
    }>;
    sources?: Array<{
      label: string;
      url: string;
    }>;
  };
  checksum?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PlanFilters {
  status?: PlanStatus | PlanStatus[];
  tags?: string[];
  workspace_id?: string;
  limit?: number;
  offset?: number;
  sort?: Array<{
    field: 'created_at' | 'status' | 'title';
    direction: 'asc' | 'desc';
  }>;
}

export interface PlanListResponse {
  plans: Plan[];
  total: number;
  limit: number;
  offset: number;
}
