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
import { AgentSearchSection } from "./components/AgentSearchSection";
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
  const [activeTab, setActiveTab] = useState<"wallet" | "discovery" | "agents">("wallet");
  const [directCallerModalOpen, setDirectCallerModalOpen] = useState(false);

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
          {balance && (
            <div style={styles.headerBalance}>
              <span style={styles.headerBalanceLabel}>Balance</span>
              <span style={styles.headerBalanceAmount}>
                {formatBalance(balance.balance)} {balance.symbol}
              </span>
            </div>
          )}
          {userProfile && (
            <div style={styles.userProfile}>
              {userProfile.picture && !avatarError ? (
                <img 
                  src={userProfile.picture} 
                  alt={userProfile.name || userProfile.nickname || "User"} 
                  style={styles.userAvatar}
                  onError={() => setAvatarError(true)}
                  crossOrigin="anonymous"
                  referrerPolicy="no-referrer"
                  title={userProfile.name || userProfile.nickname || "User"}
                />
              ) : (
                <div 
                  style={styles.userAvatarFallback}
                  title={userProfile.name || userProfile.nickname || "User"}
                >
                  {(userProfile.name || userProfile.nickname || "U").charAt(0).toUpperCase()}
                </div>
              )}
            </div>
          )}
          <a href="/" style={styles.link} className="link">
            <svg style={styles.linkIcon} viewBox="0 0 20 20" fill="currentColor">
              <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
            </svg>
            <span>Home</span>
          </a>
          <a href="/logout" style={styles.link} className="link">
            <svg style={styles.linkIcon} viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z" clipRule="evenodd" />
            </svg>
            <span>Logout</span>
          </a>
        </div>
      </header>

      {error && (
        <div style={styles.errorBanner} onClick={() => setError(null)}>
          <span>{error}</span>
          <span style={styles.dismiss}>×</span>
        </div>
      )}

      <div style={styles.tabs}>
        <button
          style={{
            ...styles.tab,
            ...(activeTab === "wallet" ? styles.tabActive : {}),
          }}
          onClick={() => setActiveTab("wallet")}
          className={activeTab === "wallet" ? "tab-active" : ""}
        >
          <svg style={styles.tabIcon} viewBox="0 0 20 20" fill="currentColor">
            <path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z" />
            <path fillRule="evenodd" d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z" clipRule="evenodd" />
          </svg>
          <span>Wallet</span>
        </button>
        <button
          style={{
            ...styles.tab,
            ...(activeTab === "discovery" ? styles.tabActive : {}),
          }}
          onClick={() => setActiveTab("discovery")}
          className={activeTab === "discovery" ? "tab-active" : ""}
        >
          <svg style={styles.tabIcon} viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
          <span>Bazaar</span>
        </button>
        <button
          style={{
            ...styles.tab,
            ...(activeTab === "agents" ? styles.tabActive : {}),
          }}
          onClick={() => setActiveTab("agents")}
          className={activeTab === "agents" ? "tab-active" : ""}
        >
          <svg style={styles.tabIcon} viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
          <span>Agents</span>
        </button>
      </div>

      <div style={activeTab === "wallet" ? styles.tabContent : styles.tabContentHidden}>
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
      </div>

      <div style={activeTab === "discovery" ? styles.tabContent : styles.tabContentHidden}>
        <DiscoverySection
          onPay={(resourceUrl, acceptIndex, discoveryItem) => {
            setPaymentModal({ resourceUrl, acceptIndex, discoveryItem });
          }}
          onOpenDirectCaller={() => setDirectCallerModalOpen(true)}
        />
      </div>

      <div style={activeTab === "agents" ? styles.tabContent : styles.tabContentHidden}>
        <AgentSearchSection />
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

      {wallet && (
        <DirectX402Caller
          walletAddress={wallet.address}
          isOpen={directCallerModalOpen}
          onClose={() => setDirectCallerModalOpen(false)}
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
