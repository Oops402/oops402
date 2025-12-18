/**
 * Agents Service
 * Handles agent discovery using agent0-sdk
 */

import { SDK } from "agent0-sdk";
import { logger } from "../shared/logger.js";

const AGENT0_CHAIN_ID = parseInt(process.env.AGENT0_CHAIN_ID || "11155111", 10);
const AGENT0_RPC_URL = process.env.AGENT0_RPC_URL || "https://sepolia.infura.io/v3/YOUR_PROJECT_ID";

let sdkInstance: SDK | null = null;

function getSDK(): SDK {
  if (sdkInstance === null) {
    logger.debug("Initializing agent0-sdk", { chainId: AGENT0_CHAIN_ID });
    sdkInstance = new SDK({
      chainId: AGENT0_CHAIN_ID,
      rpcUrl: AGENT0_RPC_URL,
    });
  }
  return sdkInstance;
}

export interface AgentSummary {
  chainId: number;
  agentId: string;
  name: string;
  description?: string;
  image?: string;
  active: boolean;
  owners: string[];
  operators: string[];
  walletAddress?: string;
  mcpTools?: string[];
  a2aSkills?: string[];
}

export interface SearchAgentsParams {
  name?: string;
  mcpTools?: string[];
  a2aSkills?: string[];
  mcpPrompts?: string[];
  mcpResources?: string[];
  supportedTrust?: string[];
  x402support?: boolean;
  active?: boolean;
  ens?: string;
  chains?: number[] | "all";
  pageSize?: number;
  cursor?: string;
  sort?: string[];
}

export interface SearchAgentsResult {
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

/**
 * Search for agents that support x402 payments
 */
export async function searchAgents(params: SearchAgentsParams = {}): Promise<SearchAgentsResult> {
  const sdk = getSDK();
  
  // Always filter by x402 support if not explicitly set
  const searchParams: SearchAgentsParams = {
    ...params,
    x402support: params.x402support !== undefined ? params.x402support : true,
  };

  logger.debug("Searching agents", searchParams as any);

  try {
    const result = await sdk.searchAgents(searchParams as any);
    
    logger.debug("Found agents", { 
      count: result.items.length,
      hasNextCursor: !!result.nextCursor 
    });

    return result;
  } catch (error) {
    logger.error("Failed to search agents", error as Error, searchParams as any);
    throw new Error(`Failed to search agents: ${(error as Error).message}`);
  }
}

/**
 * Get a specific agent by ID
 */
export async function getAgent(agentId: string): Promise<AgentSummary> {
  const sdk = getSDK();
  
  logger.debug("Getting agent", { agentId });

  try {
    const agent = await sdk.getAgent(agentId);
    
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    
    logger.debug("Got agent", { agentId, name: agent.name });
    
    return agent;
  } catch (error) {
    logger.error("Failed to get agent", error as Error, { agentId });
    throw new Error(`Failed to get agent ${agentId}: ${(error as Error).message}`);
  }
}

