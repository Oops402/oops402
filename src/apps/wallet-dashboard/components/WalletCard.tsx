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
    </div>
  );
}

