/**
 * PlanDetailsModal - Component for displaying detailed plan information
 */
import React, { useState, useEffect } from 'react';
import { styles } from '../styles';

interface Plan {
  id: string;
  title: string;
  objective: string;
  status: string;
  created_at: string;
  updated_at: string;
  spec: {
    scope?: {
      assumptions?: string[];
      acceptance_criteria?: string[];
    };
    steps: Array<{
      id: string;
      title: string;
      tool: {
        method: string;
        url: string;
      };
      estimated_cost_usdc?: string;
      max_cost_usdc?: string;
    }>;
    tool_policy: {
      allowlist: string[];
      require_allowlist: boolean;
    };
    budget: {
      not_to_exceed_usdc: string;
      approval_threshold_usdc?: string;
      per_step_default_cap_usdc?: string;
    };
  };
  execution: {
    active_step_id: string | null;
    progress: {
      completed_steps: string[];
      failed_steps: string[];
    };
    spend: {
      total_usdc: string;
      remaining_usdc: string | null;
    };
  };
  integrity: {
    approved_at: string | null;
    approved_by: string | null;
  };
  receipts?: Array<{
    id: string;
    step_id: string;
    tool: { method: string; url: string };
    cost: { currency: string; amount: string };
    x402: { payment_reference?: string };
    created_at: string;
  }>;
  deliverables?: Array<{
    id: string;
    type: string;
    title: string;
    storage: { kind: string; cid: string; gateway_url?: string | null };
    created_at: string;
  }>;
}

interface PlanDetailsModalProps {
  planId: string;
  onClose: () => void;
  onCancel: (planId: string) => Promise<void>;
}

