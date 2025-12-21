import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  CreateMessageRequest,
  CreateMessageResultSchema,
  ElicitResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  LoggingLevel,
  ReadResourceRequestSchema,
  Resource,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  Tool,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod/v4";
import { getPKPsForAuthMethod, mintPKP, getPkpSessionSigs, type PKP, PKPAccount } from "../../wallet/index.js";
import { getBalances, transferToken } from "../../wallet/chainService.js";
import { searchAgents, searchAgentsByReputation, getAgent } from "../../agents/service.js";
import { makePayment } from "../../x402/service.js";
import { queryCachedResources, findResourcesByPayTo } from "../../x402/bazaarService.js";
import { getSessionOwner } from "./redisTransport.js";
import { readMcpInstallation } from "../../auth/services/auth.js";
import { logger } from "../../shared/logger.js";
import { config } from "../../../config.js";

type ToolInput = Tool["inputSchema"];

// USDC uses 6 decimals on Base network
const USDC_DECIMALS = 6;

/**
 * Format raw token amount (in smallest unit) to human-readable format
 * @param rawAmount - Amount as string in smallest unit (e.g., "1000000" for 1 USDC)
 * @param decimals - Number of decimals (default: 6 for USDC)
 * @returns Human-readable amount string (e.g., "1.0" for 1 USDC)
 */
function formatTokenAmount(rawAmount: string, decimals: number = USDC_DECIMALS): string {
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
    logger.debug("Failed to format token amount", { rawAmount, error });
    return rawAmount;
  }
}

/**
 * Format amount with locale-specific formatting for display
 * @param amount - Amount as string in smallest unit
 * @param decimals - Number of decimals (default: 6 for USDC)
 * @returns Formatted amount string (e.g., "1.0" or "1,234.56")
 */
function formatAmountDisplay(amount: string, decimals: number = USDC_DECIMALS): string {
  const formatted = formatTokenAmount(amount, decimals);
  const num = parseFloat(formatted);
  if (isNaN(num)) return formatted;
  
  // Format with appropriate decimal places (0-6 for USDC)
  return num.toLocaleString("en-US", { 
    minimumFractionDigits: 0, 
    maximumFractionDigits: decimals 
  });
}

// Helper to convert Zod schema to JSON schema using Zod v4's native support
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toJsonSchema = (schema: z.ZodType<any>): ToolInput => {
  return z.toJSONSchema(schema) as ToolInput;
};

/* Input schemas for tools implemented in this server */
const EchoSchema = z.object({
  message: z.string().describe("Message to echo"),
});


const WalletGetSchema = z.object({});

const DiscoverAgentsSchema = z.object({
  // Search mode
  searchByReputation: z.boolean().optional().describe("Use reputation-based search instead of regular search"),
  
  // Regular search parameters
  name: z.string().optional().describe("Search by name (substring match)"),
  mcp: z.boolean().optional().describe("Filter agents with MCP endpoints"),
  a2a: z.boolean().optional().describe("Filter agents with A2A endpoints"),
  mcpTools: z.array(z.string()).optional().describe("Filter by MCP tools (array of tool names)"),
  a2aSkills: z.array(z.string()).optional().describe("Filter by A2A skills (array of skill names)"),
  mcpPrompts: z.array(z.string()).optional().describe("Filter by MCP prompts (array of prompt names)"),
  mcpResources: z.array(z.string()).optional().describe("Filter by MCP resources (array of resource URIs)"),
  supportedTrust: z.array(z.string()).optional().describe("Filter by supported trust mechanisms"),
  x402support: z.boolean().optional().describe("Filter agents with x402 support (default: true)"),
  active: z.boolean().optional().describe("Filter by active status"),
  ens: z.string().optional().describe("Filter by ENS name"),
  chains: z.union([
    z.array(z.number()),
    z.literal("all"),
  ]).optional().describe("Chain IDs to search (array of numbers or 'all')"),
  
  // Reputation search parameters
  tags: z.array(z.string()).optional().describe("Filter by tags (for reputation search)"),
  minAverageScore: z.number().optional().describe("Minimum average score (0-100, for reputation search)"),
  includeRevoked: z.boolean().optional().describe("Include revoked feedback (for reputation search, default: false)"),
  
  // Pagination
  pageSize: z.number().optional().describe("Number of results per page (default: 50)"),
  cursor: z.string().optional().describe("Pagination cursor for next page"),
  sort: z.array(z.string()).optional().describe("Sort order (e.g., ['createdAt:desc'])"),
});

