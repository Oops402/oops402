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
import { crawlAllResources, queryCachedResources } from './modules/x402/bazaarService.js';
import { createWebAuthMiddleware, getUserId, getAccessToken } from './modules/auth/webAuth.js';
import { getPKPsForAuthMethod, mintPKP, getPkpSessionSigs, PKPAccount, initializeLitServices } from './modules/wallet/index.js';
import { getBalances, transferToken } from './modules/wallet/chainService.js';
import { searchAgents } from './modules/agents/service.js';
import { makePayment } from './modules/x402/service.js';

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

      // Discover bazaar resources
      app.get('/api/discover/bazaar', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const { type, resource, keyword, limit, offset } = req.query;
          
          logger.debug('Discovering bazaar resources', { type, resource, keyword, limit, offset });
          const result = await queryCachedResources({
            type: type as string | undefined,
            resource: resource as string | undefined,
            keyword: keyword as string | undefined,
            limit: limit ? Number(limit) : undefined,
            offset: offset ? Number(offset) : undefined,
          });
          
          res.json({
            success: true,
            x402Version: 1,
            items: result.items.map(resource => ({
              resource: resource.resource,
              type: resource.type,
              lastUpdated: resource.lastUpdated,
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
              total: result.total,
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
          const { name, mcpTools, chains } = req.query;
          
          const searchParams: any = {
            x402support: true,
          };
          
          if (name) {
            searchParams.name = name as string;
          }
          if (mcpTools) {
            searchParams.mcpTools = Array.isArray(mcpTools) ? mcpTools : [mcpTools as string];
          }
          if (chains) {
            searchParams.chains = chains === 'all' ? 'all' : (Array.isArray(chains) ? chains.map(Number) : [Number(chains)]);
          }
          
          logger.debug('Discovering agents', searchParams);
          const result = await searchAgents(searchParams);
          
          res.json({
            success: true,
            agents: result.items.map(agent => ({
              agentId: agent.agentId,
              name: agent.name,
              description: agent.description,
              mcpTools: agent.mcpTools,
              a2aSkills: agent.a2aSkills,
              active: agent.active,
            })),
            nextCursor: result.nextCursor,
            total: result.items.length,
          });
        } catch (error) {
          logger.error('Agent discovery failed', error as Error);
          res.status(500).json({ error: 'Failed to discover agents', message: (error as Error).message });
        }
      });

      // Discover x402 schema from a URL
      app.post('/api/discover/schema', walletApiLimiter, webAuth.requiresAuth, async (req, res) => {
        try {
          const { url, method = 'GET' } = req.body;
          
          if (!url) {
            return res.status(400).json({ error: 'Missing required field: url' });
          }

          // Make a request without payment to discover the schema
          // x402 resources typically return payment requirements in response headers/body
          logger.debug('Discovering x402 schema', { url, method });
          const response = await fetch(url, {
            method: method as string,
            headers: {
              'Accept': 'application/json',
            },
          });

          // Try to parse response as JSON (x402 schema is typically in JSON format)
          let schemaData: any = null;
          const contentType = response.headers.get('content-type');
          if (contentType?.includes('application/json')) {
            try {
              schemaData = await response.json();
            } catch (e) {
              // If JSON parsing fails, try to get text
              schemaData = { raw: await response.text() };
            }
          } else {
            schemaData = { raw: await response.text() };
          }

          // Extract x402 headers if present
          const x402Headers: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            if (key.toLowerCase().startsWith('x-x402-') || key.toLowerCase().startsWith('x-402-')) {
              x402Headers[key] = value;
            }
          });

          // Check if response contains x402 schema (has accepts array or x402Version)
          const hasX402Schema = schemaData && (
            schemaData.accepts ||
            schemaData.x402Version !== undefined ||
            Object.keys(x402Headers).length > 0
          );

          res.json({
            success: true,
            status: response.status,
            url,
            hasX402Schema,
            schema: schemaData,
            headers: x402Headers,
            contentType,
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
          res.status(500).json({ error: 'Payment failed', message: (error as Error).message });
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
          res.status(500).json({ error: 'Failed to transfer tokens', message: (error as Error).message });
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