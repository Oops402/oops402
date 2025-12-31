import React, { useState, useEffect } from "react";
import { CloseIcon } from "./icons";
import { styles } from "../styles";
import { checkAuthError } from "../utils/auth";

interface BudgetModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function BudgetModal({ isOpen, onClose }: BudgetModalProps) {
  const [perRequestMax, setPerRequestMax] = useState<string>("");
  const [sessionBudget, setSessionBudget] = useState<string>("");
  const [onlyPromoted, setOnlyPromoted] = useState<boolean>(false);
  const [minAgentScore, setMinAgentScore] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [sessionSpent, setSessionSpent] = useState<string>("0");

  // Fetch current preferences on mount
  useEffect(() => {
    if (!isOpen) return;

    const fetchPreferences = async () => {
      try {
        setLoading(true);
        const budgetRes = await fetch("/api/preferences/budget", {
          credentials: "include",
        });
        if (budgetRes.ok) {
          const budgetData = await budgetRes.json();
          setPerRequestMax(budgetData.budget.perRequestMax || "");
          setSessionBudget(budgetData.budget.sessionBudget || "");
        }

        const discoveryRes = await fetch("/api/preferences/discovery", {
          credentials: "include",
        });
        if (discoveryRes.ok) {
          const discoveryData = await discoveryRes.json();
          setOnlyPromoted(discoveryData.discovery.onlyPromoted || false);
          setMinAgentScore(discoveryData.discovery.minAgentScore?.toString() || "");
        }

        const spentRes = await fetch("/api/session/spent", {
          credentials: "include",
        });
        if (spentRes.ok) {
          const spentData = await spentRes.json();
          setSessionSpent(spentData.spentAtomic || "0");
        }
      } catch (err) {
        console.error("Failed to fetch preferences", err);
      } finally {
        setLoading(false);
      }
    };

    fetchPreferences();
  }, [isOpen]);