const AgentListToolsSchema = z.object({
  agentId: z.string().describe("Agent ID (format: 'chainId:agentId' or just 'agentId' for default chain)"),
});

const PaySchema = z.object({
  resourceUrl: z.string().url().describe("URL of the resource/service requiring x402 payment"),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().describe("HTTP method (default: GET)"),
  body: z.string().optional().describe("Request body (for POST/PUT requests)"),
  headers: z.record(z.string(), z.string()).optional().describe("Additional HTTP headers"),
  walletAddress: z.string().optional().describe("Wallet address to use (defaults to first wallet)"),
});

const WalletBalanceSchema = z.object({
  walletAddress: z.string().optional().describe("x402 Wallet address to check (defaults to first wallet)"),
  chainId: z.number().optional().describe("Chain ID (defaults to 8453 for Base)"),
  tokenAddress: z.string().optional().describe("ERC20 token address (defaults to USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)"),
});

const WalletTransferTokenSchema = z.object({
  to: z.string().describe("Recipient address"),
  amount: z.string().describe("Amount of token to transfer (e.g., '100.5' for 100.5 tokens)"),
  walletAddress: z.string().optional().describe("x402 Wallet address to use (defaults to first wallet)"),
  chainId: z.number().optional().describe("Chain ID (defaults to 8453 for Base)"),
  tokenAddress: z.string().optional().describe("ERC20 token address (defaults to USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)"),
});

const DiscoverBazaarResourcesSchema = z.object({
  type: z.string().optional().describe("Filter by protocol type (e.g., 'http', 'mcp')"),
  resource: z.string().optional().describe("Filter by resource URL substring"),
  keyword: z.string().optional().describe("Search keyword - matches resource URL or description"),
  limit: z.number().optional().describe("Maximum number of results to return (default: 50)"),
  offset: z.number().optional().describe("Offset for pagination (default: 0)"),
  sortBy: z.enum(['price_asc', 'price_desc']).optional().describe("Sort by price: 'price_asc' for low to high, 'price_desc' for high to low"),
});

const PaymentHistorySchema = z.object({
  walletAddress: z.string().optional().describe("x402 Wallet address to get payment history for (defaults to first wallet)"),
  pageSize: z.number().optional().describe("Number of results per page (default: 10)"),
  page: z.number().optional().describe("Page number (default: 0)"),
  timeframe: z.number().optional().describe("Timeframe in days (default: 30)"),
});

enum ToolName {
  ECHO = "echo",
  WALLET_GET = "get_x402_wallet",
  WALLET_BALANCE = "get_x402_wallet_balance",
  WALLET_TRANSFER = "transfer_x402_token",
  DISCOVER_AGENTS = "discover_x402_agents",
  AGENT_LIST_TOOLS = "list_x402_agent_tools",
  PAY = "make_x402_payment",
  DISCOVER_BAZAAR_RESOURCES = "search_x402_bazaar_resources",
  PAYMENT_HISTORY = "get_x402_payment_history",
}

enum PromptName {
  SIMPLE = "simple_prompt",
  COMPLEX = "complex_prompt",
  RESOURCE = "resource_prompt",
}

interface McpServerWrapper {
  server: Server;
  cleanup: () => void;
}

