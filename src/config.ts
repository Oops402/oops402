/**
 * Unified configuration for the merged MCP + Auth server
 *
 * This configuration supports two modes:
 * - internal: Auth server runs in-process (default for demo/development)
 * - external: Auth server runs separately (production pattern)
 */

import 'dotenv/config';

export interface Config {
  // Server configuration
  port: number;
  baseUri: string;
  nodeEnv: string;

  // Auth configuration
  auth: {
    mode: 'internal' | 'external' | 'auth_server';
    externalUrl?: string; // URL of external auth server (if mode=external)
    provider?: 'auth0' | 'okta' | 'generic'; // OAuth provider type (for external mode)
    auth0Domain?: string; // Auth0 domain (e.g., 'your-tenant.auth0.com')
    auth0Audience?: string; // Auth0 API audience/identifier
    // Web app Auth0 configuration (separate from MCP Auth0)
    web?: {
      clientId?: string; // Auth0 application client ID for web app
      secret?: string; // Auth0 application secret for web app
      issuerBaseURL?: string; // Auth0 issuer (e.g., 'https://oops402pay.us.auth0.com')
      baseURL?: string; // Base URL for web app (defaults to baseUri)
    };
  };

  // Redis configuration (optional)
  redis: {
    enabled: boolean;
    url?: string;
    tls?: boolean;
  };

  // Bazaar configuration
  bazaar: {
    cacheFile: string;
    crawlIntervalMs: number;
    facilitatorUrl: string;
  };
}

/**
 * Load configuration from environment variables
 */
function loadConfig(): Config {
  const authMode = (process.env.AUTH_MODE || 'internal') as 'internal' | 'external' | 'auth_server';

  // Validate configuration
  const authProvider = (process.env.AUTH_PROVIDER as 'auth0' | 'okta' | 'generic') || 'generic';
  
  if (authMode === 'external') {
    if (authProvider === 'auth0') {
      if (!process.env.AUTH0_DOMAIN) {
        throw new Error('AUTH0_DOMAIN must be set when AUTH_MODE=external and AUTH_PROVIDER=auth0');
      }
    } else {
      if (!process.env.AUTH_SERVER_URL) {
        throw new Error('AUTH_SERVER_URL must be set when AUTH_MODE=external');
      }
    }
  }

  return {
    // Server configuration
    port: Number(process.env.PORT) || 3232,
    baseUri: process.env.BASE_URI || 'http://localhost:3232',
    nodeEnv: process.env.NODE_ENV || 'development',

    // Auth configuration
    auth: {
      mode: authMode,
      externalUrl: process.env.AUTH_SERVER_URL,
      provider: (process.env.AUTH_PROVIDER as 'auth0' | 'okta' | 'generic') || 'generic',
      auth0Domain: process.env.AUTH0_DOMAIN,
      auth0Audience: process.env.AUTH0_AUDIENCE,
      // Web app Auth0 configuration (optional, separate from MCP Auth0)
      web: process.env.AUTH0_WEB_CLIENT_ID ? {
        clientId: process.env.AUTH0_WEB_CLIENT_ID,
        secret: process.env.AUTH0_WEB_SECRET || '',
        issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL || process.env.AUTH0_DOMAIN ? `https://${process.env.AUTH0_DOMAIN}` : undefined,
        baseURL: process.env.AUTH0_WEB_BASE_URL || process.env.BASE_URI || 'http://localhost:3232'
      } : undefined
    },

    // Redis configuration
    redis: {
      enabled: !!process.env.REDIS_URL,
      url: process.env.REDIS_URL,
      tls: process.env.REDIS_TLS === '1' || process.env.REDIS_TLS === 'true'
    },

    // Bazaar configuration
    bazaar: {
      cacheFile: process.env.X402_BAZAAR_CACHE_FILE || 'bazaar-resources.json',
      crawlIntervalMs: Number(process.env.X402_BAZAAR_CRAWL_INTERVAL_MS) || 3600000, // Default: 1 hour
      facilitatorUrl: process.env.X402_FACILITATOR_URL || 'https://api.cdp.coinbase.com/platform/v2/x402'
    }
  };
}

// Export singleton config
export const config = loadConfig();

// Log configuration on startup (without sensitive values)
console.log('Configuration loaded:');
console.log('   Port:', config.port);
console.log('   Base URI:', config.baseUri);
console.log('   Auth Mode:', config.auth.mode);
if (config.auth.mode === 'external') {
  if (config.auth.provider === 'auth0') {
    console.log('   Auth Provider: Auth0');
    console.log('   Auth0 Domain:', config.auth.auth0Domain);
  } else {
    console.log('   Auth Server:', config.auth.externalUrl);
  }
}
console.log('   Redis:', config.redis.enabled ? 'enabled' : 'disabled');
console.log('   Bazaar Cache:', config.bazaar.cacheFile);
console.log('   Bazaar Crawl Interval:', `${config.bazaar.crawlIntervalMs / 1000 / 60} minutes`);
console.log('');