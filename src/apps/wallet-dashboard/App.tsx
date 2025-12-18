/**
 * Wallet Dashboard - Web UI for managing x402 wallets
 */
import React, { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Wallet, Balance, UserProfile, DiscoveryItem } from "./types";
import { formatBalance } from "./utils/formatting";
import { WalletCard } from "./components/WalletCard";
import { TransferModal } from "./components/TransferModal";
import { ReceiveModal } from "./components/ReceiveModal";
import { PaymentModal } from "./components/PaymentModal";
import { DiscoverySection } from "./components/DiscoverySection";
import { DirectX402Caller } from "./components/DirectX402Caller";
import { styles } from "./styles";
import "./styles.css";

function WalletDashboard() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [avatarError, setAvatarError] = useState(false);
  const [transferForm, setTransferForm] = useState<{
    to: string;
    amount: string;
    chainId: number;
    tokenAddress: string;
  } | null>(null);
  const [transferLoading, setTransferLoading] = useState(false);
  const [transferTxHash, setTransferTxHash] = useState<string | null>(null);
  const [receiveModal, setReceiveModal] = useState<{ address: string } | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [refreshingBalance, setRefreshingBalance] = useState(false);
  const [paymentModal, setPaymentModal] = useState<{
    resourceUrl: string;
    acceptIndex: number;
    discoveryItem: DiscoveryItem;
  } | null>(null);

  // Fetch wallet and profile on mount
  useEffect(() => {
    fetchWallet();
    fetchProfile();
  }, []);

  // Reset avatar error when profile changes
  useEffect(() => {
    setAvatarError(false);
  }, [userProfile?.picture]);

  // Fetch balance when wallet changes
  useEffect(() => {
    if (wallet) {
      fetchBalance();
    }
  }, [wallet]);

  const handleCopyAddress = (address: string) => {
    navigator.clipboard.writeText(address);
    setCopiedAddress(address);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  const handleRefreshBalance = async () => {
    if (!wallet) return;
    setRefreshingBalance(true);
    try {
      await fetchBalance();
    } catch (err) {
      console.error("Failed to refresh balance:", err);
    } finally {
      setTimeout(() => setRefreshingBalance(false), 1000);
    }
  };

  const fetchProfile = async () => {
    try {
      const response = await fetch("/api/profile", {
        credentials: "include",
      });
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = "/login";
          return;
        }
        return;
      }
      const data = await response.json();
      setUserProfile(data.user || null);
    } catch (err) {
      console.error("Failed to fetch profile:", err);
    }
  };

  const fetchWallet = async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/wallet", {
        credentials: "include",
      });
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = "/login";
          return;
        }
        throw new Error(`Failed to fetch wallet: ${response.statusText}`);
      }
      const data = await response.json();
      setWallet(data.wallet || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch wallet");
    } finally {
      setLoading(false);
    }
  };

  const fetchBalance = async () => {
    if (!wallet) return;
    try {
      const response = await fetch("/api/wallet/balance", {
        credentials: "include",
      });
      if (!response.ok) return;
      const data = await response.json();
      setBalance({
        address: wallet.address,
        chainId: data.chainId,
        tokenAddress: data.tokenAddress,
        balance: data.tokenBalance || data.balance || "0",
        symbol: data.symbol || "USDC",
      });
    } catch (err) {
      console.error("Failed to fetch balance:", err);
    }
  };

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transferForm || !wallet || transferLoading) return;

    setTransferLoading(true);
    setTransferTxHash(null);
    setError(null);

    try {
      const response = await fetch("/api/wallet/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(transferForm),
      });
      if (!response.ok) {
        throw new Error(`Transfer failed: ${response.statusText}`);
      }
      const data = await response.json();
      setTransferTxHash(data.transactionHash || null);
      await fetchBalance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transfer failed");
      setTransferLoading(false);
      setTransferTxHash(null);
    } finally {
      setTransferLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loadingContainer}>
          <div style={styles.spinner}></div>
          <p style={styles.loadingText}>Loading x402 wallet...</p>
        </div>
      </div>
    );
  }

  if (error && !wallet) {
    return (
      <div style={styles.container}>
        <header style={styles.header}>
          <h1 style={styles.title}>Oops!402 Wallet</h1>
        </header>
        <div style={styles.errorCard}>
          <div style={styles.errorIcon}>⚠️</div>
          <div>
            <h3 style={styles.errorTitle}>Unable to load wallet</h3>
            <p style={styles.errorMessage}>{error}</p>
          </div>
          <button onClick={() => window.location.href = "/login"} style={styles.button} className="button">
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerTitleContainer}>
          <img 
            src="https://blue-acceptable-moth-851.mypinata.cloud/ipfs/bafkreigz5rv2tj7c7mut3up4zruh55bzfdajb4wpaeh4l7bqh3tffzef34?pinataGatewayToken=AOxI1_j6REen7ZvYuBtH8Zek2IS_8uV8LmNbXXdGbDlUKfMXnUQ1MvLVmKNZMrRm" 
            alt="Oops!402" 
            style={styles.logo}
          />
          <h1 style={styles.title}>x402 Wallet</h1>
        </div>
        <div style={styles.headerActions} className="header-actions">
          {userProfile && (
            <div style={styles.userProfile}>
              {userProfile.picture && !avatarError ? (
                <img 
                  src={userProfile.picture} 
                  alt={userProfile.nickname || userProfile.name || "User"} 
                  style={styles.userAvatar}
                  onError={() => setAvatarError(true)}
                  crossOrigin="anonymous"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div style={styles.userAvatarFallback}>
                  {(userProfile.nickname || userProfile.name || "U").charAt(0).toUpperCase()}
                </div>
              )}
              <span style={styles.userName}>
                {userProfile.nickname || userProfile.name || "User"}
              </span>
            </div>
          )}
          <a href="/" style={styles.link} className="link">← Home</a>
          <a href="/logout" style={styles.link} className="link">Logout</a>
        </div>
      </header>

      {error && (
        <div style={styles.errorBanner} onClick={() => setError(null)}>
          <span>{error}</span>
          <span style={styles.dismiss}>×</span>
        </div>
      )}

      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Your Wallet</h2>

        {wallet ? (
          <WalletCard
            wallet={wallet}
            balance={balance}
            copiedAddress={copiedAddress}
            refreshingBalance={refreshingBalance}
            onCopyAddress={handleCopyAddress}
            onRefreshBalance={handleRefreshBalance}
            onSend={() => setTransferForm({
              to: "",
              amount: "",
              chainId: 8453,
              tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            })}
            onReceive={() => setReceiveModal({ address: wallet.address })}
          />
        ) : (
          <div style={styles.emptyCard}>
            <div style={styles.emptyIcon}>💼</div>
            <h3 style={styles.emptyTitle}>Loading wallet...</h3>
            <p style={styles.emptyText}>Your wallet is being created or loaded.</p>
          </div>
        )}
      </div>

      {transferForm && wallet && (
        <TransferModal
          wallet={wallet}
          balance={balance}
          transferForm={transferForm}
          isLoading={transferLoading}
          transactionHash={transferTxHash}
          onClose={() => {
            setTransferForm(null);
            setTransferTxHash(null);
            setTransferLoading(false);
          }}
          onTransfer={handleTransfer}
          onFormChange={setTransferForm}
        />
      )}

      {receiveModal && (
        <ReceiveModal
          address={receiveModal.address}
          onClose={() => setReceiveModal(null)}
          onCopy={handleCopyAddress}
          copiedAddress={copiedAddress}
        />
      )}

      {wallet && (
        <DirectX402Caller walletAddress={wallet.address} />
      )}

      <DiscoverySection
        onPay={(resourceUrl, acceptIndex, discoveryItem) => {
          setPaymentModal({ resourceUrl, acceptIndex, discoveryItem });
        }}
      />

      {paymentModal && wallet && (
        <PaymentModal
          isOpen={!!paymentModal}
          onClose={() => setPaymentModal(null)}
          resourceUrl={paymentModal.resourceUrl}
          acceptIndex={paymentModal.acceptIndex}
          discoveryItem={paymentModal.discoveryItem}
          walletAddress={wallet.address}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletDashboard />
  </StrictMode>
);