export const createMcpServer = (sessionId?: string): McpServerWrapper => {
  const server = new Server(
    {
      name: "example-servers/feature-reference",
      version: "1.0.0",
    },
    {
      capabilities: {
        prompts: {},
        resources: { subscribe: true },
        tools: {},
        logging: {},
        completions: {},
      },
    }
  );

  const subscriptions: Set<string> = new Set();

  // Set up update interval for subscribed resources
  const subsUpdateInterval = setInterval(() => {
    for (const uri of subscriptions) {
      server.notification({
        method: "notifications/resources/updated",
        params: { uri },
      });
    }
  }, 10000);

  let logLevel: LoggingLevel = "debug";
  const messages = [
    { level: "debug", data: "Debug-level message" },
    { level: "info", data: "Info-level message" },
    { level: "notice", data: "Notice-level message" },
    { level: "warning", data: "Warning-level message" },
    { level: "error", data: "Error-level message" },
    { level: "critical", data: "Critical-level message" },
    { level: "alert", data: "Alert level-message" },
    { level: "emergency", data: "Emergency-level message" },
  ];

  const isMessageIgnored = (level: LoggingLevel): boolean => {
    const currentLevel = messages.findIndex((msg) => logLevel === msg.level);
    const messageLevel = messages.findIndex((msg) => level === msg.level);
    return messageLevel < currentLevel;
  };

  // Set up update interval for random log messages
  const logsUpdateInterval = setInterval(() => {
    const message = {
      method: "notifications/message",
      params: messages[Math.floor(Math.random() * messages.length)],
    };
    if (!isMessageIgnored(message.params.level as LoggingLevel))
      server.notification(message);
  }, 20000);


  // Set up update interval for stderr messages
  const stdErrUpdateInterval = setInterval(() => {
    const shortTimestamp = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    server.notification({
      method: "notifications/stderr",
      params: { content: `${shortTimestamp}: A stderr message` },
    });
  }, 30000);


  const ALL_RESOURCES: Resource[] = Array.from({ length: 100 }, (_, i) => {
    const uri = `test://static/resource/${i + 1}`;
    if (i % 2 === 0) {
      return {
        uri,
        name: `Resource ${i + 1}`,
        mimeType: "text/plain",
        text: `Resource ${i + 1}: This is a plaintext resource`,
      };
    } else {
      const buffer = Buffer.from(`Resource ${i + 1}: This is a base64 blob`);
      return {
        uri,
        name: `Resource ${i + 1}`,
        mimeType: "application/octet-stream",
        blob: buffer.toString("base64"),
      };
    }
  });

  const PAGE_SIZE = 10;

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    let startIndex = 0;

    if (cursor) {
      const decodedCursor = parseInt(atob(cursor), 10);
      if (!isNaN(decodedCursor)) {
        startIndex = decodedCursor;
      }
    }

    const endIndex = Math.min(startIndex + PAGE_SIZE, ALL_RESOURCES.length);
    const resources = ALL_RESOURCES.slice(startIndex, endIndex);

    let nextCursor: string | undefined;
    if (endIndex < ALL_RESOURCES.length) {
      nextCursor = btoa(endIndex.toString());
    }

    return {
      resources,
      nextCursor,
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: [
        {
          uriTemplate: "test://static/resource/{id}",
          name: "Static Resource",
          description: "A static resource with a numeric ID",
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    if (uri.startsWith("test://static/resource/")) {
      const index = parseInt(uri.split("/").pop() ?? "", 10) - 1;
      if (index >= 0 && index < ALL_RESOURCES.length) {
        const resource = ALL_RESOURCES[index];
        return {
          contents: [resource],
        };
      }
    }


    throw new Error(`Unknown resource: ${uri}`);
  });

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const { uri } = request.params;
    subscriptions.add(uri);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: PromptName.SIMPLE,
          description: "A prompt without arguments",
        },
        {
          name: PromptName.COMPLEX,
          description: "A prompt with arguments",
          arguments: [
            {
              name: "temperature",
              description: "Temperature setting",
              required: true,
            },
            {
              name: "style",
              description: "Output style",
              required: false,
            },
          ],
        },
        {
          name: PromptName.RESOURCE,
          description: "A prompt that includes an embedded resource reference",
          arguments: [
            {
              name: "resourceId",
              description: "Resource ID to include (1-100)",
              required: true,
            },
          ],
        },
      ],
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === PromptName.SIMPLE) {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "This is a simple prompt without arguments.",
            },
          },
        ],
      };
    }

    if (name === PromptName.COMPLEX) {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `This is a complex prompt with arguments: temperature=${args?.temperature}, style=${args?.style}`,
            },
          },
          {
            role: "assistant",
            content: {
              type: "text",
              text: "I understand. You've provided a complex prompt with temperature and style arguments. How would you like me to proceed?",
            },
          },
        ],
      };
    }

    if (name === PromptName.RESOURCE) {
      const resourceId = parseInt(args?.resourceId as string, 10);
      if (isNaN(resourceId) || resourceId < 1 || resourceId > 100) {
        throw new Error(
          `Invalid resourceId: ${args?.resourceId}. Must be a number between 1 and 100.`
        );
      }

      const resourceIndex = resourceId - 1;
      const resource = ALL_RESOURCES[resourceIndex];

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `This prompt includes Resource ${resourceId}. Please analyze the following resource:`,
            },
          },
          {
            role: "user",
            content: {
              type: "resource",
              resource: resource,
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [
      {
        name: ToolName.ECHO,
        description: "Echoes back the input",
        inputSchema: toJsonSchema(EchoSchema),
      },
      {
        name: ToolName.WALLET_GET,
        description: "Get or create x402 wallet for the authenticated agent/user (returns the first wallet, creates one if none exists)",
        inputSchema: toJsonSchema(WalletGetSchema),
      },
      {
        name: ToolName.DISCOVER_AGENTS,
        description: "Discover agents and services that support x402 payments. Supports both regular search (by name, MCP/A2A endpoints, tools, skills, etc.) and reputation-based search (by tags, ratings, etc.). Use searchByReputation=true for reputation search.",
        inputSchema: toJsonSchema(DiscoverAgentsSchema),
      },
      {
        name: ToolName.AGENT_LIST_TOOLS,
        description: "List capabilities/tools available from a specific agent",
        inputSchema: toJsonSchema(AgentListToolsSchema),
      },
      {
        name: ToolName.PAY,
        description: "Make x402 payment to a protected resource/service",
        inputSchema: toJsonSchema(PaySchema),
      },
      {
        name: ToolName.WALLET_BALANCE,
        description: "Get ETH and USDC balances for an x402 wallet on Base network",
        inputSchema: toJsonSchema(WalletBalanceSchema),
      },
      {
        name: ToolName.WALLET_TRANSFER,
        description: "Transfer ERC20 token on any EVM chain (defaults to USDC on Base)",
        inputSchema: toJsonSchema(WalletTransferTokenSchema),
      },
      {
        name: ToolName.DISCOVER_BAZAAR_RESOURCES,
        description: "Discover x402-protected resources from the Facilitator's Bazaar. Returns pay-per-use services and APIs that require payment to access. Each resource includes payment options with prices in both raw format (for calculations) and human-readable USDC format (for display). Supports filtering by type, resource URL, keyword, and sorting by price (low to high or high to low). Use the 'resource' URL with 'make_x402_payment' tool to access services.",
        inputSchema: toJsonSchema(DiscoverBazaarResourcesSchema),
      },
      {
        name: ToolName.PAYMENT_HISTORY,
        description: "Get recent payment history for an x402 wallet address using x402scan. Returns a list of payments made by the wallet, including transaction hashes, amounts, recipients, timestamps, and other payment details.",
        inputSchema: toJsonSchema(PaymentHistorySchema),
      },
    ];

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    
    // Extract authInfo from extra (passed through Redis messages)
    const authInfo = extra?.authInfo;

    if (name === ToolName.ECHO) {
      const validatedArgs = EchoSchema.parse(args);
      return {
        content: [{ type: "text", text: `Echo: ${validatedArgs.message}` }],
      };
    }

    // Helper function to get user context from authInfo (passed through Redis messages)
    // No need to store tokens - they come with each request
    const getUserContext = async (authInfo?: AuthInfo) => {
      if (!sessionId) {
        throw new Error("Session ID required for wallet operations");
      }
      const userId = await getSessionOwner(sessionId);
      if (!userId) {
        throw new Error("User ID not found for session");
      }
      
      // Get access token from authInfo (passed through Redis message)
      const accessToken = authInfo?.token;
      if (!accessToken) {
        logger.error("Access token not found in request", undefined, { sessionId, userId });
        throw new Error("Access token not found in request. Please re-authenticate.");
      }
      
      logger.debug("Reading MCP installation", { sessionId, userId, accessTokenLength: accessToken.length });
      const installation = await readMcpInstallation(accessToken);
      
      let oauthAccessToken: string;
      if (installation) {
        // Internal auth mode: use the upstream OAuth token from the installation
        oauthAccessToken = installation.mockUpstreamInstallation.mockUpstreamAccessToken;
        logger.debug("Using OAuth token from MCP installation", { sessionId, userId });
      } else if (config.auth.mode === 'external') {
        // External auth mode (e.g., Auth0): use the access token directly
        // In external mode, the access token is the OAuth token (e.g., Auth0 JWT)
        oauthAccessToken = accessToken;
        logger.debug("Using access token directly (external auth mode)", { 
          sessionId, 
          userId, 
          authMode: config.auth.mode,
          provider: config.auth.provider
        });
      } else {
        // Internal mode but installation not found - this shouldn't happen
        logger.error("MCP installation not found", undefined, { 
          sessionId, 
          userId, 
          accessTokenLength: accessToken.length,
          authMode: config.auth.mode
        });
        throw new Error(`Installation not found for access token. Token may be invalid or expired. Please re-authenticate.`);
      }
      
      return { userId, oauthAccessToken };
    };

    if (name === ToolName.WALLET_GET) {
      try {
        WalletGetSchema.parse(args);
        const { userId, oauthAccessToken } = await getUserContext(authInfo);
        
        logger.debug("Getting or creating wallet", { userId });
        let pkps = await getPKPsForAuthMethod(userId);
        
        // If no wallet exists, create one
        let pkp;
        if (pkps.length === 0) {
          logger.debug("No wallet found, creating new wallet", { userId });
          pkp = await mintPKP(userId, oauthAccessToken);
        } else {
          // Use the first wallet
          pkp = pkps[0];
        }
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                wallet: {
                  address: pkp.ethAddress,
                  publicKey: pkp.publicKey,
                  tokenId: pkp.tokenId,
                },
                managementUrl: `${config.baseUri}/wallet`,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Failed to get or create wallet", error as Error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error getting or creating wallet: ${(error as Error).message}`,
            },
          ],
        };
      }
    }

    if (name === ToolName.DISCOVER_AGENTS) {
      try {
        const validatedArgs = DiscoverAgentsSchema.parse(args);
        
        // If searching by reputation, use reputation search
        if (validatedArgs.searchByReputation) {
          const reputationParams: any = {};
          
          if (validatedArgs.tags) {
            reputationParams.tags = validatedArgs.tags;
          }
          if (validatedArgs.minAverageScore !== undefined) {
            reputationParams.minAverageScore = validatedArgs.minAverageScore;
          }
          if (validatedArgs.includeRevoked !== undefined) {
            reputationParams.includeRevoked = validatedArgs.includeRevoked;
          }
          if (validatedArgs.a2aSkills) {
            reputationParams.skills = validatedArgs.a2aSkills;
          }
          if (validatedArgs.name) {
            reputationParams.names = [validatedArgs.name];
          }
          if (validatedArgs.chains) {
            reputationParams.chains = validatedArgs.chains;
          }
          if (validatedArgs.pageSize) {
            reputationParams.pageSize = validatedArgs.pageSize;
          }
          if (validatedArgs.cursor) {
            reputationParams.cursor = validatedArgs.cursor;
          }
          if (validatedArgs.sort) {
            reputationParams.sort = validatedArgs.sort;
          }
          
          logger.debug("Discovering agents by reputation", reputationParams);
          const result = await searchAgentsByReputation(reputationParams);
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  agents: result.items.map(agent => ({
                    agentId: agent.agentId,
                    chainId: agent.chainId,
                    name: agent.name,
                    description: agent.description,
                    image: agent.image,
                    mcpTools: agent.mcpTools,
                    a2aSkills: agent.a2aSkills,
                    active: agent.active,
                    owners: agent.owners,
                    operators: agent.operators,
                    walletAddress: agent.walletAddress,
                    averageScore: (agent as any).extras?.averageScore,
                  })),
                  nextCursor: result.nextCursor,
                  meta: result.meta,
                  total: result.items.length,
                }, null, 2),
              },
            ],
          };
        } else {
          // Regular search
          const searchParams: any = {
            x402support: validatedArgs.x402support !== undefined ? validatedArgs.x402support : true,
          };
          
          if (validatedArgs.name) {
            searchParams.name = validatedArgs.name;
          }
          if (validatedArgs.mcp !== undefined) {
            searchParams.mcp = validatedArgs.mcp;
          }
          if (validatedArgs.a2a !== undefined) {
            searchParams.a2a = validatedArgs.a2a;
          }
          if (validatedArgs.mcpTools) {
            searchParams.mcpTools = validatedArgs.mcpTools;
          }
          if (validatedArgs.a2aSkills) {
            searchParams.a2aSkills = validatedArgs.a2aSkills;
          }
          if (validatedArgs.mcpPrompts) {
            searchParams.mcpPrompts = validatedArgs.mcpPrompts;
          }
          if (validatedArgs.mcpResources) {
            searchParams.mcpResources = validatedArgs.mcpResources;
          }
          if (validatedArgs.supportedTrust) {
            searchParams.supportedTrust = validatedArgs.supportedTrust;
          }
          if (validatedArgs.active !== undefined) {
            searchParams.active = validatedArgs.active;
          }
          if (validatedArgs.ens) {
            searchParams.ens = validatedArgs.ens;
          }
          if (validatedArgs.chains) {
            searchParams.chains = validatedArgs.chains;
          }
          if (validatedArgs.pageSize) {
            searchParams.pageSize = validatedArgs.pageSize;
          }
          if (validatedArgs.cursor) {
            searchParams.cursor = validatedArgs.cursor;
          }
          if (validatedArgs.sort) {
            searchParams.sort = validatedArgs.sort;
          }
          
          logger.debug("Discovering agents", searchParams);
          const result = await searchAgents(searchParams);
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  agents: result.items.map(agent => ({
                    agentId: agent.agentId,
                    chainId: agent.chainId,
                    name: agent.name,
                    description: agent.description,
                    image: agent.image,
                    mcpTools: agent.mcpTools,
                    a2aSkills: agent.a2aSkills,
                    active: agent.active,
                    owners: agent.owners,
                    operators: agent.operators,
                    walletAddress: agent.walletAddress,
                  })),
                  nextCursor: result.nextCursor,
                  meta: result.meta,
                  total: result.items.length,
                }, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        logger.error("Agent discovery failed", error as Error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error discovering agents: ${(error as Error).message}`,
            },
          ],
        };
      }
    }

    if (name === ToolName.AGENT_LIST_TOOLS) {
      try {
        const validatedArgs = AgentListToolsSchema.parse(args);
        
        logger.debug("Getting agent tools", { agentId: validatedArgs.agentId });
        const agent = await getAgent(validatedArgs.agentId);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                agentId: agent.agentId,
                name: agent.name,
                mcpTools: agent.mcpTools || [],
                a2aSkills: agent.a2aSkills || [],
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Failed to get agent tools", error as Error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error getting agent tools: ${(error as Error).message}`,
            },
          ],
        };
      }
    }

    if (name === ToolName.PAY) {
      try {
        const validatedArgs = PaySchema.parse(args);
        const { userId, oauthAccessToken } = await getUserContext(authInfo);
        
        // Get user's PKPs
        const pkps = await getPKPsForAuthMethod(userId);
        if (pkps.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "No wallets found. Please create a wallet first using wallet_create.",
              },
            ],
          };
        }
        
        // Find the PKP to use (by address if specified, otherwise first one)
        let pkp: PKP;
        if (validatedArgs.walletAddress) {
          pkp = pkps.find(p => p.ethAddress.toLowerCase() === validatedArgs.walletAddress!.toLowerCase())!;
          if (!pkp) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Wallet address ${validatedArgs.walletAddress} not found.`,
                },
              ],
            };
          }
        } else {
          pkp = pkps[0];
        }
        
        // Get session signatures for the PKP
        logger.debug("Getting PKP session signatures", { pkpAddress: pkp.ethAddress });
        const sessionSigs = await getPkpSessionSigs(userId, oauthAccessToken, pkp);
        
        // Create PKP account
        const pkpAccount = new PKPAccount({
          address: pkp.ethAddress as `0x${string}`,
          publicKey: pkp.publicKey as `0x${string}`,
          sessionSigs,
        });
        
        // Make payment
        logger.debug("Making payment", { resourceUrl: validatedArgs.resourceUrl });
        const { response, paymentResponse } = await makePayment(pkpAccount, validatedArgs.resourceUrl, {
          method: validatedArgs.method,
          body: validatedArgs.body,
          headers: validatedArgs.headers as Record<string, string> | undefined,
        });
        
        // Get response data
        const contentType = response.headers.get("content-type");
        let data: any;
        if (contentType?.includes("application/json")) {
          data = await response.json();
        } else {
          data = await response.text();
        }
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: response.ok,
                status: response.status,
                data,
                payment: paymentResponse ? {
                  settled: true,
                  payer: paymentResponse.from,
                  payee: paymentResponse.to,
                  amount: paymentResponse.value,
                  transactionHash: paymentResponse.transactionHash,
                } : null,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Payment failed", error as Error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error making payment: ${(error as Error).message}`,
            },
          ],
        };
      }
    }

    if (name === ToolName.WALLET_BALANCE) {
      try {
        const validatedArgs = WalletBalanceSchema.parse(args);
        const { userId, oauthAccessToken } = await getUserContext(authInfo);
        
        // Get user's PKPs
        const pkps = await getPKPsForAuthMethod(userId);
        if (pkps.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "No wallets found. Please create a wallet first using wallet_create.",
              },
            ],
          };
        }
        
        // Find the PKP to use (by address if specified, otherwise first one)
        let pkp: PKP;
        if (validatedArgs.walletAddress) {
          pkp = pkps.find(p => p.ethAddress.toLowerCase() === validatedArgs.walletAddress!.toLowerCase())!;
          if (!pkp) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Wallet address ${validatedArgs.walletAddress} not found.`,
                },
              ],
            };
          }
        } else {
          pkp = pkps[0];
        }
        
        // Get balances
        logger.debug("Getting wallet balances", { 
          walletAddress: pkp.ethAddress,
          chainId: validatedArgs.chainId,
          tokenAddress: validatedArgs.tokenAddress,
        });
        const balances = await getBalances(pkp.ethAddress as `0x${string}`, {
          chainId: validatedArgs.chainId,
          tokenAddress: validatedArgs.tokenAddress as `0x${string}` | undefined,
        });
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                walletAddress: pkp.ethAddress,
                chainId: balances.chainId,
                tokenAddress: balances.tokenAddress,
                balances: {
                  native: balances.native,
                  token: balances.token,
                },
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Failed to get wallet balances", error as Error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error getting wallet balances: ${(error as Error).message}`,
            },
          ],
        };
      }
    }

    if (name === ToolName.WALLET_TRANSFER) {
      try {
        const validatedArgs = WalletTransferTokenSchema.parse(args);
        const { userId, oauthAccessToken } = await getUserContext(authInfo);
        
        // Get user's PKPs
        const pkps = await getPKPsForAuthMethod(userId);
        if (pkps.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "No wallets found. Please create a wallet first using wallet_create.",
              },
            ],
          };
        }
        
        // Find the PKP to use (by address if specified, otherwise first one)
        let pkp: PKP;
        if (validatedArgs.walletAddress) {
          pkp = pkps.find(p => p.ethAddress.toLowerCase() === validatedArgs.walletAddress!.toLowerCase())!;
          if (!pkp) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Wallet address ${validatedArgs.walletAddress} not found.`,
                },
              ],
            };
          }
        } else {
          pkp = pkps[0];
        }
        
        // Get session signatures for the PKP
        logger.debug("Getting PKP session signatures", { pkpAddress: pkp.ethAddress });
        const sessionSigs = await getPkpSessionSigs(userId, oauthAccessToken, pkp);
        
        // Create PKP account
        const pkpAccount = new PKPAccount({
          address: pkp.ethAddress as `0x${string}`,
          publicKey: pkp.publicKey as `0x${string}`,
          sessionSigs,
        });
        
        // Transfer token
        logger.debug("Transferring token", { 
          from: pkp.ethAddress, 
          to: validatedArgs.to, 
          amount: validatedArgs.amount,
          chainId: validatedArgs.chainId,
          tokenAddress: validatedArgs.tokenAddress,
        });
        const result = await transferToken(
          pkpAccount,
          validatedArgs.to as `0x${string}`,
          validatedArgs.amount,
          {
            chainId: validatedArgs.chainId,
            tokenAddress: validatedArgs.tokenAddress as `0x${string}` | undefined,
            sessionSigs, // Pass sessionSigs for gas sponsorship
          }
        );
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                transactionHash: result.transactionHash,
                from: pkp.ethAddress,
                to: validatedArgs.to,
                amount: validatedArgs.amount,
                chainId: result.chainId,
                tokenAddress: result.tokenAddress,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Token transfer failed", error as Error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error transferring token: ${(error as Error).message}`,
            },
          ],
        };
      }
    }

    if (name === ToolName.DISCOVER_BAZAAR_RESOURCES) {
      try {
        const validatedArgs = DiscoverBazaarResourcesSchema.parse(args);
        
        logger.debug("Discovering bazaar resources", validatedArgs);
        const result = await queryCachedResources({
          type: validatedArgs.type,
          resource: validatedArgs.resource,
          keyword: validatedArgs.keyword,
          limit: validatedArgs.limit,
          offset: validatedArgs.offset,
          sortBy: validatedArgs.sortBy,
        });
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                _meta: {
                  description: "x402 Bazaar Resources - Discover pay-per-use services",
                  fieldNotes: {
                    resource: "URL endpoint to use with 'make_x402_payment' tool",
                    maxAmountRequired: "Raw amount in smallest token unit (string) - use for calculations",
                    maxAmountRequiredFormatted: "Human-readable USDC amount (e.g., '1.0' = 1 USDC) - use for displaying costs to users",
                    network: "Blockchain network - ensure it matches your wallet's network",
                    scheme: "'erc20' = token payment, 'native' = blockchain currency"
                  }
                },
                resources: result.items.map(resource => ({
                  resource: resource.resource,
                  type: resource.type,
                  lastUpdated: resource.lastUpdated,
                  accepts: resource.accepts.map(accept => ({
                    asset: accept.asset,
                    network: accept.network,
                    scheme: accept.scheme,
                    maxAmountRequired: accept.maxAmountRequired,
                    maxAmountRequiredFormatted: formatAmountDisplay(accept.maxAmountRequired),
                    description: accept.description,
                  })),
                  x402Version: resource.x402Version,
                })),
                pagination: {
                  total: result.total,
                  limit: result.limit,
                  offset: result.offset,
                },
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Bazaar resource discovery failed", error as Error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error discovering bazaar resources: ${(error as Error).message}`,
            },
          ],
        };
      }
    }

    if (name === ToolName.PAYMENT_HISTORY) {
      try {
        const validatedArgs = PaymentHistorySchema.parse(args);
        const { userId, oauthAccessToken } = await getUserContext(authInfo);
        
        // Get user's PKPs
        const pkps = await getPKPsForAuthMethod(userId);
        if (pkps.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "No wallets found. Please create a wallet first using get_x402_wallet.",
              },
            ],
          };
        }
        
        // Find the PKP to use (by address if specified, otherwise first one)
        let pkp: PKP;
        if (validatedArgs.walletAddress) {
          pkp = pkps.find(p => p.ethAddress.toLowerCase() === validatedArgs.walletAddress!.toLowerCase())!;
          if (!pkp) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Wallet address ${validatedArgs.walletAddress} not found.`,
                },
              ],
            };
          }
        } else {
          pkp = pkps[0];
        }
        
        // Build x402scan API request
        const pageSize = validatedArgs.pageSize || 10;
        const page = validatedArgs.page || 0;
        const timeframe = validatedArgs.timeframe || 30;
        
        const input = {
          json: {
            pagination: {
              page_size: pageSize,
              page: page,
            },
            senders: {
              include: [pkp.ethAddress.toLowerCase()],
            },
            timeframe: timeframe,
            sorting: {
              id: "block_timestamp",
              desc: true,
            },
          },
        };
        
        logger.debug("Fetching payment history", { 
          walletAddress: pkp.ethAddress,
          pageSize,
          page,
          timeframe,
        });
        
        const apiUrl = `https://www.x402scan.com/api/trpc/public.transfers.list?input=${encodeURIComponent(JSON.stringify(input))}`;
        const response = await fetch(apiUrl);
        
        if (!response.ok) {
          throw new Error(`x402scan API error: ${response.statusText}`);
        }
        
        const data = await response.json() as any;
        const items = data?.result?.data?.json?.items || [];
        const pagination = {
          page: data?.result?.data?.json?.page || page,
          pageSize: data?.result?.data?.json?.total_count ? Math.ceil(data.result.data.json.total_count / pageSize) : 0,
          total: data?.result?.data?.json?.total_count || 0,
          hasNextPage: data?.result?.data?.json?.hasNextPage || false,
        };
        
        // Match payments with bazaar resources
        const paymentsWithResources = await Promise.all(
          items.map(async (item: any) => {
            const matchedResources = await findResourcesByPayTo(item.recipient);
            
            // Find the specific accept that matches this payment
            let matchedResource = null;
            let matchedAccept = null;
            
            if (matchedResources.length > 0) {
              // Use the first matching resource (most common case)
              matchedResource = matchedResources[0];
              matchedAccept = matchedResource.accepts.find(
                (accept) => accept.payTo?.toLowerCase() === item.recipient.toLowerCase()
              );
            }
            
            return {
              id: item.id,
              transactionHash: item.tx_hash,
              sender: item.sender,
              recipient: item.recipient,
              amount: item.amount,
              amountFormatted: formatAmountDisplay(item.amount.toString(), item.decimals || 6),
              blockTimestamp: item.block_timestamp,
              chain: item.chain,
              provider: item.provider,
              facilitatorId: item.facilitator_id,
              tokenAddress: item.token_address,
              decimals: item.decimals,
              bazaarResource: matchedResource ? {
                resource: matchedResource.resource,
                type: matchedResource.type,
                description: matchedAccept?.description || matchedResource.accepts[0]?.description,
                payTo: matchedAccept?.payTo || matchedResource.accepts[0]?.payTo,
              } : null,
            };
          })
        );
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                walletAddress: pkp.ethAddress,
                payments: paymentsWithResources,
                pagination,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Payment history fetch failed", error as Error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error fetching payment history: ${(error as Error).message}`,
            },
          ],
        };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  server.setRequestHandler(CompleteRequestSchema, async (request) => {
    const { ref, argument } = request.params;

    if (ref.type === "ref/resource") {
      return { completion: { values: [], hasMore: false, total: 0 } };
    }

    if (ref.type === "ref/prompt") {
      return { completion: { values: [], hasMore: false, total: 0 } };
    }

    throw new Error(`Unknown reference type`);
  });

  server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    const { level } = request.params;
    logLevel = level;

    // Demonstrate different log levels
    await server.notification({
      method: "notifications/message",
      params: {
        level: "debug",
        logger: "test-server",
        data: `Logging level set to: ${logLevel}`,
      },
    });

    return {};
  });

  const cleanup = async () => {
    if (subsUpdateInterval) clearInterval(subsUpdateInterval);
    if (logsUpdateInterval) clearInterval(logsUpdateInterval);
    if (stdErrUpdateInterval) clearInterval(stdErrUpdateInterval);
  };

  return { server, cleanup };
};
