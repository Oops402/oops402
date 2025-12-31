/**
 * MCP Feature Reference Server - Unified Entry Point
 *
 * This server demonstrates the recommended pattern for MCP servers with OAuth:
 * - Auth functionality is always architecturally separate from MCP
 * - In 'internal' mode: Auth server runs in-process for convenience
 * - In 'external' mode: Auth server runs separately (Auth0, Okta, or standalone)
 *
 * The auth module acts as a stand-in for an external OAuth server, even when
 * running internally. This is NOT the deprecated integrated auth pattern.
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { AuthModule } from './modules/auth/index.js';
import { MCPModule } from './modules/mcp/index.js';
import { Auth0TokenValidator, ExternalTokenValidator, InternalTokenValidator, ITokenValidator } from './interfaces/auth-validator.js';
import { redisClient } from './modules/shared/redis.js';
import { logger } from './modules/shared/logger.js';
import { crawlAllResources, queryCachedResources, findResourcesByPayTo } from './modules/x402/bazaarService.js';
import { createWebAuthMiddleware, getUserId, getAccessToken } from './modules/auth/webAuth.js';
import { getPKPsForAuthMethod, mintPKP, getPkpSessionSigs, PKPAccount, initializeLitServices } from './modules/wallet/index.js';
import { getBalances, transferToken } from './modules/wallet/chainService.js';
import { searchAgents, searchAgentsByReputation } from './modules/agents/service.js';
import { makePayment } from './modules/x402/service.js';
import {
  getUserPreferences,
  setUserPreferences,
  getBudgetLimits,
  getDiscoveryFilters,
  getSessionSpent,
  addSessionSpent,
  resetSessionSpent,
  getRemainingBudget,
} from './modules/preferences/service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  // Determine server type based on auth mode
  const isAuthServerOnly = config.auth.mode === 'auth_server';
  const serverType = isAuthServerOnly ? 'OAuth Authorization Server' : 'MCP Feature Reference Server';

  console.log('');
  console.log('========================================');
  console.log(serverType);
  console.log('========================================');

  const app = express();

  // Trust proxy for accurate client IP detection behind Fly.io load balancer
  // Set to 1 to trust only the first proxy (Fly.io's load balancer)
  app.set('trust proxy', 1);

  // Basic middleware
  // Intentionally permissive CORS for public MCP reference server
  // This allows any MCP client to test against this reference implementation
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(logger.middleware());

  // Web Auth middleware (only if not in auth_server mode and web auth is configured)
  // Mount this BEFORE other routes to ensure /login, /logout, /callback are registered
  let webAuth: ReturnType<typeof createWebAuthMiddleware> | null = null;
  if (config.auth.mode !== 'auth_server' && config.auth.web) {
    try {
      webAuth = createWebAuthMiddleware();
      // Mount the auth middleware - this registers /login, /logout, /callback routes
      app.use(webAuth.authMiddleware);
      console.log('✓ Web auth middleware mounted - routes /login, /logout, /callback should be available');
      logger.info('Web auth middleware mounted', {
        baseURL: config.auth.web.baseURL,
        issuerBaseURL: config.auth.web.issuerBaseURL
      });
    } catch (error) {
      console.error('✗ Failed to mount web auth middleware:', error);
      logger.error('Web auth middleware not configured', error as Error);
    }
  } else {
    if (config.auth.mode === 'auth_server') {
      console.log('Skipping web auth middleware (auth_server mode)');
    } else if (!config.auth.web) {
      console.log('Skipping web auth middleware (web auth not configured - set AUTH0_WEB_CLIENT_ID)');
    }
  }

  // Connect to Redis if configured
  if (config.redis.enabled && config.redis.url) {
    try {
      await redisClient.connect();
      console.log('Connected to Redis');
    } catch (error) {
      logger.error('Failed to connect to Redis', error as Error);
      if (config.nodeEnv === 'production') {
        process.exit(1);
      }
      console.log('WARNING: Continuing without Redis (development mode)');
    }
  }

  // Initialize Lit services at startup (only for MCP servers, not auth-only servers)
  // This pre-initializes the singleton clients to avoid lazy initialization on first request
  if (config.auth.mode !== 'auth_server') {
    try {
      console.log('Initializing Lit services...');
      await initializeLitServices();
      console.log('✓ Lit services initialized');
    } catch (error) {
      logger.error('Failed to initialize Lit services', error as Error);
      if (config.nodeEnv === 'production') {
        process.exit(1);
      }
      console.log('WARNING: Continuing without Lit services (development mode)');
    }
  }

  // OAuth metadata discovery endpoint
  // Only served by MCP servers (not standalone auth servers)
  if (config.auth.mode !== 'auth_server') {
    app.get('/.well-known/oauth-authorization-server', (req, res) => {
      // Log the metadata discovery request
      logger.info('OAuth metadata discovery', {
        userAgent: req.get('user-agent'),
        authMode: config.auth.mode,
        ip: req.ip
      });

      // Determine the auth server URL based on mode
      const authServerUrl = config.auth.mode === 'internal'
        ? config.baseUri  // Internal mode: auth is in same process
        : (config.auth.provider === 'auth0' && config.auth.auth0Domain
          ? `https://${config.auth.auth0Domain}`
          : config.auth.externalUrl!);  // External mode: separate auth server

      // Build metadata response
      const metadata: Record<string, unknown> = {
        issuer: authServerUrl,
        authorization_endpoint: config.auth.provider === 'auth0' && config.auth.auth0Domain
          ? `https://${config.auth.auth0Domain}/authorize`
          : `${authServerUrl}/authorize`,
        token_endpoint: config.auth.provider === 'auth0' && config.auth.auth0Domain
          ? `https://${config.auth.auth0Domain}/oauth/token`
          : `${authServerUrl}/token`,
        registration_endpoint: config.auth.provider === 'auth0' && config.auth.auth0Domain
          ? undefined  // Auth0 doesn't support dynamic client registration
          : `${authServerUrl}/register`,
        revocation_endpoint: config.auth.provider === 'auth0' && config.auth.auth0Domain
          ? `https://${config.auth.auth0Domain}/oauth/revoke`
          : `${authServerUrl}/revoke`,
        token_endpoint_auth_methods_supported: ['none'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        service_documentation: 'https://modelcontextprotocol.io'
      };

      // Only include introspection_endpoint if not using Auth0 (Auth0 doesn't have one)
      if (config.auth.provider !== 'auth0') {
        metadata.introspection_endpoint = `${authServerUrl}/introspect`;
      }

      res.json(metadata);
    });

    // OAuth Protected Resource metadata endpoint (RFC 8705)
    // This endpoint provides metadata about the protected resource server
    app.get('/.well-known/oauth-protected-resource', (req, res) => {
      logger.info('OAuth protected resource metadata discovery', {
        userAgent: req.get('user-agent'),
        authMode: config.auth.mode,
        ip: req.ip
      });

      // Determine the auth server URL based on mode
      const authServerUrl = config.auth.mode === 'internal'
        ? config.baseUri  // Internal mode: auth is in same process
        : (config.auth.provider === 'auth0' && config.auth.auth0Domain
          ? `https://${config.auth.auth0Domain}`
          : config.auth.externalUrl!);  // External mode: separate auth server

      const resourceMetadata: Record<string, unknown> = {
        resource: config.baseUri,
        authorization_servers: [authServerUrl],
        scopes_supported: ['mcp'],
        bearer_methods_supported: ['header'],
        service_documentation: 'https://modelcontextprotocol.io'
      };

      // Include JWKS URI for Auth0 (for JWT verification)
      if (config.auth.provider === 'auth0' && config.auth.auth0Domain) {
        resourceMetadata.jwks_uri = `https://${config.auth.auth0Domain}/.well-known/jwks.json`;
      }

      res.json(resourceMetadata);
    });
  }

  // Initialize modules based on auth mode
  let tokenValidator: ITokenValidator | undefined;

  if (config.auth.mode === 'internal' || config.auth.mode === 'auth_server') {
    // ========================================
    // INTERNAL MODE or AUTH_SERVER MODE: Mount auth endpoints
    // ========================================
    if (config.auth.mode === 'auth_server') {
      console.log('Mode: STANDALONE AUTH SERVER');
      console.log('   Serving OAuth 2.0 endpoints only');
    } else {
      console.log('Auth Mode: INTERNAL (all-in-one)');
      console.log('   Running auth server in-process for demo/development');
    }
    console.log('');

    // Create auth module
    const authModule = new AuthModule({
      baseUri: config.baseUri,
      authServerUrl: config.baseUri, // Points to itself
      redisUrl: config.redis.url
    });

    // Mount auth routes
    app.use('/', authModule.getRouter());

    // Create internal token validator for MCP (if not auth-only mode)
    if (config.auth.mode === 'internal') {
      tokenValidator = new InternalTokenValidator(authModule);
    }

    console.log('Auth Endpoints:');
    console.log(`   Register Client: POST ${config.baseUri}/register`);
    console.log(`   Authorize: GET ${config.baseUri}/authorize`);
    console.log(`   Get Token: POST ${config.baseUri}/token`);
    console.log(`   Introspect: POST ${config.baseUri}/introspect`);
    console.log(`   Revoke: POST ${config.baseUri}/revoke`);

  } else if (config.auth.mode === 'external') {
    // ========================================
    // EXTERNAL MODE: MCP only, auth elsewhere
    // ========================================
    console.log('Auth Mode: EXTERNAL');
    
    if (config.auth.provider === 'auth0') {
      // Auth0 uses JWT verification (no introspection endpoint)
      if (!config.auth.auth0Domain) {
        throw new Error('AUTH0_DOMAIN must be set when AUTH_PROVIDER=auth0');
      }
      console.log(`   Using Auth0: ${config.auth.auth0Domain}`);
      if (config.auth.auth0Audience) {
        console.log(`   Audience: ${config.auth.auth0Audience}`);
      }
      console.log('');
      
      tokenValidator = new Auth0TokenValidator(
        config.auth.auth0Domain,
        config.auth.auth0Audience
      );
    } else {
      // Generic OAuth provider with introspection endpoint
      console.log(`   Using external auth server: ${config.auth.externalUrl}`);
      console.log('');
      
      tokenValidator = new ExternalTokenValidator(config.auth.externalUrl!);
    }
  }

  // ========================================
  // MCP Module (skip for standalone auth server)
  // ========================================
  if (config.auth.mode !== 'auth_server') {
    if (!tokenValidator) {
      throw new Error('Token validator not initialized');
    }

    const mcpModule = new MCPModule(
      {
        baseUri: config.baseUri,
        redisUrl: config.redis.url
      },
      tokenValidator
    );

    // Mount MCP routes
    app.use('/', mcpModule.getRouter());

    console.log('');
    console.log('MCP Endpoints:');
    console.log(`   Streamable HTTP: ${config.baseUri}/mcp`);
    console.log(`   SSE (legacy): ${config.baseUri}/sse`);
    console.log(`   OAuth Metadata: ${config.baseUri}/.well-known/oauth-authorization-server`);

    // Wallet API routes (protected by web auth)
    if (webAuth) {
      // Rate limiter for wallet API
      const walletApiLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 100, // 100 requests per minute
        message: 'Too many requests to wallet API',
        standardHeaders: true,
        legacyHeaders: false,
      });

      // Get user profile
      app.get('/api/profile', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const user = (req as any).oidc?.user;
          if (!user) {
            return res.status(401).json({ error: 'User not found' });
          }
          res.json({
            success: true,
            user: {
              sub: user.sub,
              nickname: user.nickname,
              picture: user.picture,
              email: user.email,
              name: user.name,
            },
          });
        } catch (error) {
          logger.error('Failed to get user profile', error as Error);
          res.status(500).json({ error: 'Failed to get user profile', message: (error as Error).message });
        }
      });

      // Get or create wallet (single wallet per user)
      app.get('/api/wallet', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const userId = getUserId(req);
          const accessToken = await getAccessToken(req);
          
          if (!userId) {
            logger.warning('User ID not found in request', { hasOidc: !!req.oidc, oidcUser: req.oidc?.user });
            return res.status(401).json({ error: 'User ID not found' });
          }

          if (!accessToken) {
            return res.status(401).json({ error: 'Access token not found' });
          }

          logger.debug('Getting or creating wallet for user', { userId });
          let pkps = await getPKPsForAuthMethod(userId);
          
          // If no wallet exists, create one
          let pkp;
          if (pkps.length === 0) {
            logger.debug('No wallet found, creating new wallet', { userId });
            pkp = await mintPKP(userId, accessToken);
          } else {
            // Use the first wallet
            pkp = pkps[0];
          }
          
          res.json({
            success: true,
            wallet: {
              address: pkp.ethAddress,
              publicKey: pkp.publicKey,
              tokenId: pkp.tokenId,
            },
          });
        } catch (error) {
          logger.error('Failed to get or create wallet', error as Error);
          res.status(500).json({ error: 'Failed to get or create wallet', message: (error as Error).message });
        }
      });

      // Get wallet balance
      app.get('/api/wallet/balance', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const userId = getUserId(req);
          const accessToken = await getAccessToken(req);
          const chainId = Number(req.query.chainId) || 8453; // Default: Base
          const tokenAddress = (req.query.tokenAddress as string) || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base

          if (!userId) {
            return res.status(401).json({ error: 'User ID not found' });
          }

          if (!accessToken) {
            return res.status(401).json({ error: 'Access token not found' });
          }

          // Get or create wallet
          let pkps = await getPKPsForAuthMethod(userId);
          let pkp;
          if (pkps.length === 0) {
            pkp = await mintPKP(userId, accessToken);
          } else {
            pkp = pkps[0];
          }

          logger.debug('Fetching balance', { address: pkp.ethAddress, chainId, tokenAddress });
          const balance = await getBalances(pkp.ethAddress as `0x${string}`, { chainId, tokenAddress: tokenAddress as `0x${string}` | undefined });
          
          res.json({
            success: true,
            address: pkp.ethAddress,
            chainId,
            tokenAddress,
            nativeBalance: balance.native,
            tokenBalance: balance.token,
          });
        } catch (error) {
          logger.error('Failed to fetch balance', error as Error);
          res.status(500).json({ error: 'Failed to fetch balance', message: (error as Error).message });
        }
      });

      // Preferences endpoints
      app.get('/api/preferences', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const userId = getUserId(req);
          if (!userId) {
            return res.status(401).json({ error: 'User ID not found' });
          }

          const preferences = await getUserPreferences(userId);
          const budgetLimits = await getBudgetLimits(userId);
          const discoveryFilters = await getDiscoveryFilters(userId);

          // Format amounts for human-readable display
          const formatUSDC = (atomic: string | null): string | null => {
            if (!atomic) return null;
            const amount = BigInt(atomic);
            const divisor = BigInt(10 ** 6);
            const whole = amount / divisor;
            const remainder = amount % divisor;
            if (remainder === 0n) {
              return whole.toString();
            }
            const remainderStr = remainder.toString().padStart(6, '0');
            const trimmed = remainderStr.replace(/0+$/, '');
            return `${whole}.${trimmed}`;
          };

          res.json({
            success: true,
            preferences: {
              budget: {
                perRequestMax: formatUSDC(budgetLimits.perRequestMaxAtomic),
                sessionBudget: formatUSDC(budgetLimits.sessionBudgetAtomic),
              },
              discovery: {
                onlyPromoted: discoveryFilters.onlyPromoted,
                minAgentScore: discoveryFilters.minAgentScore,
              },
            },
          });
        } catch (error) {
          logger.error('Failed to get preferences', error as Error);
          res.status(500).json({ error: 'Failed to get preferences', message: (error as Error).message });
        }
      });

      app.post('/api/preferences', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const userId = getUserId(req);
          if (!userId) {
            return res.status(401).json({ error: 'User ID not found' });
          }

          const { perRequestMax, sessionBudget, onlyPromoted, minAgentScore } = req.body;

          // Parse human-readable amounts to atomic units
          const parseUSDC = (input: string): string | null => {
            const sanitized = input.replace(/,/g, "").trim();
            if (sanitized === "" || !/^\d*(\.\d{0,6})?$/.test(sanitized)) return null;
            const [whole, fracRaw] = sanitized.split(".");
            const frac = (fracRaw || "").padEnd(6, "0").slice(0, 6);
            try {
              const wholePart = BigInt(whole || "0") * 1000000n;
              const fracPart = BigInt(frac || "0");
              return (wholePart + fracPart).toString();
            } catch {
              return null;
            }
          };

          const preferencesInput: any = {};
          if (perRequestMax !== undefined) {
            const atomic = parseUSDC(perRequestMax);
            if (atomic === null) {
              return res.status(400).json({ error: `Invalid perRequestMax amount: ${perRequestMax}` });
            }
            preferencesInput.perRequestMaxAtomic = atomic;
          }
          if (sessionBudget !== undefined) {
            const atomic = parseUSDC(sessionBudget);
            if (atomic === null) {
              return res.status(400).json({ error: `Invalid sessionBudget amount: ${sessionBudget}` });
            }
            preferencesInput.sessionBudgetAtomic = atomic;
          }
          if (onlyPromoted !== undefined) {
            preferencesInput.onlyPromoted = onlyPromoted;
          }
          if (minAgentScore !== undefined) {
            if (typeof minAgentScore !== 'number' || minAgentScore < 0 || minAgentScore > 100) {
              return res.status(400).json({ error: 'minAgentScore must be a number between 0 and 100' });
            }
            preferencesInput.minAgentScore = minAgentScore;
          }

          await setUserPreferences(userId, preferencesInput);

          // Return updated preferences
          const budgetLimits = await getBudgetLimits(userId);
          const discoveryFilters = await getDiscoveryFilters(userId);

          const formatUSDC = (atomic: string | null): string | null => {
            if (!atomic) return null;
            const amount = BigInt(atomic);
            const divisor = BigInt(10 ** 6);
            const whole = amount / divisor;
            const remainder = amount % divisor;
            if (remainder === 0n) {
              return whole.toString();
            }
            const remainderStr = remainder.toString().padStart(6, '0');
            const trimmed = remainderStr.replace(/0+$/, '');
            return `${whole}.${trimmed}`;
          };

          res.json({
            success: true,
            preferences: {
              budget: {
                perRequestMax: formatUSDC(budgetLimits.perRequestMaxAtomic),
                sessionBudget: formatUSDC(budgetLimits.sessionBudgetAtomic),
              },
              discovery: {
                onlyPromoted: discoveryFilters.onlyPromoted,
                minAgentScore: discoveryFilters.minAgentScore,
              },
            },
          });
        } catch (error) {
          logger.error('Failed to set preferences', error as Error);
          res.status(500).json({ error: 'Failed to set preferences', message: (error as Error).message });
        }
      });

      app.get('/api/preferences/budget', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const userId = getUserId(req);
          if (!userId) {
            return res.status(401).json({ error: 'User ID not found' });
          }

          const budgetLimits = await getBudgetLimits(userId);

          const formatUSDC = (atomic: string | null): string | null => {
            if (!atomic) return null;
            const amount = BigInt(atomic);
            const divisor = BigInt(10 ** 6);
            const whole = amount / divisor;
            const remainder = amount % divisor;
            if (remainder === 0n) {
              return whole.toString();
            }
            const remainderStr = remainder.toString().padStart(6, '0');
            const trimmed = remainderStr.replace(/0+$/, '');
            return `${whole}.${trimmed}`;
          };

          res.json({
            success: true,
            budget: {
              perRequestMax: formatUSDC(budgetLimits.perRequestMaxAtomic),
              sessionBudget: formatUSDC(budgetLimits.sessionBudgetAtomic),
            },
          });
        } catch (error) {
          logger.error('Failed to get budget limits', error as Error);
          res.status(500).json({ error: 'Failed to get budget limits', message: (error as Error).message });
        }
      });

      app.get('/api/preferences/discovery', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const userId = getUserId(req);
          if (!userId) {
            return res.status(401).json({ error: 'User ID not found' });
          }

          const discoveryFilters = await getDiscoveryFilters(userId);

          res.json({
            success: true,
            discovery: {
              onlyPromoted: discoveryFilters.onlyPromoted,
              minAgentScore: discoveryFilters.minAgentScore,
            },
          });
        } catch (error) {
          logger.error('Failed to get discovery filters', error as Error);
          res.status(500).json({ error: 'Failed to get discovery filters', message: (error as Error).message });
        }
      });

      // Session spending endpoints
      app.get('/api/session/spent', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const sessionId = req.sessionID;
          if (!sessionId) {
            return res.status(400).json({ error: 'Session ID not found' });
          }

          const spentAtomic = await getSessionSpent(sessionId);
          
          // Format for human-readable display
          const amount = BigInt(spentAtomic);
          const divisor = BigInt(10 ** 6);
          const whole = amount / divisor;
          const remainder = amount % divisor;
          let spentHuman: string;
          if (remainder === 0n) {
            spentHuman = whole.toString();
          } else {
            const remainderStr = remainder.toString().padStart(6, '0');
            const trimmed = remainderStr.replace(/0+$/, '');
            spentHuman = `${whole}.${trimmed}`;
          }

          res.json({
            success: true,
            spent: spentHuman,
            spentAtomic,
          });
        } catch (error) {
          logger.error('Failed to get session spending', error as Error);
          res.status(500).json({ error: 'Failed to get session spending', message: (error as Error).message });
        }
      });

      app.post('/api/session/spent', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const sessionId = req.sessionID;
          if (!sessionId) {
            return res.status(400).json({ error: 'Session ID not found' });
          }

          const { amountAtomic } = req.body;
          if (!amountAtomic || typeof amountAtomic !== 'string') {
            return res.status(400).json({ error: 'amountAtomic is required and must be a string' });
          }

          await addSessionSpent(sessionId, amountAtomic);

          const spentAtomic = await getSessionSpent(sessionId);
          
          // Format for human-readable display
          const amount = BigInt(spentAtomic);
          const divisor = BigInt(10 ** 6);
          const whole = amount / divisor;
          const remainder = amount % divisor;
          let spentHuman: string;
          if (remainder === 0n) {
            spentHuman = whole.toString();
          } else {
            const remainderStr = remainder.toString().padStart(6, '0');
            const trimmed = remainderStr.replace(/0+$/, '');
            spentHuman = `${whole}.${trimmed}`;
          }

          res.json({
            success: true,
            spent: spentHuman,
            spentAtomic,
          });
        } catch (error) {
          logger.error('Failed to add session spending', error as Error);
          res.status(500).json({ error: 'Failed to add session spending', message: (error as Error).message });
        }
      });

      app.post('/api/session/spent/reset', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const sessionId = req.sessionID;
          if (!sessionId) {
            return res.status(400).json({ error: 'Session ID not found' });
          }

          await resetSessionSpent(sessionId);

          res.json({
            success: true,
            spent: '0',
            spentAtomic: '0',
          });
        } catch (error) {
          logger.error('Failed to reset session spending', error as Error);
          res.status(500).json({ error: 'Failed to reset session spending', message: (error as Error).message });
        }
      });

      // Discover bazaar resources
      app.get('/api/discover/bazaar', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const { type, resource, keyword, limit, offset, sortBy } = req.query;
          
          // Normalize keyword: support both single string and comma-separated or array
          let normalizedKeyword: string | string[] | undefined;
          if (keyword) {
            if (Array.isArray(keyword)) {
              // Already an array
              normalizedKeyword = keyword as string[];
            } else if (typeof keyword === 'string' && keyword.includes(',')) {
              // Comma-separated string - split into array
              normalizedKeyword = keyword.split(',').map(k => k.trim()).filter(k => k.length > 0);
            } else {
              // Single string
              normalizedKeyword = keyword as string;
            }
          }
          
          logger.debug('Discovering bazaar resources', { type, resource, keyword: normalizedKeyword, limit, offset, sortBy });
          
          // Get session ID for analytics (hash it for privacy)
          // Use sessionID if available, otherwise use userId + timestamp as fallback
          const { hashSessionId } = await import('./modules/shared/supabase.js');
          let sessionIdHash: string | undefined;
          
          if (req.sessionID) {
            sessionIdHash = hashSessionId(req.sessionID);
          } else {
            // Fallback: use userId + current hour for session-like tracking
            // This allows tracking even when express-session isn't available
            const userId = getUserId(req);
            if (userId) {
              // Use userId + hour timestamp to create a session-like identifier
              // This groups searches by user within the same hour
              const hourTimestamp = Math.floor(Date.now() / (1000 * 60 * 60)); // Hours since epoch
              const sessionLikeId = `${userId}-${hourTimestamp}`;
              sessionIdHash = hashSessionId(sessionLikeId);
            }
          }
          
          logger.debug('Search tracking check', {
            hasSessionID: !!req.sessionID,
            hasUserId: !!getUserId(req),
            hasSessionIdHash: !!sessionIdHash,
            hasKeyword: !!keyword,
            keyword: keyword as string,
          });
          
          const result = await queryCachedResources({
            type: type as string | undefined,
            resource: resource as string | undefined,
            keyword: keyword as string | undefined,
            limit: limit ? Number(limit) : undefined,
            offset: offset ? Number(offset) : undefined,
            sortBy: sortBy === 'price_asc' || sortBy === 'price_desc' ? sortBy as 'price_asc' | 'price_desc' : undefined,
          }, sessionIdHash);
          
          // Track search analytics (async, don't block)
          if (sessionIdHash && keyword) {
            logger.debug('Attempting to track search', {
              keyword: keyword as string,
              result_count: result.total,
              sessionIdHashPrefix: sessionIdHash.substring(0, 8) + '...',
            });
            const { trackSearch } = await import('./modules/analytics/service.js');
            trackSearch({
              keyword: keyword as string,
              result_count: result.total,
              session_id_hash: sessionIdHash,
            }).catch((err) => {
              logger.error('Failed to track search in endpoint', err as Error, {
                keyword: keyword as string,
                sessionIdHash: sessionIdHash.substring(0, 8) + '...',
              });
            });
          } else {
            logger.debug('Skipping search tracking', {
              reason: !sessionIdHash ? 'no sessionIdHash' : 'no keyword',
              hasSessionIdHash: !!sessionIdHash,
              hasKeyword: !!keyword,
            });
          }
          
          const promotedUrls = result.promotedResourceUrls || new Set<string>();
          
          // Apply onlyPromoted filter if preference is enabled
          let filteredItems = result.items;
          const userId = getUserId(req);
          if (userId) {
            try {
              const discoveryFilters = await getDiscoveryFilters(userId);
              if (discoveryFilters.onlyPromoted) {
                filteredItems = result.items.filter(resource =>
                  promotedUrls.has(resource.resource.toLowerCase())
                );
              }
            } catch (error) {
              logger.debug('Failed to get discovery filters, skipping filter', { error });
            }
          }
          
          res.json({
            success: true,
            x402Version: 1,
            items: filteredItems.map(resource => ({
              resource: resource.resource,
              type: resource.type,
              lastUpdated: resource.lastUpdated,
              promoted: promotedUrls.has(resource.resource.toLowerCase()), // Mark promoted items
              accepts: resource.accepts.map(accept => ({
                asset: accept.asset,
                network: accept.network,
                scheme: accept.scheme,
                maxAmountRequired: accept.maxAmountRequired,
                description: accept.description,
                mimeType: accept.mimeType,
                payTo: accept.payTo,
                maxTimeoutSeconds: accept.maxTimeoutSeconds,
                outputSchema: accept.outputSchema,
                extra: accept.extra,
              })),
              x402Version: resource.x402Version,
            })),
            pagination: {
              total: filteredItems.length,
              limit: result.limit,
              offset: result.offset,
            },
          });
        } catch (error) {
          logger.error('Bazaar resource discovery failed', error as Error);
          res.status(500).json({ error: 'Failed to discover resources', message: (error as Error).message });
        }
      });

      // Discover agents
      app.get('/api/discover/agents', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const { 
            name, 
            mcp,
            a2a,
            mcpTools, 
            a2aSkills,
            mcpPrompts,
            mcpResources,
            supportedTrust,
            x402support,
            active,
            ens,
            chains,
            pageSize,
            cursor,
            sort,
            // Reputation search params
            searchByReputation,
            tags,
            minAverageScore,
            includeRevoked
          } = req.query;
          
          // If searching by reputation, use reputation search
          if (searchByReputation === 'true') {
            const reputationParams: any = {};
            
            if (tags) {
              reputationParams.tags = Array.isArray(tags) ? tags : [tags as string];
            }
            if (minAverageScore !== undefined) {
              reputationParams.minAverageScore = Number(minAverageScore);
            }
            if (includeRevoked !== undefined) {
              reputationParams.includeRevoked = includeRevoked === 'true';
            }
            if (a2aSkills) {
              reputationParams.skills = Array.isArray(a2aSkills) ? a2aSkills : [a2aSkills as string];
            }
            if (name) {
              reputationParams.names = Array.isArray(name) ? name : [name as string];
            }
            if (chains) {
              reputationParams.chains = chains === 'all' ? 'all' : (Array.isArray(chains) ? chains.map(Number) : [Number(chains)]);
            }
            if (pageSize) {
              reputationParams.pageSize = Number(pageSize);
            }
            if (cursor) {
              reputationParams.cursor = cursor as string;
            }
            if (sort) {
              reputationParams.sort = Array.isArray(sort) ? sort : [sort as string];
            }
            
            // Apply user preferences
            const userId = getUserId(req);
            if (userId) {
              try {
                const discoveryFilters = await getDiscoveryFilters(userId);
                // Apply minAgentScore to reputation search if not already set
                if (discoveryFilters.minAgentScore !== null && reputationParams.minAverageScore === undefined) {
                  reputationParams.minAverageScore = discoveryFilters.minAgentScore;
                }
              } catch (error) {
                logger.debug('Failed to get discovery filters, skipping filter', { error });
              }
            }
            
            logger.debug('Discovering agents by reputation', reputationParams);
            const result = await searchAgentsByReputation(reputationParams);
            
            // Get promoted agent IDs for marking and filtering
            const { getActivePromotions } = await import('./modules/promotions/service.js');
            const activePromotions = await getActivePromotions({
              resourceType: 'agent',
            });
            const promotedAgentIds = new Set<string>();
            for (const promotion of activePromotions) {
              if (promotion.agent_id) {
                promotedAgentIds.add(promotion.agent_id.toLowerCase());
              }
            }
            
            // Apply onlyPromoted filter if preference is enabled
            let filteredItems = result.items;
            if (userId) {
              try {
                const discoveryFilters = await getDiscoveryFilters(userId);
                if (discoveryFilters.onlyPromoted) {
                  filteredItems = result.items.filter(agent =>
                    promotedAgentIds.has(agent.agentId.toLowerCase())
                  );
                }
              } catch (error) {
                logger.debug('Failed to apply onlyPromoted filter', { error });
              }
            }
            
            res.json({
              success: true,
              items: filteredItems.map(agent => ({
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
                promoted: promotedAgentIds.has(agent.agentId.toLowerCase()),
              })),
              nextCursor: result.nextCursor,
              meta: result.meta,
            });
          } else {
            // Regular search
          const searchParams: any = {
              x402support: x402support !== undefined ? x402support === 'true' : true,
          };
          
          if (name) {
            searchParams.name = name as string;
          }
            if (mcp !== undefined) {
              searchParams.mcp = mcp === 'true';
            }
            if (a2a !== undefined) {
              searchParams.a2a = a2a === 'true';
            }
          if (mcpTools) {
            searchParams.mcpTools = Array.isArray(mcpTools) ? mcpTools : [mcpTools as string];
          }
            if (a2aSkills) {
              searchParams.a2aSkills = Array.isArray(a2aSkills) ? a2aSkills : [a2aSkills as string];
            }
            if (mcpPrompts) {
              searchParams.mcpPrompts = Array.isArray(mcpPrompts) ? mcpPrompts : [mcpPrompts as string];
            }
            if (mcpResources) {
              searchParams.mcpResources = Array.isArray(mcpResources) ? mcpResources : [mcpResources as string];
            }
            if (supportedTrust) {
              searchParams.supportedTrust = Array.isArray(supportedTrust) ? supportedTrust : [supportedTrust as string];
            }
            if (active !== undefined) {
              searchParams.active = active === 'true';
            }
            if (ens) {
              searchParams.ens = ens as string;
            }
          if (chains) {
            searchParams.chains = chains === 'all' ? 'all' : (Array.isArray(chains) ? chains.map(Number) : [Number(chains)]);
          }
            if (pageSize) {
              searchParams.pageSize = Number(pageSize);
            }
            if (cursor) {
              searchParams.cursor = cursor as string;
            }
            if (sort) {
              searchParams.sort = Array.isArray(sort) ? sort : [sort as string];
            }
          
          logger.debug('Discovering agents', searchParams);
          
          // Get session ID for analytics (hash it for privacy)
          // Use sessionID if available, otherwise use userId + timestamp as fallback
          const { hashSessionId } = await import('./modules/shared/supabase.js');
          let sessionIdHash: string | undefined;
          
          if (req.sessionID) {
            sessionIdHash = hashSessionId(req.sessionID);
          } else {
            // Fallback: use userId + current hour for session-like tracking
            const userId = getUserId(req);
            if (userId) {
              const hourTimestamp = Math.floor(Date.now() / (1000 * 60 * 60)); // Hours since epoch
              const sessionLikeId = `${userId}-${hourTimestamp}`;
              sessionIdHash = hashSessionId(sessionLikeId);
            }
          }
          
          const result = await searchAgents(searchParams, sessionIdHash);
          
          // Get promoted agent IDs for marking and filtering
          const { getActivePromotions } = await import('./modules/promotions/service.js');
          const activePromotions = await getActivePromotions({
            resourceType: 'agent',
            keyword: name as string | undefined,
          });
          const promotedAgentIds = new Set<string>();
          for (const promotion of activePromotions) {
            if (promotion.agent_id) {
              promotedAgentIds.add(promotion.agent_id.toLowerCase());
            }
          }
          
          // Apply user preferences filters
          const userId = getUserId(req);
          let filteredItems = result.items;
          if (userId) {
            try {
              const discoveryFilters = await getDiscoveryFilters(userId);
              
              // Apply onlyPromoted filter
              if (discoveryFilters.onlyPromoted) {
                filteredItems = result.items.filter(agent =>
                  promotedAgentIds.has(agent.agentId.toLowerCase())
                );
              }
              
              // Note: minAgentScore is primarily for reputation search
              // For regular search, we don't have score data, so we skip this filter
            } catch (error) {
              logger.debug('Failed to apply discovery filters', { error });
            }
          }
          
          // Track search analytics (async, don't block)
          if (sessionIdHash && (name || Object.keys(searchParams).length > 1)) {
            const { trackSearch } = await import('./modules/analytics/service.js');
            const searchKeyword = name as string || 'agents';
            trackSearch({
              keyword: searchKeyword,
              result_count: filteredItems.length,
              session_id_hash: sessionIdHash,
            }).catch((err) => {
              logger.error('Failed to track agent search', err as Error);
            });
          }
          
          res.json({
            success: true,
              items: filteredItems.map(agent => ({
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
                promoted: promotedAgentIds.has(agent.agentId.toLowerCase()),
            })),
            nextCursor: result.nextCursor,
              meta: result.meta,
          });
          }
        } catch (error) {
          logger.error('Agent discovery failed', error as Error);
          res.status(500).json({ error: 'Failed to discover agents', message: (error as Error).message });
        }
      });

      // Promotion endpoints
      app.post('/api/promotions/create', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const userId = getUserId(req);
          const { resourceUrl, agentId, days, paymentTxHash, resourceType } = req.body;
          
          if (!resourceUrl || !days || !paymentTxHash) {
            return res.status(400).json({ error: 'Missing required fields: resourceUrl, days, paymentTxHash' });
          }

          if (!Number.isInteger(days) || days < 1) {
            return res.status(400).json({ error: 'Days must be a positive integer' });
          }

          if (!userId) {
            return res.status(401).json({ error: 'User ID not found' });
          }

          // Get user's wallet address for promoted_by_wallet
          const pkps = await getPKPsForAuthMethod(userId);
          if (pkps.length === 0) {
            return res.status(400).json({ error: 'No wallet found. Please create a wallet first.' });
          }

          const { createPromotion } = await import('./modules/promotions/service.js');
          const promotion = await createPromotion({
            resourceUrl,
            agentId,
            promotedByWallet: pkps[0].ethAddress,
            days: Number(days),
            paymentTxHash,
            resourceType: resourceType || (agentId ? 'agent' : 'bazaar'),
          });

          res.json({ success: true, promotion });
        } catch (error) {
          logger.error('Failed to create promotion', error as Error);
          res.status(500).json({ error: 'Failed to create promotion', message: (error as Error).message });
        }
      });

      // Get promotion fee configuration
      app.get('/api/promotions/fee-config', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const { config } = await import('./config.js');
          res.json({
            success: true,
            feePerDay: config.promotion.feePerDay,
            paymentRecipient: config.promotion.paymentRecipient,
            chainId: config.promotion.chainId || 8453,
            currency: 'USDC',
            decimals: 6, // USDC decimals
          });
        } catch (error) {
          logger.error('Failed to get promotion fee config', error as Error);
          res.status(500).json({ error: 'Failed to get fee config' });
        }
      });

      app.get('/api/promotions/my', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const userId = getUserId(req);
          if (!userId) {
            return res.status(401).json({ error: 'User ID not found' });
          }

          // Get user's wallet address
          const pkps = await getPKPsForAuthMethod(userId);
          if (pkps.length === 0) {
            return res.json({ success: true, promotions: [] });
          }

          const { getPromotionsByWallet, getPromotionAnalytics } = await import('./modules/promotions/service.js');
          const promotions = await getPromotionsByWallet(pkps[0].ethAddress, true); // Include inactive

          // Get summary stats for each promotion
          const promotionsWithStats = await Promise.all(
            promotions.map(async (promotion) => {
              const analytics = await getPromotionAnalytics(promotion.id);
              return {
                ...promotion,
                stats: {
                  clicks: analytics.clicks,
                  impressions: analytics.impressions,
                  ctr: analytics.ctr,
                  payments_received: analytics.payments_received,
                  revenue: analytics.payment_volume,
                },
              };
            })
          );

          res.json({ success: true, promotions: promotionsWithStats });
        } catch (error) {
          logger.error('Failed to get my promotions', error as Error);
          res.status(500).json({ error: 'Failed to get promotions', message: (error as Error).message });
        }
      });

      app.get('/api/promotions/analytics/:id', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const { id } = req.params;
          const { getPromotionAnalytics, getPromotionById } = await import('./modules/promotions/service.js');
          
          const promotion = await getPromotionById(id);
          if (!promotion) {
            return res.status(404).json({ error: 'Promotion not found' });
          }

          const analytics = await getPromotionAnalytics(id);
          res.json({ success: true, promotion, analytics });
        } catch (error) {
          logger.error('Failed to get promotion analytics', error as Error);
          res.status(500).json({ error: 'Failed to get analytics', message: (error as Error).message });
        }
      });

      // Analytics endpoints
      app.get('/api/analytics/keywords', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const timeframeDays = req.query.timeframe ? Number(req.query.timeframe) : undefined;
          const limit = req.query.limit ? Number(req.query.limit) : 10;
          
          const { getTopKeywords } = await import('./modules/analytics/service.js');
          const keywords = await getTopKeywords(limit, timeframeDays);
          
          res.json({ success: true, keywords });
        } catch (error) {
          logger.error('Failed to get top keywords', error as Error);
          res.status(500).json({ error: 'Failed to get keywords', message: (error as Error).message });
        }
      });

      app.get('/api/analytics/popular-tools', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const timeframeDays = req.query.timeframe ? Number(req.query.timeframe) : undefined;
          const limit = req.query.limit ? Number(req.query.limit) : 10;
          
          const { getPopularTools } = await import('./modules/analytics/service.js');
          const tools = await getPopularTools(limit, timeframeDays);
          
          res.json({ success: true, tools });
        } catch (error) {
          logger.error('Failed to get popular tools', error as Error);
          res.status(500).json({ error: 'Failed to get popular tools', message: (error as Error).message });
        }
      });

      app.get('/api/analytics/payment-stats', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const timeframeDays = req.query.timeframe ? Number(req.query.timeframe) : undefined;
          
          const { getPaymentStats } = await import('./modules/analytics/service.js');
          const stats = await getPaymentStats(timeframeDays);
          
          res.json({ success: true, stats });
        } catch (error) {
          logger.error('Failed to get payment stats', error as Error);
          res.status(500).json({ error: 'Failed to get payment stats', message: (error as Error).message });
        }
      });

      app.get('/api/analytics/my-promotions-performance', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const userId = getUserId(req);
          if (!userId) {
            return res.status(401).json({ error: 'User ID not found' });
          }

          const timeframeDays = req.query.timeframe ? Number(req.query.timeframe) : undefined;

          // Get user's wallet address
          const pkps = await getPKPsForAuthMethod(userId);
          if (pkps.length === 0) {
            return res.json({
              success: true,
              performance: {
                total_clicks: 0,
                total_impressions: 0,
                average_ctr: 0,
                total_payments_received: 0,
                total_revenue: '0',
                average_conversion_rate: 0,
                top_performing_promotions: [],
              },
            });
          }

          const { getMyPromotionsPerformance } = await import('./modules/analytics/service.js');
          const performance = await getMyPromotionsPerformance(pkps[0].ethAddress, timeframeDays);
          
          res.json({ success: true, performance });
        } catch (error) {
          logger.error('Failed to get my promotions performance', error as Error);
          res.status(500).json({ error: 'Failed to get performance', message: (error as Error).message });
        }
      });

      // Discover x402 schema from a URL
      app.post('/api/discover/schema', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const { url, method = 'GET' } = req.body;
          
          if (!url) {
            return res.status(400).json({ error: 'Missing required field: url' });
          }

          // Use shared validation function
          const { validateX402Resource } = await import('./modules/x402/schemaValidation.js');
          const validation = await validateX402Resource(url, method);

          res.json({
            success: true,
            status: validation.status,
            url,
            hasX402Schema: validation.hasX402Schema,
            schema: validation.schema,
            headers: validation.headers,
            contentType: validation.contentType,
          });
        } catch (error) {
          logger.error('Schema discovery failed', error as Error);
          res.status(500).json({ error: 'Failed to discover schema', message: (error as Error).message });
        }
      });

      // Make x402 payment
      app.post('/api/pay', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const userId = getUserId(req);
          const accessToken = await getAccessToken(req);
          const { resourceUrl, method, body, headers, walletAddress } = req.body;
          
          if (!resourceUrl) {
            return res.status(400).json({ error: 'Missing required field: resourceUrl' });
          }

          if (!userId) {
            return res.status(401).json({ error: 'User ID not found' });
          }

          if (!accessToken) {
            return res.status(401).json({ error: 'Access token not found' });
          }

          // Get user's PKPs
          const pkps = await getPKPsForAuthMethod(userId);
          if (pkps.length === 0) {
            return res.status(400).json({ error: 'No wallets found. Please create a wallet first.' });
          }
          
          // Find the PKP to use (by address if specified, otherwise first one)
          let pkp;
          if (walletAddress) {
            pkp = pkps.find(p => p.ethAddress.toLowerCase() === walletAddress.toLowerCase());
            if (!pkp) {
              return res.status(404).json({ error: `Wallet address ${walletAddress} not found.` });
            }
          } else {
            pkp = pkps[0];
          }
          
          // Get session signatures for the PKP
          logger.debug('Getting PKP session signatures', { pkpAddress: pkp.ethAddress });
          const sessionSigs = await getPkpSessionSigs(userId, accessToken, pkp);
          
          // Create PKP account
          const pkpAccount = new PKPAccount({
            address: pkp.ethAddress as `0x${string}`,
            publicKey: pkp.publicKey as `0x${string}`,
            sessionSigs,
          });
          
          // Make payment
          logger.debug('Making payment', { resourceUrl, method, walletAddress: pkp.ethAddress });
          const { response, paymentResponse } = await makePayment(pkpAccount, resourceUrl, {
            method: method || 'GET',
            body: body,
            headers: headers as Record<string, string> | undefined,
          });
          
          // Get response data
          const contentType = response.headers.get('content-type');
          let data: any;
          if (contentType?.includes('application/json')) {
            data = await response.json();
          } else {
            data = await response.text();
          }
          
          // Track payment for analytics (async, don't block response)
          if (paymentResponse && response.ok && paymentResponse.transactionHash) {
            // Import analytics service
            const { trackPayment, linkPaymentToPromotion } = await import('./modules/analytics/service.js');
            const { hasActivePromotion } = await import('./modules/promotions/service.js');
            
            // Extract network and asset - try from payment response, fall back to defaults
            // Most x402 payments use USDC on Base network
            const network = paymentResponse.network || 'base';
            const asset = paymentResponse.asset || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
            const payerWallet = paymentResponse.from || pkp.ethAddress;
            const amount = paymentResponse.value?.toString() || '0';
            
            // Track the payment
            trackPayment({
              payer_wallet: payerWallet,
              resource_url: resourceUrl,
              amount,
              tx_hash: paymentResponse.transactionHash,
              network,
              asset,
            }).then((paymentId) => {
              // If payment was tracked and resource has active promotion, link them
              if (paymentId) {
                hasActivePromotion(resourceUrl).then((promotion) => {
                  if (promotion) {
                    linkPaymentToPromotion(promotion.id, paymentId);
                  }
                }).catch((err) => {
                  logger.error('Failed to check/link promotion', err as Error);
                });
              }
            }).catch((err) => {
              logger.error('Failed to track payment', err as Error);
            });
          }
          
          res.json({
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
          });
        } catch (error) {
          logger.error('Payment failed', error as Error);
          // Check if it's a token age error - return 401 to trigger re-authentication
          if (error instanceof Error && error.message.includes('Token is too old')) {
            res.status(401).json({ error: 'Authentication required', message: error.message });
          } else {
            res.status(500).json({ error: 'Payment failed', message: (error as Error).message });
          }
        }
      });

      // Transfer tokens
      app.post('/api/wallet/transfer', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const userId = getUserId(req);
          const accessToken = await getAccessToken(req);
          const { to, amount, chainId = 8453, tokenAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' } = req.body;
          
          if (!to || !amount) {
            return res.status(400).json({ error: 'Missing required fields: to, amount' });
          }

          if (!userId) {
            return res.status(401).json({ error: 'User ID not found' });
          }

          if (!accessToken) {
            return res.status(401).json({ error: 'Access token not found' });
          }

          // Get or create wallet
          let pkps = await getPKPsForAuthMethod(userId);
          let pkp;
          if (pkps.length === 0) {
            pkp = await mintPKP(userId, accessToken);
          } else {
            pkp = pkps[0];
          }

          // Get session signatures for the PKP
          logger.debug('Getting PKP session signatures', { pkpAddress: pkp.ethAddress });
          const sessionSigs = await getPkpSessionSigs(userId, accessToken, pkp);
          
          // Create PKP account
          const pkpAccount = new PKPAccount({
            address: pkp.ethAddress as `0x${string}`,
            publicKey: pkp.publicKey as `0x${string}`,
            sessionSigs,
          });

          logger.debug('Transferring tokens', { from: pkp.ethAddress, to, amount, chainId, tokenAddress });
          const result = await transferToken(
            pkpAccount,
            to as `0x${string}`,
            amount,
            {
              chainId,
              tokenAddress: tokenAddress as `0x${string}` | undefined,
              sessionSigs, // Pass sessionSigs for gas sponsorship
            }
          );
          
          res.json({
            success: true,
            transactionHash: result.transactionHash,
          });
        } catch (error) {
          logger.error('Failed to transfer tokens', error as Error);
          // Check if it's a token age error - return 401 to trigger re-authentication
          if (error instanceof Error && error.message.includes('Token is too old')) {
            res.status(401).json({ error: 'Authentication required', message: error.message });
          } else {
            res.status(500).json({ error: 'Failed to transfer tokens', message: (error as Error).message });
          }
        }
      });

      // Get payment history
      app.get('/api/wallet/payment-history', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const userId = getUserId(req);
          const accessToken = await getAccessToken(req);
          const walletAddress = req.query.walletAddress as string | undefined;
          const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 10;
          const page = req.query.page ? Number(req.query.page) : 0;
          const timeframe = req.query.timeframe ? Number(req.query.timeframe) : 30;

          if (!userId) {
            return res.status(401).json({ error: 'User ID not found' });
          }

          if (!accessToken) {
            return res.status(401).json({ error: 'Access token not found' });
          }

          // Get user's PKPs
          let pkps = await getPKPsForAuthMethod(userId);
          if (pkps.length === 0) {
            return res.status(400).json({ error: 'No wallets found. Please create a wallet first.' });
          }
          
          // Find the PKP to use (by address if specified, otherwise first one)
          let pkp;
          if (walletAddress) {
            pkp = pkps.find(p => p.ethAddress.toLowerCase() === walletAddress.toLowerCase());
            if (!pkp) {
              return res.status(404).json({ error: `Wallet address ${walletAddress} not found.` });
            }
          } else {
            pkp = pkps[0];
          }

          // Build x402scan API request
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

          logger.debug('Fetching payment history', { 
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
            totalPages: data?.result?.data?.json?.total_pages || 0,
            total: data?.result?.data?.json?.total_count || 0,
            hasNextPage: data?.result?.data?.json?.hasNextPage || false,
          };

          // Format amounts using the same helper function
          const formatAmountDisplay = (amount: string, decimals: number = 6): string => {
            try {
              const amountBigInt = BigInt(amount);
              const divisor = BigInt(10 ** decimals);
              const whole = amountBigInt / divisor;
              const remainder = amountBigInt % divisor;
              
              if (remainder === 0n) {
                return whole.toString();
              }
              
              const remainderStr = remainder.toString().padStart(decimals, '0');
              const trimmed = remainderStr.replace(/0+$/, '');
              const formatted = `${whole}.${trimmed}`;
              const num = parseFloat(formatted);
              if (isNaN(num)) return formatted;
              
              return num.toLocaleString("en-US", { 
                minimumFractionDigits: 0, 
                maximumFractionDigits: decimals 
              });
            } catch (error) {
              return amount;
            }
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

          res.json({
            success: true,
            walletAddress: pkp.ethAddress,
            payments: paymentsWithResources,
            pagination,
          });
        } catch (error) {
          logger.error('Failed to fetch payment history', error as Error);
          res.status(500).json({ error: 'Failed to fetch payment history', message: (error as Error).message });
        }
      });

      // Serve wallet dashboard
      // Note: Vite builds the wallet dashboard as dist/apps/index.html (since input is index.html)
      // When running with tsx, __dirname points to src/, so we need to go to ../dist/apps/
      app.get('/wallet', webAuth.requiresAuth, (req, res) => {
        // Resolve path relative to project root (go up from src/ to project root, then to dist/apps/)
        const appsDir = path.join(__dirname, '..', 'dist', 'apps');
        const walletDashboardPath = path.join(appsDir, 'index.html');
        
        if (fs.existsSync(walletDashboardPath)) {
          res.sendFile(walletDashboardPath);
        } else {
          logger.error('Wallet dashboard file not found', undefined, {
            checkedPath: walletDashboardPath,
            appsDir,
            __dirname
          });
          res.status(404).send(`Wallet dashboard not found at ${walletDashboardPath}. Please run: npm run build:apps`);
        }
      });

      console.log('');
      console.log('Web Auth Endpoints:');
      console.log(`   Login: ${config.baseUri}/login`);
      console.log(`   Logout: ${config.baseUri}/logout`);
      console.log(`   Wallet Dashboard: ${config.baseUri}/wallet`);
      console.log(`   Wallet API: ${config.baseUri}/api/wallet`);
    }
  }

  // Rate limiter for splash page (moderate limit)
  const splashPageLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 50, // 50 requests per minute
    message: 'Too many requests to splash page',
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Splash page (customize based on mode)
  app.get('/', splashPageLimiter, (req, res) => {
    if (config.auth.mode === 'auth_server') {
      // Simple splash page for standalone auth server
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>OAuth Authorization Server</title>
            <style>
              body {
                font-family: system-ui, sans-serif;
                max-width: 800px;
                margin: 50px auto;
                padding: 20px;
              }
              h1 { color: #333; }
              .endpoint {
                background: #f5f5f5;
                padding: 10px;
                margin: 5px 0;
                font-family: monospace;
              }
            </style>
          </head>
          <body>
            <h1>OAuth Authorization Server</h1>
            <p>This is a demo standalone OAuth 2.0 authorization server for MCP.</p>

            <h2>Available Endpoints</h2>
            <div class="endpoint">POST ${config.baseUri}/register - Register OAuth client</div>
            <div class="endpoint">GET ${config.baseUri}/authorize - Authorization endpoint</div>
            <div class="endpoint">POST ${config.baseUri}/token - Token endpoint</div>
            <div class="endpoint">POST ${config.baseUri}/introspect - Token introspection</div>
            <div class="endpoint">POST ${config.baseUri}/revoke - Token revocation</div>
          </body>
        </html>
      `);
    } else {
      // Redirect authenticated users to wallet dashboard if web auth is enabled
      if (webAuth) {
        const isAuth = (req as any).oidc?.isAuthenticated();
        logger.debug('Root route check', { isAuthenticated: isAuth, hasOidc: !!(req as any).oidc });
        if (isAuth) {
          return res.redirect('/wallet');
        }
      }
      
      const srcStaticDir = path.join(__dirname, 'static');
      const splashPath = path.join(srcStaticDir, 'index.html');
      const html = fs.readFileSync(splashPath, 'utf8');
      res.send(html);
    }
  });

  // Serve static files (logos, etc.) from src/static directory
  // This route should be placed after other specific routes to avoid conflicts
  const staticFileLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 200, // 200 requests per minute
    message: 'Too many requests for static files',
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Known static files to serve
  const knownStaticFiles = ['chatgpt-logo.svg', 'claude-logo.png', 'mcp-logo.svg', 'lit-logo-white.svg'];
  
  app.get('/:filename', staticFileLimiter, (req, res, next) => {
    const filename = req.params.filename;
    
    // Only serve known static files or files with static extensions
    const allowedExtensions = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.css'];
    const ext = path.extname(filename).toLowerCase();
    
    // If it's not a known static file and doesn't have an allowed extension, pass to next route
    if (!knownStaticFiles.includes(filename) && !allowedExtensions.includes(ext)) {
      return next();
    }

    const srcStaticDir = path.join(__dirname, 'static');
    const filePath = path.join(srcStaticDir, filename);
    
    // Security: ensure file is within static directory
    if (!filePath.startsWith(srcStaticDir)) {
      return res.status(403).send('Forbidden');
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return next(); // Pass to next route if file doesn't exist
    }

    // Set appropriate content type
    const contentType = ext === '.svg' ? 'image/svg+xml' :
                       ext === '.png' ? 'image/png' :
                       ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                       ext === '.gif' ? 'image/gif' :
                       ext === '.ico' ? 'image/x-icon' :
                       ext === '.css' ? 'text/css' : 'application/octet-stream';
    
    res.setHeader('Content-Type', contentType);
    res.sendFile(filePath);
  });

  // Start bazaar crawl cron job (only for MCP servers, not auth-only servers)
  let bazaarCrawlInterval: NodeJS.Timeout | null = null;
  if (config.auth.mode !== 'auth_server') {
    const crawlBazaarResources = async () => {
      try {
        logger.info('Running scheduled bazaar resources crawl');
        await crawlAllResources();
        logger.info('Scheduled bazaar resources crawl completed');
      } catch (error) {
        logger.error('Scheduled bazaar resources crawl failed', error as Error);
        // Don't throw - allow server to continue running
      }
    };

    // Start the cron job
    bazaarCrawlInterval = setInterval(crawlBazaarResources, config.bazaar.crawlIntervalMs);
    logger.info('Bazaar crawl cron job started', {
      intervalMs: config.bazaar.crawlIntervalMs,
      intervalMinutes: config.bazaar.crawlIntervalMs / 1000 / 60,
    });
  }

  // Start server - bind to 0.0.0.0 to accept connections from all interfaces (required for Fly.io)
  app.listen(config.port, '0.0.0.0', () => {
    console.log('');
    console.log('========================================');
    console.log(`Server running at: ${config.baseUri}`);
    console.log('========================================');
    console.log('');

    if (config.auth.mode === 'auth_server') {
      console.log('This server provides OAuth 2.0 endpoints only.');
      console.log('To use with an MCP server:');
      console.log('  1. Start MCP server with AUTH_MODE=external');
      console.log(`  2. Set AUTH_SERVER_URL=${config.baseUri}`);
    } else if (config.auth.mode === 'internal') {
      console.log('To switch to external auth:');
      console.log('  1. Start auth server separately');
      console.log('  2. Set AUTH_MODE=external');
      console.log('  3. Set AUTH_SERVER_URL=<auth-server-url>');
      console.log('  4. Restart this server');
    } else if (config.auth.mode === 'external') {
      console.log('To switch to internal auth:');
      console.log('  1. Set AUTH_MODE=internal');
      console.log('  2. Restart this server');
    }
    console.log('');
  });

  // Cleanup on shutdown
  const cleanup = () => {
    if (bazaarCrawlInterval) {
      clearInterval(bazaarCrawlInterval);
      logger.info('Bazaar crawl cron job stopped');
    }
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

// Start the server
main().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});