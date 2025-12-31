import { useState, useEffect } from "react";
import { CloseIcon } from "./icons";
import { formatAmountDisplay, truncateAddress } from "../utils/formatting";
import { DiscoveryItem, PaymentResult } from "../types";
import { styles } from "../styles";
import { checkAuthError } from "../utils/auth";

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  resourceUrl: string;
  acceptIndex: number;
  discoveryItem: DiscoveryItem;
  walletAddress: string;
}

export function PaymentModal({
  isOpen,
  onClose,
  resourceUrl,
  acceptIndex,
  discoveryItem,
  walletAddress,
}: PaymentModalProps) {
  const [method, setMethod] = useState<string>("GET");
  const [requestBody, setRequestBody] = useState<string>("");
  const [customHeaders, setCustomHeaders] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PaymentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [budgetWarning, setBudgetWarning] = useState<string | null>(null);
  const [budgetLimits, setBudgetLimits] = useState<{ perRequestMax: string | null; sessionBudget: string | null } | null>(null);
  const [sessionSpent, setSessionSpent] = useState<string>("0");

  const accept = discoveryItem.accepts[acceptIndex];

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

  // Fetch budget limits and session spending on mount
  useEffect(() => {
    const fetchBudgetInfo = async () => {
      try {
        // Fetch budget limits
        const budgetRes = await fetch("/api/preferences/budget", {
          credentials: "include",
        });
        if (budgetRes.ok) {
          const budgetData = await budgetRes.json();
          setBudgetLimits(budgetData.budget);
        }

        // Fetch session spending
        const spentRes = await fetch("/api/session/spent", {
          credentials: "include",
        });
        if (spentRes.ok) {
          const spentData = await spentRes.json();
          setSessionSpent(spentData.spentAtomic || "0");
        }
      } catch (err) {
        // Silently fail - budget checks are optional
        console.debug("Failed to fetch budget info", err);
      }
    };

    if (isOpen) {
      fetchBudgetInfo();
    }
  }, [isOpen]);

  // Check budget before payment
  useEffect(() => {
    if (!budgetLimits || !accept.maxAmountRequired) {
      setBudgetWarning(null);
      return;
    }

    const paymentAmountAtomic = accept.maxAmountRequired;
    const warnings: string[] = [];

    // Check per-request max
    if (budgetLimits.perRequestMax) {
      const perRequestMaxAtomic = parseUSDC(budgetLimits.perRequestMax);
      if (perRequestMaxAtomic && BigInt(paymentAmountAtomic) > BigInt(perRequestMaxAtomic)) {
        warnings.push(`Payment amount (${formatAmountDisplay(paymentAmountAtomic)}) exceeds per-request limit (${budgetLimits.perRequestMax} USDC)`);
      }
    }

    // Check remaining session budget
    if (budgetLimits.sessionBudget) {
      const sessionBudgetAtomic = parseUSDC(budgetLimits.sessionBudget);
      if (sessionBudgetAtomic) {
        const remaining = BigInt(sessionBudgetAtomic) - BigInt(sessionSpent);
        if (BigInt(paymentAmountAtomic) > remaining) {
          warnings.push(`Payment amount (${formatAmountDisplay(paymentAmountAtomic)}) exceeds remaining session budget (${formatUSDC(remaining.toString())} USDC)`);
        }
      }
    }

    setBudgetWarning(warnings.length > 0 ? warnings.join(". ") : null);
  }, [budgetLimits, sessionSpent, accept.maxAmountRequired]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // Check budget limits before payment
      if (budgetLimits && accept.maxAmountRequired) {
        const paymentAmountAtomic = accept.maxAmountRequired;
        
        // Check per-request max
        if (budgetLimits.perRequestMax) {
          const perRequestMaxAtomic = parseUSDC(budgetLimits.perRequestMax);
          if (perRequestMaxAtomic && BigInt(paymentAmountAtomic) > BigInt(perRequestMaxAtomic)) {
            throw new Error(`Payment amount exceeds per-request limit of ${budgetLimits.perRequestMax} USDC`);
          }
        }

        // Check remaining session budget
        if (budgetLimits.sessionBudget) {
          const sessionBudgetAtomic = parseUSDC(budgetLimits.sessionBudget);
          if (sessionBudgetAtomic) {
            const remaining = BigInt(sessionBudgetAtomic) - BigInt(sessionSpent);
            if (BigInt(paymentAmountAtomic) > remaining) {
              throw new Error(`Payment amount exceeds remaining session budget of ${formatUSDC(remaining.toString())} USDC`);
            }
          }
        }
      }

      const headers: Record<string, string> = {};
      if (customHeaders) {
        try {
          const parsed = JSON.parse(customHeaders);
          Object.assign(headers, parsed);
        } catch (e) {
          throw new Error("Invalid JSON in custom headers");
        }
      }

      const response = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          resourceUrl,
          method,
          body: requestBody || undefined,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          walletAddress,
        }),
      });

      const data = await response.json();
      if (await checkAuthError(response, data)) {
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || `Payment failed: ${response.statusText}`);
      }

      // Track session spending on successful payment
      if (accept.maxAmountRequired) {
        try {
          await fetch("/api/session/spent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              amountAtomic: accept.maxAmountRequired,
            }),
          });
          // Update local state
          const newSpent = (BigInt(sessionSpent) + BigInt(accept.maxAmountRequired)).toString();
          setSessionSpent(newSpent);
        } catch (err) {
          // Log but don't fail the payment if tracking fails
          console.error("Failed to track session spending", err);
        }
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed");
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div style={styles.modal} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={styles.modalContent}>
        <div style={styles.modalHeader}>
          <h2 style={styles.modalTitle}>Pay & Call Resource</h2>
          <button
            onClick={onClose}
            style={styles.closeButton}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>
        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.formGroup}>
            <label style={styles.label}>Resource URL</label>
            <div style={styles.addressDisplay}>{resourceUrl}</div>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Payment Details</label>
            <div style={styles.paymentInfo}>
              <div>Network: {accept.network}</div>
              <div>Amount: {formatAmountDisplay(accept.maxAmountRequired)} USDC</div>
              <div>Asset: {truncateAddress(accept.asset || "")}</div>
              {budgetLimits && (
                <div style={{ marginTop: "8px", fontSize: "0.9em", color: "#666" }}>
                  {budgetLimits.perRequestMax && (
                    <div>Per-request limit: {budgetLimits.perRequestMax} USDC</div>
                  )}
                  {budgetLimits.sessionBudget && (
                    <div>
                      Remaining budget: {formatUSDC((BigInt(parseUSDC(budgetLimits.sessionBudget) || "0") - BigInt(sessionSpent)).toString())} USDC
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {budgetWarning && (
            <div style={{ ...styles.errorText, backgroundColor: "#fff3cd", color: "#856404", padding: "12px", borderRadius: "4px", marginBottom: "16px" }}>
              ⚠️ {budgetWarning}
            </div>
          )}

          <div style={styles.formGroup}>
            <label style={styles.label}>HTTP Method</label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              style={styles.input}
              className="input"
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select>
          </div>

          {(method === "POST" || method === "PUT" || method === "PATCH") && (
            <div style={styles.formGroup}>
              <label style={styles.label}>Request Body (JSON)</label>
              <textarea
                value={requestBody}
                onChange={(e) => setRequestBody(e.target.value)}
                style={{ ...styles.input, minHeight: "100px", fontFamily: "monospace" }}
                className="input"
                placeholder='{"key": "value"}'
              />
            </div>
          )}

          <div style={styles.formGroup}>
            <label style={styles.label}>Custom Headers (JSON, optional)</label>
            <textarea
              value={customHeaders}
              onChange={(e) => setCustomHeaders(e.target.value)}
              style={{ ...styles.input, minHeight: "60px", fontFamily: "monospace" }}
              className="input"
              placeholder='{"Header-Name": "value"}'
            />
          </div>

          {error && <div style={styles.errorText}>{error}</div>}
          {result && (
            <div style={styles.resultContainer}>
              <div style={styles.resultHeader}>
                Status: {result.status} {result.success ? "✓" : "✗"}
              </div>
              {result.payment && (
                <div style={styles.paymentResult}>
                  <div>Payment: {result.payment.settled ? "Settled" : "Pending"}</div>
                  {result.payment.transactionHash && (
                    <div>TX: {result.payment.transactionHash}</div>
                  )}
                </div>
              )}
              <div style={styles.resultData}>
                <pre>{JSON.stringify(result.data, null, 2)}</pre>
              </div>
            </div>
          )}

          <div style={styles.formActions}>
            <button
              type="button"
              onClick={onClose}
              style={styles.buttonSecondary}
              className="button-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              style={styles.button}
              className="button"
              disabled={loading}
            >
              {loading ? "Processing..." : "Pay & Call"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

