import { useState } from "react";
import { CloseIcon } from "./icons";
import { formatAmountDisplay, truncateAddress } from "../utils/formatting";
import { DiscoveryItem, PaymentResult } from "../types";
import { styles } from "../styles";

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

  const accept = discoveryItem.accepts[acceptIndex];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
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
      if (!response.ok) {
        throw new Error(data.error || `Payment failed: ${response.statusText}`);
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
            </div>
          </div>

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

