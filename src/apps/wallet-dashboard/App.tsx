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
import { BudgetModal } from "./components/BudgetModal";
import { DiscoverySection } from "./components/DiscoverySection";
import { AgentSearchSection } from "./components/AgentSearchSection";
import { DirectX402Caller } from "./components/DirectX402Caller";
import { McpConnectionModal } from "./components/McpConnectionModal";
import { PaymentHistory } from "./components/PaymentHistory";
import { AnalyticsSection } from "./components/AnalyticsSection";
import { styles } from "./styles";
import "./styles.css";
import { checkAuthError } from "./utils/auth";

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
  const [activeTab, setActiveTab] = useState<"wallet" | "discovery" | "agents" | "analytics">("wallet");
  const [directCallerModalOpen, setDirectCallerModalOpen] = useState(false);
  const [mcpConnectionModalOpen, setMcpConnectionModalOpen] = useState(false);
  const [budgetModalOpen, setBudgetModalOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    // Check localStorage or system preference
    const saved = localStorage.getItem("darkMode");
    if (saved !== null) return saved === "true";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  // Fetch wallet and profile on mount
  useEffect(() => {
    fetchWallet();
    fetchProfile();
  }, []);

  // Reset avatar error when profile changes
  useEffect(() => {
    setAvatarError(false);
  }, [userProfile?.picture]);

  // Apply dark mode class to document
  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add("dark-mode");
    } else {
      document.documentElement.classList.remove("dark-mode");
    }
    localStorage.setItem("darkMode", darkMode.toString());
  }, [darkMode]);

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
      if (await checkAuthError(response)) {
        return;
      }
      if (!response.ok) {
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
      if (await checkAuthError(response)) {
        return;
      }
      if (!response.ok) {
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
      if (await checkAuthError(response)) {
        return;
      }
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
      if (await checkAuthError(response)) {
        return;
      }
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
          <div>
            <h3 style={styles.errorTitle}>Wallet session timeout</h3>
            <p style={styles.errorMessage}>Please login again to continue.</p>
          </div>
          <button onClick={() => window.location.href = "/login"} style={styles.button} className="button">
            Login again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <header style={styles.header} className="header">
        <div style={styles.headerTitleContainer} className="header-title-container">
          <img 
            src="https://blue-acceptable-moth-851.mypinata.cloud/ipfs/bafkreigz5rv2tj7c7mut3up4zruh55bzfdajb4wpaeh4l7bqh3tffzef34?pinataGatewayToken=AOxI1_j6REen7ZvYuBtH8Zek2IS_8uV8LmNbXXdGbDlUKfMXnUQ1MvLVmKNZMrRm" 
            alt="Oops!402" 
            style={styles.logo}
            className="header-logo"
          />
          <h1 style={styles.title} className="header-title">x402 Wallet</h1>
        </div>
        <div style={styles.headerActions} className="header-actions">
          {balance && (
            <div style={styles.headerBalance} className="header-balance-mobile">
              <span style={styles.headerBalanceLabel}>Balance</span>
              <span style={styles.headerBalanceAmount}>
                {formatBalance(balance.balance)} {balance.symbol}
              </span>
            </div>
          )}
          {userProfile && (
            <div style={styles.userProfile} className="user-profile">
              {userProfile.picture && !avatarError ? (
                <img 
                  src={userProfile.picture} 
                  alt={userProfile.name || userProfile.nickname || "User"} 
                  style={styles.userAvatar}
                  className="user-avatar"
                  onError={() => setAvatarError(true)}
                  crossOrigin="anonymous"
                  referrerPolicy="no-referrer"
                  title={userProfile.name || userProfile.nickname || "User"}
                />
              ) : (
                <div 
                  style={styles.userAvatarFallback}
                  className="user-avatar-fallback"
                  title={userProfile.name || userProfile.nickname || "User"}
                >
                  {(userProfile.name || userProfile.nickname || "U").charAt(0).toUpperCase()}
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => setMcpConnectionModalOpen(true)}
            style={{
              ...styles.link,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
            className="link"
            title="Add Oops!402 to ChatGPT or Claude"
          >
            <svg style={styles.linkIcon} className="link-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zm-4 10H8v-1h8v1zm0-3H8v-1h8v1zm2-3h-2v-2h-2v2h-4v-2H8v2H6v-2.88c.94-.37 1.62-1.27 1.62-2.32V9.2c0-1.1.9-2 2-2h4.76c1.1 0 2 .9 2 2v1.6c0 1.05.68 1.95 1.62 2.32V13zm-6.5-5.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm5 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
            </svg>
            <span>Add MCP to your Agent</span>
          </button>
          <button
            onClick={() => setDarkMode(!darkMode)}
            style={{
              ...styles.link,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
            className="link"
            title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
          >
            <svg style={styles.linkIcon} className="link-icon" viewBox="0 0 20 20" fill="currentColor">
              {darkMode ? (
                <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
              ) : (
                <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
              )}
            </svg>
          </button>
          <a href="/" style={styles.link} className="link">
            <svg style={styles.linkIcon} className="link-icon" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
            </svg>
          </a>
          <a href="/logout" style={styles.link} className="link">
            <svg style={styles.linkIcon} className="link-icon" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z" clipRule="evenodd" />
            </svg>
          </a>
        </div>
      </header>

      {error && (
        <div style={styles.errorBanner} onClick={() => setError(null)}>
          <span>{error}</span>
          <span style={styles.dismiss}>×</span>
        </div>
      )}

      <div style={styles.tabs} className="tabs">
        <button
          style={{
            ...styles.tab,
            ...(activeTab === "wallet" ? styles.tabActive : {}),
          }}
          onClick={() => setActiveTab("wallet")}
          className={`tab ${activeTab === "wallet" ? "tab-active" : ""}`}
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
          className={`tab ${activeTab === "discovery" ? "tab-active" : ""}`}
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
          className={`tab ${activeTab === "agents" ? "tab-active" : ""}`}
        >
          <svg style={styles.tabIcon} viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
          <span>Agents</span>
        </button>
        <button
          style={{
            ...styles.tab,
            ...(activeTab === "analytics" ? styles.tabActive : {}),
          }}
          onClick={() => setActiveTab("analytics")}
          className={`tab ${activeTab === "analytics" ? "tab-active" : ""}`}
        >
          <svg style={styles.tabIcon} viewBox="0 0 20 20" fill="currentColor">
            <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
          </svg>
          <span>Analytics</span>
        </button>

      </div>

      <div style={activeTab === "wallet" ? styles.tabContent : styles.tabContentHidden}>
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>Your x402 Wallet</h2>

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
              onBudget={() => setBudgetModalOpen(true)}
            />
          ) : (
            <div style={styles.emptyCard}>
              <div style={styles.emptyIcon}>💼</div>
              <h3 style={styles.emptyTitle}>Loading wallet...</h3>
              <p style={styles.emptyText}>Your wallet is being created or loaded.</p>
            </div>
          )}
        </div>

        {wallet && (
          <div style={styles.section}>
            <PaymentHistory walletAddress={wallet.address} />
          </div>
        )}
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

      <div style={activeTab === "analytics" ? styles.tabContent : styles.tabContentHidden}>
        {wallet && <AnalyticsSection walletAddress={wallet.address} />}
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

      <McpConnectionModal
        isOpen={mcpConnectionModalOpen}
        onClose={() => setMcpConnectionModalOpen(false)}
      />

      <BudgetModal
        isOpen={budgetModalOpen}
        onClose={() => setBudgetModalOpen(false)}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletDashboard />
  </StrictMode>
);
