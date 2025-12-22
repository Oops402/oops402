import { useState, useEffect } from "react";
import { CopyIcon, CheckIcon, RefreshIcon } from "./icons";
import { truncateAddress } from "../utils/formatting";
import { PaymentHistoryItem, PaymentHistoryResponse, DiscoveryItem } from "../types";
import { PaymentModal } from "./PaymentModal";
import { styles } from "../styles";
import { checkAuthError } from "../utils/auth";

interface PaymentHistoryProps {
  walletAddress: string;
}

export function PaymentHistory({ walletAddress }: PaymentHistoryProps) {
  const [payments, setPayments] = useState<PaymentHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedTxHash, setCopiedTxHash] = useState<string | null>(null);
  const [pagination, setPagination] = useState<{
    page: number;
    totalPages: number;
    total: number;
    hasNextPage: boolean;
  }>({
    page: 0,
    totalPages: 0,
    total: 0,
    hasNextPage: false,
  });
  const [pageSize, setPageSize] = useState(10);
  const [timeframe, setTimeframe] = useState(30);
  const [paymentModal, setPaymentModal] = useState<{
    resourceUrl: string;
    acceptIndex: number;
    discoveryItem: DiscoveryItem;
  } | null>(null);
  const [loadingResource, setLoadingResource] = useState<string | null>(null);

  useEffect(() => {
    loadPaymentHistory(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, timeframe]);

  const loadPaymentHistory = async (page?: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.append('walletAddress', walletAddress);
      params.append('pageSize', pageSize.toString());
      params.append('page', (page !== undefined ? page : pagination.page).toString());
      params.append('timeframe', timeframe.toString());
      
      const response = await fetch(`/api/wallet/payment-history?${params.toString()}`, {
        credentials: "include",
      });
      if (await checkAuthError(response)) {
        return;
      }
      if (!response.ok) {
        throw new Error(`Failed to load payment history: ${response.statusText}`);
      }
      const data: PaymentHistoryResponse = await response.json();
      setPayments(data.payments || []);
      if (data.pagination) {
        setPagination(data.pagination);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load payment history");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyTxHash = (txHash: string) => {
    navigator.clipboard.writeText(txHash);
    setCopiedTxHash(txHash);
    setTimeout(() => setCopiedTxHash(null), 2000);
  };

  const handlePrevious = () => {
    if (pagination.page > 0) {
      loadPaymentHistory(pagination.page - 1);
    }
  };

  const handleNext = () => {
    if (pagination.hasNextPage) {
      loadPaymentHistory(pagination.page + 1);
    }
  };

  const formatDate = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      return date.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return timestamp;
    }
  };

  const getExplorerUrl = (txHash: string, chain: string) => {
    if (chain === "base") {
      return `https://basescan.org/tx/${txHash}`;
    }
    return `https://etherscan.io/tx/${txHash}`;
  };

  const handlePayAgain = async (payment: PaymentHistoryItem) => {
    if (!payment.bazaarResource) return;
    
    setLoadingResource(payment.bazaarResource.resource);
    try {
      // Fetch the discovery item from bazaar
      const params = new URLSearchParams();
      params.append('resource', payment.bazaarResource.resource);
      params.append('limit', '100'); // Get enough to find the resource
      
      const response = await fetch(`/api/discover/bazaar?${params.toString()}`, {
        credentials: "include",
      });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch resource: ${response.statusText}`);
      }
      
      const data = await response.json();
      const discoveryItem = data.items?.find(
        (item: DiscoveryItem) => item.resource === payment.bazaarResource!.resource
      );
      
      if (!discoveryItem) {
        throw new Error("Resource not found in bazaar");
      }
      
      // Find the matching accept by payTo address
      const acceptIndex = discoveryItem.accepts.findIndex(
        (accept) => accept.payTo?.toLowerCase() === payment.recipient.toLowerCase()
      );
      
      if (acceptIndex === -1) {
        // If no exact match, use the first accept
        setPaymentModal({
          resourceUrl: payment.bazaarResource.resource,
          acceptIndex: 0,
          discoveryItem,
        });
      } else {
        setPaymentModal({
          resourceUrl: payment.bazaarResource.resource,
          acceptIndex,
          discoveryItem,
        });
      }
    } catch (err) {
      console.error("Failed to load resource for payment:", err);
      alert(err instanceof Error ? err.message : "Failed to load resource");
    } finally {
      setLoadingResource(null);
    }
  };

  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <h2 style={styles.sectionTitle}>Payment History</h2>
          <button
            onClick={() => loadPaymentHistory()}
            style={styles.iconButton}
            className="icon-button"
            title="Refresh payment history"
            disabled={loading}
          >
            <RefreshIcon style={{
              animation: loading ? "spin 1s linear infinite" : "none",
            }} />
          </button>
        </div>
        <div style={styles.filterRow}>
          <label style={styles.filterLabel}>
            Timeframe:
            <select
              value={timeframe}
              onChange={(e) => {
                setTimeframe(Number(e.target.value));
                setPagination(prev => ({ ...prev, page: 0 }));
              }}
              style={styles.select}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last year</option>
            </select>
          </label>
          <label style={styles.filterLabel}>
            Per page:
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPagination(prev => ({ ...prev, page: 0 }));
                loadPaymentHistory(0);
              }}
              style={styles.select}
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
          </label>
        </div>
      </div>

      {error && (
        <div style={styles.errorCard}>
          <div style={styles.errorIcon}>⚠️</div>
          <div>
            <h3 style={styles.errorTitle}>Error loading payment history</h3>
            <p style={styles.errorMessage}>{error}</p>
          </div>
          <button onClick={() => loadPaymentHistory()} style={styles.button} className="button">
            Retry
          </button>
        </div>
      )}

      {loading && payments.length === 0 ? (
        <div style={styles.loadingContainer}>
          <div style={styles.spinner}></div>
          <p style={styles.loadingText}>Loading payment history...</p>
        </div>
      ) : payments.length === 0 ? (
        <div style={styles.emptyCard}>
          <h3 style={styles.emptyTitle}>No payments found</h3>
          <p style={styles.emptyText}>
            No payment history found for this wallet in the selected timeframe.
          </p>
        </div>
      ) : (
        <>
          <div style={styles.paymentList}>
            {payments.map((payment) => (
              <div key={payment.id} style={styles.paymentCard}>
                <div style={styles.paymentHeader}>
                  <div style={styles.paymentAmount}>
                    <span style={styles.paymentAmountValue}>
                      -{payment.amountFormatted} USDC
                    </span>
                    <span style={styles.paymentChain}>{payment.chain}</span>
                  </div>
                  <div style={styles.paymentDate}>{formatDate(payment.blockTimestamp)}</div>
                </div>
                <div style={styles.paymentDetails}>
                  {payment.bazaarResource && (
                    <div style={styles.paymentBazaarInfo}>
                      <div style={styles.paymentBazaarLabel}>Service/Tool:</div>
                      <div style={styles.paymentBazaarContent}>
                        <a
                          href={payment.bazaarResource.resource}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={styles.paymentLink}
                        >
                          {payment.bazaarResource.resource}
                        </a>
                        {payment.bazaarResource.description && (
                          <div style={styles.paymentBazaarDescription}>
                            {payment.bazaarResource.description}
                          </div>
                        )}
                        <div style={styles.paymentBazaarType}>
                          Type: {payment.bazaarResource.type}
                        </div>
                        <button
                          onClick={() => handlePayAgain(payment)}
                          disabled={loadingResource === payment.bazaarResource.resource}
                          style={{
                            ...styles.payAgainButton,
                            ...(loadingResource === payment.bazaarResource.resource ? styles.buttonDisabled : {}),
                          }}
                          className="button"
                        >
                          {loadingResource === payment.bazaarResource.resource ? "Loading..." : "Pay & Call Again"}
                        </button>
                      </div>
                    </div>
                  )}
                  <div style={styles.paymentDetailRow}>
                    <span style={styles.paymentDetailLabel}>To:</span>
                    <span style={styles.paymentDetailValue}>
                      {truncateAddress(payment.recipient)}
                    </span>
                  </div>
                  <div style={styles.paymentDetailRow}>
                    <span style={styles.paymentDetailLabel}>Provider:</span>
                    <span style={styles.paymentDetailValue}>
                      {payment.provider} {payment.facilitatorId && `(${payment.facilitatorId})`}
                    </span>
                  </div>
                  <div style={styles.paymentDetailRow}>
                    <span style={styles.paymentDetailLabel}>Transaction:</span>
                    <div style={styles.paymentTxHash}>
                      <a
                        href={getExplorerUrl(payment.transactionHash, payment.chain)}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={styles.paymentLink}
                      >
                        {truncateAddress(payment.transactionHash)}
                      </a>
                      <button
                        onClick={() => handleCopyTxHash(payment.transactionHash)}
                        style={styles.iconButton}
                        className="icon-button"
                        title="Copy transaction hash"
                      >
                        {copiedTxHash === payment.transactionHash ? <CheckIcon /> : <CopyIcon />}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {pagination.totalPages > 1 && (
            <div style={styles.pagination}>
              <button
                onClick={handlePrevious}
                disabled={pagination.page === 0 || loading}
                style={{
                  ...styles.button,
                  ...(pagination.page === 0 || loading ? styles.buttonDisabled : {}),
                }}
                className="button"
              >
                Previous
              </button>
              <span style={styles.paginationInfo}>
                Page {pagination.page + 1} of {pagination.totalPages} ({pagination.total} total)
              </span>
              <button
                onClick={handleNext}
                disabled={!pagination.hasNextPage || loading}
                style={{
                  ...styles.button,
                  ...(!pagination.hasNextPage || loading ? styles.buttonDisabled : {}),
                }}
                className="button"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {paymentModal && (
        <PaymentModal
          isOpen={!!paymentModal}
          onClose={() => setPaymentModal(null)}
          resourceUrl={paymentModal.resourceUrl}
          acceptIndex={paymentModal.acceptIndex}
          discoveryItem={paymentModal.discoveryItem}
          walletAddress={walletAddress}
        />
      )}
    </div>
  );
}

