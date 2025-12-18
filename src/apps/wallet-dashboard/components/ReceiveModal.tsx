import { useMemo } from "react";
import { CloseIcon, CopyIcon, CheckIcon } from "./icons";
import { generateQRCode } from "../utils/qrcode";
import { truncateAddress } from "../utils/formatting";
import { styles } from "../styles";

interface ReceiveModalProps {
  address: string;
  onClose: () => void;
  onCopy: (address: string) => void;
  copiedAddress: string | null;
}

export function ReceiveModal({ address, onClose, onCopy, copiedAddress }: ReceiveModalProps) {
  const qrCodeDataUrl = useMemo(() => generateQRCode(address), [address]);

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
            <img
              src={qrCodeDataUrl}
              alt="QR Code"
              style={styles.qrCode}
            />
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

