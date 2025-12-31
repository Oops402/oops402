import { useState, useEffect } from "react";
import { CopyIcon, CheckIcon } from "./icons";
import { formatAmountDisplay, truncateAddress } from "../utils/formatting";
import { DiscoveryItem, DiscoveryResponse } from "../types";
import { styles } from "../styles";
import { checkAuthError } from "../utils/auth";
import { PromoteModal } from "./PromoteModal";

interface DiscoverySectionProps {
  onPay: (resourceUrl: string, acceptIndex: number, item: DiscoveryItem) => void;
  onOpenDirectCaller?: () => void;
}

export function DiscoverySection({ onPay, onOpenDirectCaller }: DiscoverySectionProps) {
  const [items, setItems] = useState<DiscoveryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const [copiedAssets, setCopiedAssets] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"price_asc" | "price_desc" | undefined>(undefined);
  const [pagination, setPagination] = useState<{
    limit: number;
    offset: number;
    total: number;
  }>({
    limit: 10,
    offset: 0,
    total: 0,
  });
  const [promoteModal, setPromoteModal] = useState<{
    resourceUrl: string;
    resourceType: 'bazaar' | 'agent';
  } | null>(null);

  useEffect(() => {
    // Reset to first page and reload when sort changes
    setPagination(prev => ({ ...prev, offset: 0 }));
    loadDiscoveryItems(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortBy]);

  const loadDiscoveryItems = async (offset?: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (searchQuery) {
        params.append('keyword', searchQuery);
      }
      if (sortBy) {
        params.append('sortBy', sortBy);
      }
      const currentOffset = offset !== undefined ? offset : pagination.offset;
      params.append('offset', currentOffset.toString());
      params.append('limit', pagination.limit.toString());
      
      const response = await fetch(`/api/discover/bazaar?${params.toString()}`, {
        credentials: "include",
      });
      if (await checkAuthError(response)) {
        return;
      }
      if (!response.ok) {
        throw new Error(`Failed to load discovery items: ${response.statusText}`);
      }
      const data: DiscoveryResponse = await response.json();
      setItems(data.items || []);
      if (data.pagination) {
        setPagination({
          limit: data.pagination.limit,
          offset: data.pagination.offset,
          total: data.pagination.total,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load discovery items");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = () => {
    loadDiscoveryItems(0);
  };

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setSortBy(value === "price_asc" || value === "price_desc" ? value : undefined);
  };

  const handlePrevious = () => {
    if (pagination.offset > 0) {
      const newOffset = Math.max(0, pagination.offset - pagination.limit);
      loadDiscoveryItems(newOffset);
    }
  };

  const handleNext = () => {
    if (pagination.offset + pagination.limit < pagination.total) {
      const newOffset = pagination.offset + pagination.limit;
      loadDiscoveryItems(newOffset);
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
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>Discover x402 Services</h2>
        {onOpenDirectCaller && (
          <button
            onClick={onOpenDirectCaller}
            style={styles.button}
            className="button"
          >
            Direct Call
          </button>
        )}
      </div>
      <div style={styles.discoveryContent}>
        <div style={styles.searchContainer} className="search-container">
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search resources..."
              style={{ ...styles.input, flex: "1", minWidth: "200px" }}
              className="input"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSearch();
                }
              }}
            />
            <select
              value={sortBy || ""}
              onChange={handleSortChange}
              style={{
                ...styles.input,
                minWidth: "180px",
                cursor: "pointer",
              }}
              className="input"
            >
              <option value="">Sort by...</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="price_desc">Price: High to Low</option>
            </select>
            <button
              onClick={handleSearch}
              style={styles.button}
              className="button"
            >
              Search
            </button>
          </div>
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
                  {item.promoted && (
                    <span style={{ ...styles.badge, backgroundColor: "#ffd700", color: "#000" }}>
                      PROMOTED
                    </span>
                  )}
                  <span style={styles.badge}>{item.type.toUpperCase()}</span>
                  {item.accepts[0] && (
                    <span style={styles.badge}>{item.accepts[0].network.toUpperCase()}</span>
                  )}
                  {!item.promoted && (
                    <button
                      onClick={() => setPromoteModal({ resourceUrl: item.resource, resourceType: 'bazaar' })}
                      style={styles.buttonSecondary}
                      className="button-secondary"
                      title="Promote this resource"
                    >
                      Promote
                    </button>
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
        {pagination.total > 0 && (
          <div style={styles.pagination}>
            <div style={styles.paginationInfo}>
              Showing {pagination.offset + 1} - {Math.min(pagination.offset + pagination.limit, pagination.total)} of {pagination.total}
            </div>
            <div style={styles.paginationControls}>
              <button
                onClick={handlePrevious}
                style={{
                  ...styles.buttonSecondary,
                  ...(pagination.offset === 0 ? { opacity: 0.5, cursor: "not-allowed" } : {}),
                }}
                className="button-secondary"
                disabled={pagination.offset === 0 || loading}
              >
                Previous
              </button>
              <button
                onClick={handleNext}
                style={{
                  ...styles.buttonSecondary,
                  ...(pagination.offset + pagination.limit >= pagination.total ? { opacity: 0.5, cursor: "not-allowed" } : {}),
                }}
                className="button-secondary"
                disabled={pagination.offset + pagination.limit >= pagination.total || loading}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
      {promoteModal && (
        <PromoteModal
          isOpen={!!promoteModal}
          onClose={() => setPromoteModal(null)}
          resourceUrl={promoteModal.resourceUrl}
          resourceType={promoteModal.resourceType}
        />
      )}
    </div>
  );
}

