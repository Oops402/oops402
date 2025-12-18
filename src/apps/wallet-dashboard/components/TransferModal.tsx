import React from "react";
import { CloseIcon } from "./icons";
import { truncateAddress, formatBalance, getExplorerUrl } from "../utils/formatting";
import { Wallet, Balance } from "../types";
import { styles } from "../styles";

interface TransferModalProps {
  wallet: Wallet;
  balance: Balance | null;
  transferForm: {
    to: string;
    amount: string;
    chainId: number;
    tokenAddress: string;
  };
  isLoading?: boolean;
  transactionHash?: string | null;
  onClose: () => void;
  onTransfer: (e: React.FormEvent) => void;
  onFormChange: (form: TransferModalProps["transferForm"]) => void;
}

export function TransferModal({
  wallet,
  balance,
  transferForm,
  isLoading = false,
  transactionHash = null,
  onClose,
  onTransfer,
  onFormChange,
}: TransferModalProps) {
  const isSuccess = !!transactionHash;
  const isDisabled = isLoading || isSuccess;

  return (
    <div style={styles.modal} onClick={(e) => e.target === e.currentTarget && !isDisabled && onClose()}>
      <div style={styles.modalContent}>
        <div style={styles.modalHeader}>
          <h2 style={styles.modalTitle}>
            {isSuccess ? "Transfer Successful" : "Send Tokens"}
          </h2>
          {!isDisabled && (
            <button
              onClick={onClose}
              style={styles.closeButton}
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          )}
        </div>

        {isSuccess ? (
          <div style={styles.form}>
            <div style={styles.formGroup}>
              <div style={{
                padding: "1.5rem",
                background: "#e8f5e9",
                borderRadius: "8px",
                textAlign: "center",
                marginBottom: "1rem",
              }}>
                <div style={{ fontSize: "3rem", marginBottom: "0.5rem" }}>✓</div>
                <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "#2e7d32", marginBottom: "0.5rem" }}>
                  Transaction submitted successfully!
                </div>
                <div style={{ fontSize: "0.875rem", color: "#666" }}>
                  Your transfer has been processed.
                </div>
              </div>
            </div>

            {transactionHash && (
              <div style={styles.formGroup}>
                <label style={styles.label}>Transaction Hash</label>
                <div style={styles.addressDisplay}>
                  {truncateAddress(transactionHash)}
                </div>
                <a
                  href={getExplorerUrl(transferForm.chainId, transactionHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    ...styles.link,
                    marginTop: "0.5rem",
                    display: "inline-block",
                    fontSize: "0.875rem",
                  }}
                >
                  View on Explorer →
                </a>
              </div>
            )}

            <div style={styles.formActions}>
              <button
                type="button"
                onClick={onClose}
                style={styles.button}
                className="button"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={onTransfer} style={styles.form}>
            <div style={styles.formGroup}>
              <label style={styles.label}>From</label>
              <div style={styles.addressDisplay}>
                {truncateAddress(wallet.address)}
              </div>
            </div>
            
            <div style={styles.formGroup}>
              <label style={styles.label}>To Address</label>
              <input
                type="text"
                value={transferForm.to}
                onChange={(e) => onFormChange({ ...transferForm, to: e.target.value })}
                style={styles.input}
                className="input"
                placeholder="0x..."
                required
                disabled={isDisabled}
              />
            </div>
            
            <div style={styles.formGroup}>
              <label style={styles.label}>Amount</label>
              <input
                type="number"
                step="0.000001"
                value={transferForm.amount}
                onChange={(e) => onFormChange({ ...transferForm, amount: e.target.value })}
                style={styles.input}
                className="input"
                placeholder="0.00"
                required
                disabled={isDisabled}
              />
              {balance && (
                <div style={styles.balanceHint}>
                  Available: {formatBalance(balance.balance)} {balance.symbol}
                </div>
              )}
            </div>
            
            <div style={styles.formActions}>
              <button
                type="button"
                onClick={onClose}
                style={styles.buttonSecondary}
                className="button-secondary"
                disabled={isDisabled}
              >
                Cancel
              </button>
              <button
                type="submit"
                style={{
                  ...styles.button,
                  opacity: isDisabled ? 0.6 : 1,
                  cursor: isDisabled ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.5rem",
                }}
                className="button"
                disabled={isDisabled}
              >
                {isLoading && (
                  <div style={{
                    width: "16px",
                    height: "16px",
                    border: "2px solid rgba(255, 255, 255, 0.3)",
                    borderTop: "2px solid white",
                    borderRadius: "50%",
                    animation: "spin 1s linear infinite",
                  }}></div>
                )}
                {isLoading ? "Sending..." : "Send"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

