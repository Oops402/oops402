import { useState, useEffect } from "react";
import { CloseIcon } from "./icons";
import { styles } from "../styles";
import { checkAuthError } from "../utils/auth";
import { formatAmountDisplay } from "../utils/formatting";

interface PromoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  resourceUrl: string;
  resourceType?: 'bazaar' | 'agent';
  agentId?: string;
}

interface FeeConfig {
  feePerDay: string;
  paymentRecipient?: string;
  chainId: number;
  currency: string;
  decimals: number;
}

export function PromoteModal({
  isOpen,
  onClose,
  resourceUrl,
  resourceType = 'bazaar',
  agentId,
}: PromoteModalProps) {
  const [days, setDays] = useState<string>("1");
  const [loading, setLoading] = useState(false);
  const [paying, setPaying] = useState(false);
  const [validating, setValidating] = useState(false);
  const [schema, setSchema] = useState<{ hasX402Schema?: boolean; supportedMethods?: string[]; schema?: any } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [feeConfig, setFeeConfig] = useState<FeeConfig | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [paymentTxHash, setPaymentTxHash] = useState<string | null>(null);

  // Load fee configuration and wallet info on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        // Load fee config first
        const feeResponse = await fetch("/api/promotions/fee-config", {
          credentials: "include",
        });
        let feeData: FeeConfig | null = null;
        if (feeResponse.ok) {
          const data = await feeResponse.json();
          if (data.success) {
            feeData = data;
            setFeeConfig(data);
          }
        }

        // Load wallet address
        const walletResponse = await fetch("/api/wallet", {
          credentials: "include",
        });
        if (walletResponse.ok) {
          const walletData = await walletResponse.json();
          const address = walletData.wallet?.address || walletData.address;
          if (walletData.success && address) {
            setWalletAddress(address);
            
            // Load balance using chainId from fee config
            const chainId = feeData?.chainId || 8453;
            const balanceResponse = await fetch(
              `/api/wallet/balance?chainId=${chainId}&tokenAddress=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
              { credentials: "include" }
            );
            if (balanceResponse.ok) {
              const balanceData = await balanceResponse.json();
              if (balanceData.success) {
                setBalance(balanceData.tokenBalance || "0");
              }
            }
          } else {
            console.error('Failed to load wallet address', walletData);
          }
        } else {
          const errorData = await walletResponse.json().catch(() => ({}));
          console.error('Failed to fetch wallet', errorData);
        }
      } catch (err) {
        console.error("Failed to load data", err);
      }
    };
    if (isOpen) {
      loadData();
      // Reset state when opening
      setDays("1");
      setPaymentTxHash(null);
      setSuccess(false);
      setError(null);
      setSchema(null);
    }
  }, [isOpen]);

  // Debug: Log disabled state when dependencies change
  useEffect(() => {
    // Check if hasX402Schema is actually true (handle both boolean and truthy values)
    const hasX402SchemaValue = schema?.hasX402Schema;
    const hasValidSchema = hasX402SchemaValue === true || (typeof hasX402SchemaValue === 'boolean' && hasX402SchemaValue);
    const isDisabled = paying || loading || !hasValidSchema || !feeConfig?.paymentRecipient || !walletAddress;
    console.log('Pay & Promote button state:', {
      isDisabled,
      paying,
      loading,
      hasValidSchema,
      hasX402SchemaValue,
      hasX402SchemaType: typeof hasX402SchemaValue,
      schema: schema ? { hasX402Schema: schema.hasX402Schema, schemaKeys: Object.keys(schema) } : null,
      hasRecipient: !!feeConfig?.paymentRecipient,
      walletAddress,
    });
  }, [paying, loading, schema, feeConfig?.paymentRecipient, walletAddress]);

  const validateSchema = async () => {
    if (!resourceUrl.trim()) {
      setError("Resource URL is required");
      return;
    }

    setValidating(true);
    setError(null);
    setSchema(null);

    try {
      // Validate both GET and POST methods
      const methods = ['GET', 'POST'];
      const validationResults = await Promise.all(
        methods.map(async (method) => {
          try {
            const response = await fetch("/api/discover/schema", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                url: resourceUrl.trim(),
                method,
              }),
            });

            const data = await response.json();
            if (await checkAuthError(response, data)) {
              return { method, valid: false, data: null, error: 'Authentication error' };
            }
            if (!response.ok) {
              return { method, valid: false, data: null, error: data.error || "Failed to validate schema" };
            }

            // Check if resource has valid x402 schema
            const hasX402SchemaFlag = data.hasX402Schema === true || data.hasX402Schema === 'true';
            const hasSchemaAccepts = data.schema && (
              Array.isArray(data.schema.accepts) && data.schema.accepts.length > 0 ||
              data.schema.x402Version !== undefined
            );
            const hasValidSchema = hasX402SchemaFlag || hasSchemaAccepts;

            return { method, valid: hasValidSchema, data, error: null };
          } catch (err) {
            return { method, valid: false, data: null, error: err instanceof Error ? err.message : "Validation failed" };
          }
        })
      );

      // Find the first valid result (prefer GET, then POST)
      const validResult = validationResults.find(r => r.valid);
      const supportedMethods = validationResults.filter(r => r.valid).map(r => r.method);
      
      console.log('Schema validation results:', {
        getResult: validationResults.find(r => r.method === 'GET'),
        postResult: validationResults.find(r => r.method === 'POST'),
        supportedMethods,
        validResult: validResult ? { method: validResult.method, hasData: !!validResult.data } : null,
      });

      if (!validResult) {
        const errors = validationResults.map(r => `${r.method}: ${r.error || 'no valid schema'}`).join('; ');
        throw new Error(`Resource does not have a valid x402 schema for GET or POST methods. ${errors}`);
      }

      // Normalize the schema object to ensure hasX402Schema is a boolean
      setSchema({
        ...validResult.data,
        hasX402Schema: true, // Force to boolean true since validation passed
        supportedMethods, // Store which methods are supported
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Schema validation failed");
    } finally {
      setValidating(false);
    }
  };

  const calculateTotal = (): string => {
    const daysNum = parseInt(days, 10);
    if (!days || isNaN(daysNum) || daysNum < 1 || !feeConfig) {
      return "0";
    }
    const fee = parseFloat(feeConfig.feePerDay);
    const total = fee * daysNum;
    // Format with up to 6 decimal places, remove trailing zeros
    return total.toFixed(6).replace(/\.?0+$/, '');
  };

  const calculateTotalInSmallestUnit = (): bigint => {
    const daysNum = parseInt(days, 10);
    if (!days || isNaN(daysNum) || daysNum < 1 || !feeConfig) {
      return 0n;
    }
    const fee = parseFloat(feeConfig.feePerDay);
    const total = fee * daysNum;
    // Convert to smallest USDC unit (6 decimals)
    return BigInt(Math.floor(total * 1e6));
  };

  const handlePayment = async () => {
    console.log('handlePayment called', { days, feeConfig, walletAddress, schema });
    
    if (!days || !feeConfig || !walletAddress) {
      const missing: string[] = [];
      if (!days) missing.push('days');
      if (!feeConfig) missing.push('feeConfig');
      if (!walletAddress) missing.push('walletAddress');
      setError(`Missing required information: ${missing.join(', ')}`);
      return;
    }

    const daysNum = parseInt(days, 10);
    if (isNaN(daysNum) || daysNum < 1) {
      setError("Days must be a positive number");
      return;
    }

    if (!feeConfig.paymentRecipient) {
      setError("Promotion payment recipient not configured. Please contact support.");
      return;
    }

    const totalAmount = calculateTotalInSmallestUnit();
    const totalAmountDecimal = calculateTotal();

    // Check balance - balance is in decimal format (e.g., "0.089"), convert to smallest unit
    if (balance === null || balance === undefined) {
      setError("Balance not loaded. Please wait a moment and try again.");
      return;
    }
    
    const balanceDecimal = parseFloat(balance);
    if (isNaN(balanceDecimal)) {
      setError(`Invalid balance format: ${balance}`);
      return;
    }
    
    const balanceBigInt = BigInt(Math.floor(balanceDecimal * 1e6)); // Convert to smallest USDC unit (6 decimals)
    if (balanceBigInt < totalAmount) {
      setError(`Insufficient balance. Required: ${totalAmountDecimal} USDC, Available: ${formatAmountDisplay(balance)} USDC`);
      return;
    }

    setPaying(true);
    setError(null);
    console.log('Starting payment', { totalAmountDecimal, paymentRecipient: feeConfig.paymentRecipient, chainId: feeConfig.chainId });

    try {
      // Make payment
      const response = await fetch("/api/wallet/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          to: feeConfig.paymentRecipient,
          amount: totalAmountDecimal,
          chainId: feeConfig.chainId,
          tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
        }),
      });

      const data = await response.json();
      if (await checkAuthError(response, data)) {
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || "Payment failed");
      }

      if (!data.transactionHash) {
        throw new Error("Payment succeeded but no transaction hash received");
      }

      setPaymentTxHash(data.transactionHash);
      // Automatically create promotion after payment
      await createPromotion(data.transactionHash, daysNum);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed");
      setPaying(false);
    }
  };

  const createPromotion = async (txHash: string, daysNum: number) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/promotions/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          resourceUrl: resourceUrl.trim(),
          agentId,
          days: daysNum,
          paymentTxHash: txHash,
          resourceType,
        }),
      });

      const data = await response.json();
      if (await checkAuthError(response, data)) {
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || "Failed to create promotion");
      }

      setSuccess(true);
      // Close after a short delay
      setTimeout(() => {
        onClose();
        // Reset form
        setDays("7");
        setPaymentTxHash(null);
        setSchema(null);
        setSuccess(false);
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create promotion");
    } finally {
      setLoading(false);
      setPaying(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div style={styles.modal} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ ...styles.modalContent, maxWidth: "600px" }}>
        <div style={styles.modalHeader}>
          <h2 style={styles.modalTitle}>Promote {resourceType === 'agent' ? 'Agent' : 'Resource'}</h2>
          <button
            onClick={onClose}
            style={styles.closeButton}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <form onSubmit={(e) => e.preventDefault()} style={styles.form}>
          <div style={styles.formGroup}>
            <label style={styles.label}>Resource URL</label>
            <input
              type="text"
              value={resourceUrl}
              readOnly
              style={{ ...styles.input, backgroundColor: "#f5f5f5", cursor: "not-allowed" }}
              className="input"
            />
            <div style={styles.hintText}>
              {resourceType === 'agent' && agentId && `Agent ID: ${agentId}`}
            </div>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>
              Validate x402 Schema
              {schema?.hasX402Schema && <span style={{ color: "green", marginLeft: "8px" }}>✓ Valid</span>}
            </label>
            <button
              type="button"
              onClick={validateSchema}
              style={styles.buttonSecondary}
              className="button-secondary"
              disabled={validating}
            >
              {validating ? "Validating..." : "Validate Schema"}
            </button>
            {schema && schema.hasX402Schema && (
              <div style={styles.schemaContainer}>
                <div style={styles.schemaContent}>
                  <div style={styles.successText}>
                    ✓ Resource has valid x402 schema
                  </div>
                  {schema.supportedMethods && schema.supportedMethods.length > 0 && (
                    <div style={styles.hintText}>
                      Supported methods: {schema.supportedMethods.join(', ')}
                    </div>
                  )}
                  {schema.schema?.accepts && Array.isArray(schema.schema.accepts) && (
                    <div style={styles.hintText}>
                      {schema.schema.accepts.length} payment option(s) found
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Number of Days *</label>
            <input
              type="number"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              placeholder="7"
              min="1"
              style={styles.input}
              className="input"
              required
            />
            <div style={styles.hintText}>
              Fee: {feeConfig?.feePerDay || "0.01"} USDC per day
              {days && !isNaN(parseInt(days, 10)) && parseInt(days, 10) > 0 && (
                <span style={{ marginLeft: "8px", fontWeight: 600, color: "#00D4A1" }}>
                  Total: {calculateTotal()} USDC
                </span>
              )}
            </div>
            {balance !== null && (
              <div style={styles.hintText}>
                Available Balance: {formatAmountDisplay(balance)} USDC
              </div>
            )}
          </div>


          {error && <div style={styles.errorText}>{error}</div>}
          {(!schema?.hasX402Schema || !feeConfig?.paymentRecipient || !walletAddress || balance === null) && !paymentTxHash && (
            <div style={{ ...styles.hintText, color: '#ff6b6b', marginTop: '0.5rem' }}>
              {!schema?.hasX402Schema && '⚠ Please validate the x402 schema first. '}
              {!feeConfig?.paymentRecipient && '⚠ Payment recipient not configured. '}
              {!walletAddress && '⚠ Loading wallet address... '}
              {balance === null && '⚠ Loading balance... '}
            </div>
          )}
          {paymentTxHash && (
            <div style={styles.successText}>
              ✓ Payment successful! Transaction: {paymentTxHash.substring(0, 10)}...
            </div>
          )}
          {success && (
            <div style={styles.successText}>
              ✓ Promotion created successfully! Closing...
            </div>
          )}

          <div style={styles.formActions}>
            <button
              type="button"
              onClick={onClose}
              style={styles.buttonSecondary}
              className="button-secondary"
              disabled={loading || paying}
            >
              Cancel
            </button>
            {!paymentTxHash ? (() => {
              const hasX402SchemaValue = schema?.hasX402Schema;
              const hasValidSchema = hasX402SchemaValue === true || (typeof hasX402SchemaValue === 'boolean' && hasX402SchemaValue);
              const isButtonDisabled = paying || loading || !hasValidSchema || !feeConfig?.paymentRecipient || !walletAddress;
              return (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    console.log('Button clicked', { 
                      paying, 
                      loading, 
                      hasSchema: !!schema?.hasX402Schema,
                      schemaHasX402Schema: schema?.hasX402Schema,
                      hasRecipient: !!feeConfig?.paymentRecipient,
                      walletAddress,
                      schema,
                      feeConfig,
                      isButtonDisabled
                    });
                    if (!isButtonDisabled) {
                      handlePayment();
                    }
                  }}
                  style={{
                    ...styles.button,
                    ...(isButtonDisabled ? {
                      opacity: 0.5,
                      cursor: 'not-allowed',
                      background: '#888',
                    } : {})
                  }}
                  className="button"
                  disabled={isButtonDisabled}
                >
                  {paying ? "Processing Payment..." : `Pay & Promote (${calculateTotal()} USDC)`}
                </button>
              );
            })() : (
              <button
                type="button"
                style={styles.button}
                className="button"
                disabled={true}
              >
                {loading ? "Creating Promotion..." : "Creating Promotion..."}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

