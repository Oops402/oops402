/**
 * Web Auth Module - Auth0 web authentication for user-facing web interface
 *
 * This module provides web authentication using express-openid-connect.
 * It's separate from the MCP OAuth flow but uses the same Auth0 tenant
 * to ensure users have consistent identity across both interfaces.
 */

import { auth } from 'express-openid-connect';
import { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import { config } from '../../config.js';
import { logger } from '../shared/logger.js';

// Type augmentation for express-openid-connect
declare module 'express-serve-static-core' {
  interface Request {
    oidc?: {
      isAuthenticated(): boolean;
      user?: {
        sub?: string;
        [key: string]: unknown;
      };
      accessToken?: string | (() => Promise<string>) | { access_token?: string; token?: string; accessToken?: string; [key: string]: unknown };
      [key: string]: unknown;
    };
  }
}

export interface WebAuthConfig {
  clientId: string;
  secret: string;
  issuerBaseURL: string;
  baseURL: string;
  redisEnabled: boolean;
}

/**
 * Create and configure Auth0 web authentication middleware
 */
export function createWebAuthMiddleware() {
  if (!config.auth.web) {
    throw new Error('Web auth configuration not found. Set AUTH0_WEB_CLIENT_ID and related env vars.');
  }

  const webConfig: WebAuthConfig = {
    clientId: config.auth.web.clientId!,
    secret: config.auth.web.secret!,
    issuerBaseURL: config.auth.web.issuerBaseURL!,
    baseURL: config.auth.web.baseURL || config.baseUri,
    redisEnabled: config.redis.enabled
  };

  // Validate required config
  if (!webConfig.clientId || !webConfig.secret || !webConfig.issuerBaseURL) {
    throw new Error('Web auth configuration incomplete. Required: AUTH0_WEB_CLIENT_ID, AUTH0_WEB_SECRET, AUTH0_ISSUER_BASE_URL');
  }

  // Configure session store
  // Note: connect-redis requires the redis v4 client, we'll use memory store for now
  // and can enhance later with a proper Redis store adapter if needed
  const sessionStore = new session.MemoryStore();
  if (webConfig.redisEnabled) {
    logger.info('Note: Redis session store not yet configured, using memory store');
    logger.info('Set REDIS_URL for persistent sessions (Redis store implementation pending)');
  } else {
    logger.info('Using memory store for sessions (set REDIS_URL for persistent sessions)');
  }

  // Auth0 configuration for express-openid-connect
  // Note: express-openid-connect handles session internally, but we can configure it
  const authConfig: any = {
    authRequired: false, // Allow unauthenticated access to landing page
    auth0Logout: true, // Use Auth0 logout
    baseURL: webConfig.baseURL,
    clientID: webConfig.clientId,
    clientSecret: webConfig.secret, // Note: express-openid-connect uses 'clientSecret', not 'secret'
    issuerBaseURL: webConfig.issuerBaseURL,
    secret: webConfig.secret, // This is for session signing (can be same as clientSecret)
    authorizationParams: {
      response_type: 'code',
      scope: 'openid profile email', // Access token is available via req.oidc.accessToken when audience is set
      audience: config.auth.auth0Audience, // Required for API access tokens
    },
    // Session configuration - express-openid-connect uses express-session internally
    session: {
      store: sessionStore,
      rolling: true,
      rollingDuration: 24 * 60 * 60 * 1000, // 24 hours - session extends on activity
      absoluteDuration: 7 * 24 * 60 * 60 * 1000, // 7 days - maximum session lifetime
      // Cookie settings for session persistence
      cookie: {
        httpOnly: true, // Prevent XSS attacks
        secure: process.env.NODE_ENV === 'production', // Use HTTPS in production
        sameSite: 'Lax', // CSRF protection, allows top-level redirects (must be capitalized)
      },
    },
  };
  
  // Log configuration (without secrets)
  logger.debug('Auth0 web auth configuration', {
    baseURL: authConfig.baseURL,
    issuerBaseURL: authConfig.issuerBaseURL,
    clientID: authConfig.clientID ? '***' : undefined,
    secret: authConfig.secret ? '***' : undefined,
    authRequired: authConfig.authRequired,
    hasAudience: !!authConfig.authorizationParams?.audience,
  });

  logger.info('Web auth middleware configured', {
    issuerBaseURL: webConfig.issuerBaseURL,
    baseURL: webConfig.baseURL,
    sessionStore: webConfig.redisEnabled ? 'redis' : 'memory'
  });

  // Create requiresAuth middleware
  // For API routes, return 401 JSON. For HTML routes, redirect to login
  const requiresAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const isAuthenticated = req.oidc?.isAuthenticated();
    
    logger.debug('requiresAuth middleware check', {
      path: req.path,
      hasOidc: !!req.oidc,
      isAuthenticated,
      userId: req.oidc?.user?.sub,
      hasAccessToken: !!(req.oidc as any)?.accessToken,
    });
    
    if (isAuthenticated) {
      return next();
    }
    
    // API routes should return JSON errors
    if (req.path.startsWith('/api/')) {
      logger.warning('API route accessed without authentication', { path: req.path });
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // HTML routes should redirect to login
    res.redirect('/login');
  };

  const authMiddleware = auth(authConfig);
  
  logger.info('Auth middleware created successfully', {
    baseURL: authConfig.baseURL,
    issuerBaseURL: authConfig.issuerBaseURL,
    routesDefined: authConfig.routes
  });

  return {
    authMiddleware,
    requiresAuth: requiresAuthMiddleware,
  };
}

/**
 * Helper to check if user is authenticated (for use in templates/routes)
 */
export function isAuthenticated(req: Request): boolean {
  return req.oidc?.isAuthenticated() ?? false;
}

/**
 * Helper to get user ID from session (for use in API routes)
 */
export function getUserId(req: Request): string | null {
  return req.oidc?.user?.sub ?? null;
}

/**
 * Helper to get access token from session (for use in API routes)
 */
export async function getAccessToken(req: Request): Promise<string | null> {
  if (!req.oidc) {
    logger.debug('getAccessToken: No req.oidc object');
    return null;
  }
  
  // express-openid-connect makes accessToken available when getAccessToken: true
  // It may be a getter function, a TokenSet object, or a string
  try {
    let accessToken = (req.oidc as any).accessToken;
    logger.debug('getAccessToken: Checking accessToken', {
      exists: !!accessToken,
      type: typeof accessToken,
      isFunction: typeof accessToken === 'function',
    });
    
    if (!accessToken) {
      logger.debug('getAccessToken: accessToken property is null/undefined');
      return null;
    }
    
    // Try calling it as a function first (even if typeof says it's an object, it might be a getter)
    // Some libraries use getters that appear as objects but are actually functions
    try {
      if (typeof accessToken === 'function' || 
          (typeof accessToken === 'object' && accessToken !== null && typeof (accessToken as any).then === 'function')) {
        accessToken = typeof accessToken === 'function' ? await accessToken() : await accessToken;
        logger.debug('getAccessToken: Called function/getter, got', {
          type: typeof accessToken,
          isString: typeof accessToken === 'string',
          isObject: typeof accessToken === 'object',
        });
      }
    } catch (callError) {
      // If calling failed, it's not a function, continue with object/string handling
      logger.debug('getAccessToken: Not callable, treating as object/string', {
        error: (callError as Error).message
      });
    }
    
    // Now handle the result - it might be a string, TokenSet object, or other
    if (typeof accessToken === 'string') {
      logger.debug('getAccessToken: Is string', { length: accessToken.length });
      return accessToken;
    }
    
    // If it's an object (e.g., TokenSet from openid-client), try different property names
    if (typeof accessToken === 'object' && accessToken !== null) {
      // Log the object keys to help debug
      const keys = Object.keys(accessToken);
      logger.debug('getAccessToken: Object keys', { keys, firstFewKeys: keys.slice(0, 10) });
      
      // Try different possible property names (TokenSet uses access_token)
      const token = (accessToken as any).access_token || 
                    (accessToken as any).token || 
                    (accessToken as any).accessToken;
      
      logger.debug('getAccessToken: Extracted from object', { 
        hasToken: !!token,
        hasAccessTokenProp: !!(accessToken as any).access_token,
        hasTokenProp: !!(accessToken as any).token,
        hasAccessTokenCamel: !!(accessToken as any).accessToken,
        tokenType: typeof token,
        tokenLength: typeof token === 'string' ? token.length : undefined,
      });
      
      if (token && typeof token === 'string') {
        return token;
      }
    }
    
    logger.warning('getAccessToken: Unexpected accessToken type or structure', { 
      type: typeof accessToken,
      isNull: accessToken === null,
      keys: typeof accessToken === 'object' && accessToken !== null ? Object.keys(accessToken) : undefined,
    });
    return null;
  } catch (error) {
    logger.warning('getAccessToken: Error getting access token', { error: (error as Error).message });
    return null;
  }
}