  const handleSave = async (field?: "perRequestMax" | "sessionBudget" | "discovery" | "all") => {
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const updates: any = {};
      
      if (!field || field === "perRequestMax" || field === "all") {
        if (perRequestMax && (!/^\d+(\.\d{0,6})?$/.test(perRequestMax.replace(/,/g, "")))) {
          throw new Error("Invalid per-request max amount format");
        }
        updates.perRequestMax = perRequestMax || null;
      }
      
      if (!field || field === "sessionBudget" || field === "all") {
        if (sessionBudget && (!/^\d+(\.\d{0,6})?$/.test(sessionBudget.replace(/,/g, "")))) {
          throw new Error("Invalid session budget amount format");
        }
        updates.sessionBudget = sessionBudget || null;
      }
      
      if (!field || field === "discovery" || field === "all") {
        updates.onlyPromoted = onlyPromoted;
        if (minAgentScore) {
          const score = parseFloat(minAgentScore);
          if (isNaN(score) || score < 0 || score > 100) {
            throw new Error("Minimum agent score must be a number between 0 and 100");
          }
          updates.minAgentScore = score;
        } else {
          updates.minAgentScore = null;
        }
      }

      const response = await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(updates),
      });

      const data = await response.json();
      if (await checkAuthError(response, data)) {
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || "Failed to save preferences");
      }

      const fieldName = field === "perRequestMax" ? "Per-request limit" 
        : field === "sessionBudget" ? "Session budget"
        : field === "discovery" ? "Discovery preferences"
        : "Preferences";
      setSuccess(`${fieldName} saved successfully`);
      setTimeout(() => setSuccess(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save preferences");
    } finally {
      setSaving(false);
    }
  };

  // Format atomic units to human-readable USDC
  const formatUSDC = (atomic: string): string => {
    const amount = BigInt(atomic);
    const divisor = BigInt(10 ** 6);
    const whole = amount / divisor;
    const remainder = amount % divisor;
    if (remainder === 0n) {
      return whole.toString();
    }
    const remainderStr = remainder.toString().padStart(6, '0');
    const trimmed = remainderStr.replace(/0+$/, '');
    return `${whole}.${trimmed}`;
  };

  // Calculate remaining budget
  const getRemainingBudget = (): string | null => {
    if (!sessionBudget) return null;
    const sessionBudgetAtomic = parseUSDC(sessionBudget);
    if (!sessionBudgetAtomic) return null;
    const remaining = BigInt(sessionBudgetAtomic) - BigInt(sessionSpent);
    return remaining >= 0n ? formatUSDC(remaining.toString()) : "0";
  };

  // Parse human-readable USDC to atomic units
  const parseUSDC = (input: string): string | null => {
    const sanitized = input.replace(/,/g, "").trim();
    if (sanitized === "" || !/^\d*(\.\d{0,6})?$/.test(sanitized)) return null;
    const [whole, fracRaw] = sanitized.split(".");
    const frac = (fracRaw || "").padEnd(6, "0").slice(0, 6);
    try {
      const wholePart = BigInt(whole || "0") * 1000000n;
      const fracPart = BigInt(frac || "0");
      return (wholePart + fracPart).toString();
    } catch {
      return null;
    }
  };

  if (!isOpen) return null;

  const remainingBudget = getRemainingBudget();

  return (
    <div style={styles.modal} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={styles.modalContent}>
        <div style={styles.modalHeader}>
          <h2 style={styles.modalTitle}>Budget & Trust Settings</h2>
          <button
            onClick={onClose}
            style={styles.closeButton}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        {loading && <div style={{ padding: "20px", textAlign: "center" }}>Loading...</div>}

        {!loading && (
          <div style={styles.form}>
            {error && <div style={styles.errorText}>{error}</div>}
            {success && <div style={{ ...styles.errorText, color: "#28a745" }}>{success}</div>}

            <div style={styles.formGroup}>
              <label style={styles.label}>Per-Request Maximum (USDC)</label>
              <div style={{ fontSize: "0.9em", color: "#666", marginBottom: "8px" }}>
                Maximum amount allowed per individual payment request
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  value={perRequestMax}
                  onChange={(e) => setPerRequestMax(e.target.value)}
                  placeholder="e.g., 0.05"
                  style={styles.input}
                  className="input"
                />
                <button
                  type="button"
                  onClick={() => handleSave("perRequestMax")}
                  style={styles.button}
                  className="button"
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
              {perRequestMax && (
                <div style={{ fontSize: "0.85em", color: "#666", marginTop: "4px" }}>
                  Current: {perRequestMax} USDC
                </div>
              )}
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Session Budget (USDC)</label>
              <div style={{ fontSize: "0.9em", color: "#666", marginBottom: "8px" }}>
                Total amount available for this session
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  value={sessionBudget}
                  onChange={(e) => setSessionBudget(e.target.value)}
                  placeholder="e.g., 5.00"
                  style={styles.input}
                  className="input"
                />
                <button
                  type="button"
                  onClick={() => handleSave("sessionBudget")}
                  style={styles.button}
                  className="button"
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
              {sessionBudget && (
                <div style={{ fontSize: "0.85em", color: "#666", marginTop: "4px" }}>
                  Current: {sessionBudget} USDC
                  {remainingBudget !== null && (
                    <span style={{ marginLeft: "12px", fontWeight: "bold" }}>
                      | Remaining: {remainingBudget} USDC
                    </span>
                  )}
                </div>
              )}
              {sessionSpent !== "0" && (
                <div style={{ fontSize: "0.85em", color: "#666", marginTop: "4px" }}>
                  Spent this session: {formatUSDC(sessionSpent)} USDC
                </div>
              )}
            </div>

            <div style={{ ...styles.formGroup, marginTop: "24px", paddingTop: "24px", borderTop: "1px solid #e0e0e0" }}>

              <div style={styles.formGroup}>
                <label style={{ ...styles.label, display: "flex", alignItems: "center", gap: "8px" }}>
                  <input
                    type="checkbox"
                    checked={onlyPromoted}
                    onChange={(e) => setOnlyPromoted(e.target.checked)}
                    style={{ width: "18px", height: "18px" }}
                  />
                  Only show promoted resources/agents
                </label>
                <div style={{ fontSize: "0.9em", color: "#666", marginTop: "4px", marginLeft: "26px" }}>
                  When enabled, only resources and agents with active promotions will be shown in discovery results
                </div>
              </div>

              <div style={styles.formGroup}>
                <label style={styles.label}>Minimum Agent Score (0-100)</label>
                <div style={{ fontSize: "0.9em", color: "#666", marginBottom: "8px" }}>
                  Only show agents with an average score at or above this value (leave empty to show all agents)
                </div>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={minAgentScore}
                  onChange={(e) => setMinAgentScore(e.target.value)}
                  placeholder="e.g., 80"
                  style={styles.input}
                  className="input"
                />
                {minAgentScore && (
                  <div style={{ fontSize: "0.85em", color: "#666", marginTop: "4px" }}>
                    Current: {minAgentScore}
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                <button
                  type="button"
                  onClick={() => handleSave("discovery")}
                  style={styles.button}
                  className="button"
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save Discovery Settings"}
                </button>
              </div>
            </div>

            <div style={styles.formActions}>
              <button
                type="button"
                onClick={onClose}
                style={styles.buttonSecondary}
                className="button-secondary"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => handleSave("all")}
                style={styles.button}
                className="button"
                disabled={saving}
              >
                {saving ? "Saving..." : "Save All"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

