import { useState, useEffect } from "react";
import { CopyIcon, CheckIcon } from "./icons";
import { formatAmountDisplay, truncateAddress } from "../utils/formatting";
import { DiscoveryItem, DiscoveryResponse } from "../types";
import { styles } from "../styles";

interface DiscoverySectionProps {
  onPay: (resourceUrl: string, acceptIndex: number, item: DiscoveryItem) => void;
}

export function DiscoverySection({ onPay }: DiscoverySectionProps) {
  const [items, setItems] = useState<DiscoveryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const [copiedAssets, setCopiedAssets] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    loadDiscoveryItems();
  }, []);

  const loadDiscoveryItems = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (searchQuery) {
        params.append('keyword', searchQuery);
      }
      const response = await fetch(`/api/discover/bazaar?${params.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(`Failed to load discovery items: ${response.statusText}`);
      }
      const data: DiscoveryResponse = await response.json();
      setItems(data.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load discovery items");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (resource: string) => {
    setExpandedItems(prev => ({
      ...prev,
      [resource]: !prev[resource],
    }));
  };

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedAssets(prev => ({ ...prev, [key]: true }));
    setTimeout(() => {
      setCopiedAssets(prev => ({ ...prev, [key]: false }));
    }, 2000);
  };

  return (
    <div style={styles.section}>
      <h2 style={styles.sectionTitle}>Discover x402 Services</h2>
      <div style={styles.discoveryContent}>
        <div style={styles.searchContainer} className="search-container">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search resources..."
            style={styles.input}
            className="input"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                loadDiscoveryItems();
              }
            }}
          />
          <button
            onClick={loadDiscoveryItems}
            style={styles.button}
            className="button"
          >
            Search
          </button>
        </div>
        {loading && <div style={styles.loadingText}>Loading...</div>}
        {error && <div style={styles.errorText}>{error}</div>}
        <div style={styles.discoveryList}>
          {items.map((item) => (
            <div key={item.resource} style={styles.discoveryCard}>
              <div style={styles.discoveryCardHeader}>
                <div style={styles.discoveryCardInfo}>
                  <div style={styles.discoveryResourceUrl}>{item.resource}</div>
                  {item.accepts[0]?.description && (
                    <div style={styles.discoveryDescription}>{item.accepts[0].description}</div>
                  )}
                </div>
                <div style={styles.discoveryCardActions}>
                  <span style={styles.badge}>{item.type.toUpperCase()}</span>
                  {item.accepts[0] && (
                    <span style={styles.badge}>{item.accepts[0].network.toUpperCase()}</span>
                  )}
                  <button
                    onClick={() => toggleExpand(item.resource)}
                    style={styles.iconButton}
                    className="icon-button"
                    title={expandedItems[item.resource] ? "Collapse" : "Expand"}
                  >
                    {expandedItems[item.resource] ? '▼' : '▶'}
                  </button>
                </div>
              </div>

              {expandedItems[item.resource] && (
                <div style={styles.discoveryCardDetails}>
                  <h3 style={styles.discoveryCardSubtitle}>Payment Options</h3>
                  {item.accepts.length > 0 ? (
                    <>
                      <table style={styles.discoveryTable} className="discovery-table">
                        <thead>
                          <tr>
                            <th>Network</th>
                            <th>Scheme</th>
                            <th>Amount</th>
                            <th>Asset</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {item.accepts.map((accept, acceptIndex) => (
                            <tr key={acceptIndex}>
                              <td data-label="Network">{accept.network}</td>
                              <td data-label="Scheme">{accept.scheme}</td>
                              <td data-label="Amount">{formatAmountDisplay(accept.maxAmountRequired)} USDC</td>
                              <td data-label="Asset">
                                <div style={styles.assetCell}>
                                  <span>{truncateAddress(accept.asset || "")}</span>
                                  <button
                                    onClick={() => copyToClipboard(accept.asset || "", accept.asset || "")}
                                    style={styles.iconButton}
                                    className="icon-button"
                                    title="Copy asset address"
                                  >
                                    {copiedAssets[accept.asset || ""] ? <CheckIcon /> : <CopyIcon />}
                                  </button>
                                </div>
                              </td>
                              <td data-label="Actions">
                                <button
                                  onClick={() => onPay(item.resource, acceptIndex, item)}
                                  style={styles.payButton}
                                  className="button"
                                >
                                  Pay & Call
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {/* Mobile-friendly card layout */}
                      <div className="discovery-mobile-cards">
                        {item.accepts.map((accept, acceptIndex) => (
                          <div key={acceptIndex} style={styles.mobilePaymentCard}>
                            <div style={styles.mobileCardRow}>
                              <strong>Network:</strong>
                              <span>{accept.network}</span>
                            </div>
                            <div style={styles.mobileCardRow}>
                              <strong>Scheme:</strong>
                              <span>{accept.scheme}</span>
                            </div>
                            <div style={styles.mobileCardRow}>
                              <strong>Amount:</strong>
                              <span>{formatAmountDisplay(accept.maxAmountRequired)} USDC</span>
                            </div>
                            <div style={styles.mobileCardRow}>
                              <strong>Asset:</strong>
                              <div style={styles.assetCell}>
                                <span>{truncateAddress(accept.asset || "")}</span>
                                <button
                                  onClick={() => copyToClipboard(accept.asset || "", accept.asset || "")}
                                  style={styles.iconButton}
                                  className="icon-button"
                                  title="Copy asset address"
                                >
                                  {copiedAssets[accept.asset || ""] ? <CheckIcon /> : <CopyIcon />}
                                </button>
                              </div>
                            </div>
                            <button
                              onClick={() => onPay(item.resource, acceptIndex, item)}
                              style={{ ...styles.payButton, width: "100%", marginTop: "0.5rem" }}
                              className="button"
                            >
                              Pay & Call
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div style={styles.emptyText}>No payment options available</div>
                  )}
                </div>
              )}
            </div>
          ))}
          {!loading && items.length === 0 && !error && (
            <div style={{ ...styles.emptyText, textAlign: "center", padding: "2rem" }}>
              No resources found. Try a different search query.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

