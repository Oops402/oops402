export interface Wallet {
  address: string;
  publicKey: string;
  tokenId: string;
}

export interface Balance {
  address: string;
  chainId: number;
  tokenAddress: string;
  balance: string;
  symbol: string;
}

export interface UserProfile {
  sub: string;
  nickname?: string;
  picture?: string;
  email?: string;
  name?: string;
}

export interface DiscoveryItem {
  type: string;
  resource: string;
  x402Version: number;
  accepts: Array<{
    scheme: string;
    description: string;
    network: string;
    maxAmountRequired: string;
    asset: string;
    mimeType?: string;
    payTo?: string;
    maxTimeoutSeconds?: number;
    outputSchema?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  }>;
  lastUpdated: string;
}

export interface DiscoveryResponse {
  success: boolean;
  x402Version: number;
  items: DiscoveryItem[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

export interface PaymentResult {
  success: boolean;
  status: number;
  data: any;
  payment: {
    settled?: boolean;
    transactionHash?: string;
    amount?: string | number;
  };
}

export interface AgentSummary {
  agentId: string;
  chainId: number;
  name: string;
  description?: string;
  image?: string;
  active: boolean;
  owners: string[];
  operators: string[];
  walletAddress?: string;
  mcpTools?: string[];
  a2aSkills?: string[];
  averageScore?: number | null;
}

export interface AgentSearchResponse {
  success: boolean;
  items: AgentSummary[];
  nextCursor?: string;
  meta?: {
    chains: number[];
    successfulChains: number[];
    failedChains: number[];
    totalResults: number;
    timing: {
      totalMs: number;
      averagePerChainMs?: number;
    };
  };
}

