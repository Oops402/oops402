import { useState } from "react";
import { formatAmountDisplay } from "../utils/formatting";
import { PaymentResult } from "../types";
import { styles } from "../styles";

interface DirectX402CallerProps {
  walletAddress: string;
}

export function DirectX402Caller({ walletAddress }: DirectX402CallerProps) {
  const [resourceUrl, setResourceUrl] = useState<string>("");
  const [method, setMethod] = useState<string>("GET");
  const [queryParams, setQueryParams] = useState<string>("");
  const [requestBody, setRequestBody] = useState<string>("");
  const [customHeaders, setCustomHeaders] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [schema, setSchema] = useState<any>(null);
  const [result, setResult] = useState<PaymentResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const discoverSchema = async () => {
    if (!resourceUrl.trim()) {
      setError("Please enter a resource URL first");
      return;
    }

    setDiscovering(true);
    setError(null);
    setSchema(null);

    try {
      // Build URL with query params if provided
      let urlToDiscover = resourceUrl.trim();
      if (queryParams.trim()) {
        const separator = urlToDiscover.includes('?') ? '&' : '?';
        urlToDiscover = `${urlToDiscover}${separator}${queryParams.trim()}`;
      }

      const response = await fetch("/api/discover/schema", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          url: urlToDiscover,
          method,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to discover schema");
      }

      setSchema(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Schema discovery failed");
    } finally {
      setDiscovering(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resourceUrl.trim()) {
      setError("Please enter a resource URL");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // Build full URL with query params
      let fullUrl = resourceUrl.trim();
      if (queryParams.trim()) {
        const separator = fullUrl.includes('?') ? '&' : '?';
        fullUrl = `${fullUrl}${separator}${queryParams.trim()}`;
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
          resourceUrl: fullUrl,
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

  return (
    <div style={styles.section}>
      <h2 style={styles.sectionTitle}>Call x402 Resource Directly</h2>
      <div style={styles.directCallerCard}>
        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.formGroup}>
            <label style={styles.label}>Resource URL</label>
            <input
              type="text"
              value={resourceUrl}
              onChange={(e) => setResourceUrl(e.target.value)}
              placeholder="https://example.com/api/resource"
              style={styles.input}
              className="input"
              required
            />
            <div style={styles.hintText}>
              Enter the base URL of the x402-protected resource
            </div>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Query Parameters (optional)</label>
            <input
              type="text"
              value={queryParams}
              onChange={(e) => setQueryParams(e.target.value)}
              placeholder="param1=value1&amp;param2=value2"
              style={styles.input}
              className="input"
            />
            <div style={styles.hintText}>
              URL-encoded query parameters (e.g., param1=value1&amp;param2=value2)
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
                style={{ ...styles.input, minHeight: "120px", fontFamily: "monospace" }}
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
              style={{ ...styles.input, minHeight: "80px", fontFamily: "monospace" }}
              className="input"
              placeholder='{"Header-Name": "value"}'
            />
          </div>

          <div style={styles.formActions}>
            <button
              type="button"
              onClick={discoverSchema}
              style={styles.buttonSecondary}
              className="button-secondary"
              disabled={discovering || !resourceUrl.trim()}
            >
              {discovering ? "Discovering..." : "Discover Schema"}
            </button>
          </div>

          {schema && (
            <div style={styles.schemaContainer}>
              <h3 style={styles.schemaTitle}>Payment Requirements</h3>
              {schema.hasX402Schema && schema.schema?.accepts ? (
                <div style={styles.schemaContent}>
                  {Array.isArray(schema.schema.accepts) && schema.schema.accepts.length > 0 ? (
                    <div style={styles.acceptsList}>
                      {schema.schema.accepts.map((accept: any, index: number) => (
                        <div key={index} style={styles.acceptItem}>
                          <div><strong>Network:</strong> {accept.network || "N/A"}</div>
                          <div><strong>Scheme:</strong> {accept.scheme || "N/A"}</div>
                          <div><strong>Amount:</strong> {accept.maxAmountRequired ? formatAmountDisplay(String(accept.maxAmountRequired)) : "N/A"} USDC</div>
                          {accept.description && <div><strong>Description:</strong> {accept.description}</div>}
                          {accept.outputSchema && (
                            <div style={styles.outputSchemaContainer}>
                              <strong>Expected Input Schema:</strong>
                              <pre style={styles.schemaPreview}>
                                {JSON.stringify(accept.outputSchema, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div>No payment options found in schema</div>
                  )}
                </div>
              ) : (
                <div style={styles.schemaContent}>
                  <div>Status: {schema.status}</div>
                  {schema.schema && (
                    <details style={styles.schemaDetails}>
                      <summary>View Response</summary>
                      <pre style={styles.schemaPreview}>
                        {JSON.stringify(schema.schema, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          )}

          {error && <div style={styles.errorText}>{error}</div>}
          {result && (
            <div style={styles.resultContainer}>
              <div style={styles.resultHeader}>
                Status: {result.status} {result.success ? "✓" : "✗"}
              </div>
              {result.payment && (
                <div style={styles.paymentResult}>
                  <div><strong>Payment Status:</strong> {result.payment.settled ? "Settled" : "Pending"}</div>
                  {result.payment.transactionHash && (
                    <div><strong>Transaction Hash:</strong> {result.payment.transactionHash}</div>
                  )}
                  {result.payment.amount !== undefined && result.payment.amount !== null && (
                    <div><strong>Amount Paid:</strong> {formatAmountDisplay(String(result.payment.amount))} USDC</div>
                  )}
                </div>
              )}
              <div style={styles.resultData}>
                <strong>Response:</strong>
                <pre>{JSON.stringify(result.data, null, 2)}</pre>
              </div>
            </div>
          )}

          <div style={styles.formActions}>
            <button
              type="button"
              onClick={() => {
                setResourceUrl("");
                setQueryParams("");
                setRequestBody("");
                setCustomHeaders("");
                setResult(null);
                setError(null);
                setSchema(null);
              }}
              style={styles.buttonSecondary}
              className="button-secondary"
              disabled={loading}
            >
              Clear
            </button>
            <button
              type="submit"
              style={styles.button}
              className="button"
              disabled={loading}
            >
              {loading ? "Processing..." : "Call Resource"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

