// USDC uses 6 decimals on Base network
export const USDC_DECIMALS = 6;

// Format raw token amount (in smallest unit) to human-readable format
export function formatTokenAmount(rawAmount: string, decimals: number = USDC_DECIMALS): string {
  try {
    // Handle bigint strings
    const amount = BigInt(rawAmount);
    const divisor = BigInt(10 ** decimals);
    const whole = amount / divisor;
    const remainder = amount % divisor;
    
    // Format with proper decimals
    if (remainder === 0n) {
      return whole.toString();
    }
    
    const remainderStr = remainder.toString().padStart(decimals, '0');
    // Remove trailing zeros
    const trimmed = remainderStr.replace(/0+$/, '');
    return `${whole}.${trimmed}`;
  } catch (error) {
    // If parsing fails, return original
    console.error("Failed to format token amount:", error);
    return rawAmount;
  }
}

// Format amount with locale-specific formatting
export function formatAmountDisplay(amount: string, decimals: number = USDC_DECIMALS): string {
  const formatted = formatTokenAmount(amount, decimals);
  const num = parseFloat(formatted);
  if (isNaN(num)) return formatted;
  
  // Format with appropriate decimal places (2-6 for USDC)
  return num.toLocaleString("en-US", { 
    minimumFractionDigits: 0, 
    maximumFractionDigits: decimals 
  });
}

// Format balance for display
export function formatBalance(balance: string | undefined): string {
  if (!balance) return "0.00";
  const num = parseFloat(balance);
  if (isNaN(num)) return "0.00";
  return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

// Truncate address for display
export function truncateAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Get blockchain explorer URL for a transaction hash
export function getExplorerUrl(chainId: number, txHash: string): string {
  const explorers: Record<number, string> = {
    1: "https://etherscan.io/tx",
    10: "https://optimistic.etherscan.io/tx",
    137: "https://polygonscan.com/tx",
    42161: "https://arbiscan.io/tx",
    8453: "https://basescan.org/tx",
  };
  
  const baseUrl = explorers[chainId] || `https://explorer.chainid=${chainId}/tx`;
  return `${baseUrl}/${txHash}`;
}