export function PlanDetailsModal({ planId, onClose, onCancel }: PlanDetailsModalProps) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);

  useEffect(() => {
    fetchPlan();
  }, [planId]);

  const fetchPlan = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`/api/x402/plans/${planId}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Failed to fetch plan');
      }
      const data = await response.json();
      setPlan(data.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load plan');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!plan || !['running', 'paused'].includes(plan.status)) return;
    if (!confirm('Are you sure you want to cancel this plan?')) return;
    
    try {
      setCanceling(true);
      await onCancel(plan.id);
    } catch (err) {
      console.error('Failed to cancel plan:', err);
      alert('Failed to cancel plan. Please try again.');
    } finally {
      setCanceling(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'draft': return '#6b7280';
      case 'approved': return '#3b82f6';
      case 'running': return '#10b981';
      case 'paused': return '#f59e0b';
      case 'completed': return '#10b981';
      case 'canceled': return '#6b7280';
      case 'failed': return '#ef4444';
      default: return '#6b7280';
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const calculateProgress = () => {
    if (!plan) return 0;
    const total = parseFloat(plan.spec.budget.not_to_exceed_usdc);
    const spent = parseFloat(plan.execution.spend.total_usdc || '0');
    if (total === 0) return 0;
    return Math.min((spent / total) * 100, 100);
  };

  if (loading) {
    return (
      <div style={styles.modal} onClick={onClose}>
        <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
          <div style={styles.loadingContainer}>
            <div style={styles.spinner}></div>
            <p style={styles.loadingText}>Loading plan details...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !plan) {
    return (
      <div style={styles.modal} onClick={onClose}>
        <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
          <div style={styles.errorCard}>
            <p style={styles.errorMessage}>{error || 'Plan not found'}</p>
            <button onClick={onClose} style={styles.button} className="button">
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const progress = calculateProgress();
  const completedSteps = new Set(plan.receipts?.map(r => r.step_id) || []);

  return (
    <div style={styles.modal} onClick={onClose}>
      <div style={{ 
        ...styles.modalContent, 
        maxWidth: '800px', 
        width: '90%',
        maxHeight: '90vh', 
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        padding: '1.5rem'
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          marginBottom: '1.5rem',
          flexShrink: 0
        }}>
          <h2 style={styles.modalTitle}>{plan.title}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: 'var(--text-color)' }}>
            ×
          </button>
        </div>
        <div style={{ overflowY: 'auto', overflowX: 'hidden', flex: 1, paddingRight: '0.5rem' }}>

        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <span
              style={{
                padding: '0.25rem 0.75rem',
                borderRadius: '9999px',
                fontSize: '0.875rem',
                fontWeight: 600,
                backgroundColor: getStatusColor(plan.status) + '20',
                color: getStatusColor(plan.status),
              }}
            >
              {plan.status}
            </span>
            <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              Created: {formatDate(plan.created_at)}
            </span>
            {plan.integrity.approved_at && (
              <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                Approved: {formatDate(plan.integrity.approved_at)}
              </span>
            )}
          </div>
          <p style={{ color: 'var(--text-secondary)', lineHeight: '1.6', wordBreak: 'break-word', overflowWrap: 'break-word' }}>{plan.objective}</p>
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ ...styles.sectionTitle, fontSize: '1rem', marginBottom: '0.75rem' }}>Budget</h3>
          <div style={{ marginBottom: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem', fontSize: '0.875rem' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Spent / Total</span>
              <span style={{ fontWeight: 600 }}>
                ${parseFloat(plan.execution.spend.total_usdc || '0').toFixed(2)} / ${parseFloat(plan.spec.budget.not_to_exceed_usdc).toFixed(2)} USDC
              </span>
            </div>
            <div style={{ width: '100%', height: '8px', backgroundColor: '#e5e7eb', borderRadius: '9999px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${progress}%`,
                  height: '100%',
                  backgroundColor: progress > 90 ? '#ef4444' : progress > 70 ? '#f59e0b' : '#10b981',
                }}
              />
            </div>
          </div>
          {plan.execution.spend.remaining_usdc && (
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              Remaining: ${parseFloat(plan.execution.spend.remaining_usdc).toFixed(2)} USDC
            </p>
          )}
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ ...styles.sectionTitle, fontSize: '1rem', marginBottom: '0.75rem' }}>Execution Plans ({plan.spec.steps.length})</h3>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {plan.spec.steps.map((step) => {
              const isCompleted = completedSteps.has(step.id);
              return (
                <div
                  key={step.id}
                  style={{
                    padding: '0.75rem',
                    borderRadius: '0.375rem',
                    backgroundColor: isCompleted ? '#10b98120' : 'var(--card-bg)',
                    border: `1px solid ${isCompleted ? '#10b981' : '#e5e7eb'}`,
                    overflow: 'visible',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
                        {isCompleted && <span style={{ color: '#10b981', flexShrink: 0 }}>✓</span>}
                        <span style={{ fontWeight: 600, wordBreak: 'break-word' }}>{step.title}</span>
                      </div>
                      <div style={{ 
                        fontSize: '0.875rem', 
                        color: 'var(--text-secondary)',
                        wordBreak: 'break-word',
                        overflowWrap: 'break-word',
                        whiteSpace: 'normal',
                        lineHeight: '1.5'
                      }}>
                        {step.tool.method} {step.tool.url}
                      </div>
                    </div>
                    {step.max_cost_usdc && (
                      <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', flexShrink: 0 }}>
                        Max: ${parseFloat(step.max_cost_usdc).toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {plan.receipts && plan.receipts.length > 0 && (
          <div style={{ marginBottom: '1.5rem' }}>
            <h3 style={{ ...styles.sectionTitle, fontSize: '1rem', marginBottom: '0.75rem' }}>Receipts ({plan.receipts.length})</h3>
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {plan.receipts.map((receipt) => (
                <div
                  key={receipt.id}
                  style={{
                    padding: '0.75rem',
                    borderRadius: '0.375rem',
                    backgroundColor: 'var(--card-bg)',
                    border: '1px solid #e5e7eb',
                    fontSize: '0.875rem',
                    overflow: 'visible',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <span style={{ fontWeight: 600, wordBreak: 'break-word' }}>Step: {receipt.step_id}</span>
                    <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{formatDate(receipt.created_at)}</span>
                  </div>
                  <div style={{ 
                    color: 'var(--text-secondary)', 
                    marginBottom: '0.25rem',
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word',
                    whiteSpace: 'normal',
                    lineHeight: '1.5'
                  }}>
                    {receipt.tool.method} {receipt.tool.url}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                    <span style={{ flexShrink: 0 }}>${parseFloat(receipt.cost.amount).toFixed(2)} {receipt.cost.currency}</span>
                    {receipt.x402.payment_reference && (
                      <a
                        href={`https://www.x402scan.com/transfer/${receipt.x402.payment_reference}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#3b82f6', textDecoration: 'none', flexShrink: 0 }}
                      >
                        View on x402scan →
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {plan.deliverables && plan.deliverables.length > 0 && (
          <div style={{ marginBottom: '1.5rem' }}>
            <h3 style={{ ...styles.sectionTitle, fontSize: '1rem', marginBottom: '0.75rem' }}>Deliverables ({plan.deliverables.length})</h3>
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {plan.deliverables.map((deliverable) => (
                <div
                  key={deliverable.id}
                  style={{
                    padding: '0.75rem',
                    borderRadius: '0.375rem',
                    backgroundColor: 'var(--card-bg)',
                    border: '1px solid #e5e7eb',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                    <span style={{ fontWeight: 600 }}>{deliverable.title}</span>
                    <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{deliverable.type}</span>
                  </div>
                  {deliverable.storage.gateway_url ? (
                    <a
                      href={deliverable.storage.gateway_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: '0.875rem', color: '#3b82f6', textDecoration: 'none' }}
                    >
                      View on IPFS →
                    </a>
                  ) : (
                    <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>CID: {deliverable.storage.cid}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        </div>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.5rem', flexShrink: 0, paddingTop: '1rem', borderTop: '1px solid var(--border-light)' }}>
          {['running', 'paused'].includes(plan.status) && (
            <button
              onClick={handleCancel}
              disabled={canceling}
              style={{
                ...styles.button,
                backgroundColor: '#ef4444',
                opacity: canceling ? 0.6 : 1,
              }}
              className="button"
            >
              {canceling ? 'Canceling...' : 'Cancel Plan'}
            </button>
          )}
          <button onClick={onClose} style={styles.button} className="button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
