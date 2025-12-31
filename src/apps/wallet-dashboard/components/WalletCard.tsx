import { CopyIcon, CheckIcon, SendIcon, ReceiveIcon, RefreshIcon } from "./icons";
import { truncateAddress, formatBalance } from "../utils/formatting";
import { Wallet, Balance } from "../types";
import { styles } from "../styles";

interface WalletCardProps {
  wallet: Wallet;
  balance: Balance | null;
  copiedAddress: string | null;
  refreshingBalance: boolean;
  onCopyAddress: (address: string) => void;
  onRefreshBalance: () => void;
  onSend: () => void;
  onReceive: () => void;
  onBudget: () => void;
}

export function WalletCard({
  wallet,
  balance,
  copiedAddress,
  refreshingBalance,
  onCopyAddress,
  onRefreshBalance,
  onSend,
  onReceive,
  onBudget,
}: WalletCardProps) {
  return (
    <div style={styles.walletCard} className="wallet-card">
      <div style={styles.walletCardHeader}>
        <div style={styles.walletInfo}>
          <div style={styles.walletLabel}>Wallet Address</div>
          <div style={styles.walletAddressRow}>
            <span style={styles.walletAddress}>{truncateAddress(wallet.address)}</span>
            <button
              onClick={() => onCopyAddress(wallet.address)}
              style={styles.iconButton}
              className="icon-button"
              title="Copy address"
            >
              {copiedAddress === wallet.address ? <CheckIcon /> : <CopyIcon />}
            </button>
          </div>
        </div>
      </div>
      
      <div style={styles.balanceSection}>
        <div style={styles.balanceLabel}>Balance</div>
        <div style={styles.balanceRow}>
          <div style={styles.balanceAmount}>
            {balance ? (
              <>
                <span style={styles.balanceValue}>{formatBalance(balance.balance)}</span>
                <span style={styles.balanceSymbol}>{balance.symbol}</span>
              </>
            ) : (
              <span style={styles.balanceValue}>—</span>
            )}
          </div>
          <button
            onClick={onRefreshBalance}
            style={styles.iconButton}
            className="icon-button"
            title="Refresh balance"
            disabled={refreshingBalance}
          >
            <RefreshIcon style={{
              animation: refreshingBalance ? "spin 1s linear" : "none",
            }} />
          </button>
        </div>
      </div>

      <div style={styles.walletActions} className="wallet-actions">
        <button
          onClick={onSend}
          style={styles.actionButton}
          className="action-button"
        >
          <SendIcon />
          <span>Send</span>
        </button>
        <button
          onClick={onReceive}
          style={styles.actionButton}
          className="action-button"
        >
          <ReceiveIcon />
          <span>Receive</span>
        </button>
      </div>

      <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid var(--border-color)" }}>
        <button
          onClick={onBudget}
          style={{
            ...styles.buttonSecondary,
            display: "flex",
            alignItems: "center",
            gap: "8px",
            width: "100%",
            justifyContent: "flex-start",
            padding: "10px 14px",
          }}
          className="button-secondary"
        >
          <svg style={{ width: "16px", height: "16px" }} viewBox="0 0 20 20" fill="currentColor">
            <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8 8.114 8 8c0-.114.07-.34.433-.582zM11 12.849v-1.698c.22.071.412.164.567.267.364.243.433.468.433.582 0 .114-.07.34-.433.582a2.305 2.305 0 01-.567.267z" />
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6 7.009 6 8c0 .99.602 1.765 1.324 2.246.48.32 1.054.545 1.676.662v1.941c-.391-.127-.68-.317-.843-.504a1 1 0 10-1.51 1.31c.562.649 1.413 1.076 2.353 1.253V15a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 14 12.991 14 12c0-.99-.602-1.765-1.324-2.246A4.535 4.535 0 0011 9.092V7.151c.391.127.68.317.843.504a1 1 0 101.511-1.31c-.563-.649-1.413-1.076-2.354-1.253V5z" clipRule="evenodd" />
          </svg>
          <span>Budget & Trust Settings</span>
        </button>
      </div>
    </div>
  );
}

