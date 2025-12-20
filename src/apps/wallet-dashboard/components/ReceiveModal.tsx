import React, { useState, useEffect } from "react";
import { CloseIcon, CopyIcon, CheckIcon } from "./icons";
import { generateQRCode } from "../utils/qrcode";
import { styles } from "../styles";

interface ReceiveModalProps {
  address: string;
  onClose: () => void;
  onCopy: (address: string) => void;
  copiedAddress: string | null;
}

export function ReceiveModal({ address, onClose, onCopy, copiedAddress }: ReceiveModalProps) {
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>("");

  useEffect(() => {
    generateQRCode(address).then(setQrCodeDataUrl).catch((error) => {
      console.error("Failed to generate QR code:", error);
      setQrCodeDataUrl("");
    });
  }, [address]);

  return (
    <div style={styles.modal} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={styles.modalContent}>
        <div style={styles.modalHeader}>
          <h2 style={styles.modalTitle}>Receive Tokens</h2>
          <button
            onClick={onClose}
            style={styles.closeButton}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>
        <div style={styles.receiveContent}>
          <div style={styles.qrCodeContainer}>
            {qrCodeDataUrl ? (
              <img
                src={qrCodeDataUrl}
                alt="QR Code"
                style={styles.qrCode}
              />
            ) : (
              <div style={{ ...styles.qrCode, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#f5f5f5" }}>
                Loading QR code...
              </div>
            )}
          </div>
          <div style={styles.receiveAddress}>
            <div style={styles.receiveLabel}>Wallet Address</div>
            <div style={styles.receiveAddressRow}>
              <span style={styles.receiveAddressText}>{address}</span>
              <button
                onClick={() => onCopy(address)}
                style={styles.iconButton}
                className="icon-button"
                title="Copy address"
              >
                {copiedAddress === address ? <CheckIcon /> : <CopyIcon />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

