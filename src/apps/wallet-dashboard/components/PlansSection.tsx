/**
 * PlansSection - Component for listing and filtering user's execution plans
 */
import React, { useState, useEffect } from 'react';
import { styles } from '../styles';

interface Plan {
  id: string;
  title: string;
  objective: string;
  status: string;
  created_at: string;
  spec: {
    budget: {
      not_to_exceed_usdc: string;
    };
    steps: Array<{ id: string; title: string }>;
  };
  execution: {
    spend: {
      total_usdc: string;
      remaining_usdc: string | null;
    };
  };
}

interface PlansSectionProps {
  onPlanSelect: (planId: string) => void;
}

export function PlansSection({ onPlanSelect }: PlansSectionProps) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  useEffect(() => {
    console.log('PlansSection: Component mounted, fetching plans...');
    fetchPlans();
  }, [statusFilter]);

  const fetchPlans = async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (statusFilter !== 'all') {
        params.append('status', statusFilter);
      }
      const response = await fetch(`/api/x402/plans?${params.toString()}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Failed to fetch plans: ${response.status}`);
      }
      const data = await response.json();
      console.log('PlansSection: Received data:', data);
      // Handle both { success: true, plans: [...] } and { plans: [...] } formats
      const plansArray = data.plans || (Array.isArray(data) ? data : []);
      console.log('PlansSection: Plans array:', plansArray);
      setPlans(plansArray);
    } catch (err) {
      console.error('Error fetching plans:', err);
      setError(err instanceof Error ? err.message : 'Failed to load plans');
    } finally {
      setLoading(false);
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
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const calculateProgress = (plan: Plan) => {
    const total = parseFloat(plan.spec.budget.not_to_exceed_usdc);
    const spent = parseFloat(plan.execution.spend.total_usdc || '0');
    if (total === 0) return 0;
    return Math.min((spent / total) * 100, 100);
  };

  if (loading) {
    return (
      <div style={styles.section}>
        <div style={styles.loadingContainer}>
          <div style={styles.spinner}></div>
          <p style={styles.loadingText}>Loading plans...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.section}>
        <div style={styles.errorCard}>
          <p style={styles.errorMessage}>{error}</p>
          <button onClick={fetchPlans} style={styles.button} className="button">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.section}>
      <div style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={styles.sectionTitle}>Execution Plans</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              padding: '0.5rem',
              borderRadius: '0.375rem',
              border: '1px solid #d1d5db',
              backgroundColor: 'var(--bg-color)',
              color: 'var(--text-color)',
            }}
          >
            <option value="all">All Status</option>
            <option value="draft">Draft</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="canceled">Canceled</option>
          </select>
        </div>
      </div>

      {plans.length === 0 ? (
        <div style={styles.emptyCard}>
          <div style={styles.emptyIcon}>📋</div>
          <h3 style={styles.emptyTitle}>No plans found</h3>
          <p style={styles.emptyText}>
            {statusFilter === 'all'
              ? "You don't have any execution plans yet. Create one via MCP/LLM tools."
              : `No plans with status "${statusFilter}" found.`}
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {plans.map((plan) => {
            const progress = calculateProgress(plan);
            return (
              <div
                key={plan.id}
                style={{
                  ...styles.card,
                  cursor: 'pointer',
                  transition: 'transform 0.2s, box-shadow 0.2s',
                }}
                onClick={() => onPlanSelect(plan.id)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.1)';
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                  <div style={{ flex: 1 }}>
                    <h3 style={{ ...styles.cardTitle, marginBottom: '0.25rem' }}>{plan.title}</h3>
                    <p style={{ ...styles.cardText, fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                      {plan.objective.length > 100 ? `${plan.objective.substring(0, 100)}...` : plan.objective}
                    </p>
                  </div>
                  <span
                    style={{
                      padding: '0.25rem 0.75rem',
                      borderRadius: '9999px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      backgroundColor: getStatusColor(plan.status) + '20',
                      color: getStatusColor(plan.status),
                    }}
                  >
                    {plan.status}
                  </span>
                </div>

                <div style={{ marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem', fontSize: '0.875rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Budget Progress</span>
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
                        transition: 'width 0.3s',
                      }}
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                  <span>{plan.spec.steps.length} steps</span>
                  <span>{formatDate(plan.created_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
