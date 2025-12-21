/**
 * Token validation interface - the ONLY connection between Auth and MCP modules
 *
 * This interface abstracts how tokens are validated, allowing the MCP module
 * to work identically whether auth is internal (in-process) or external (HTTP).
 *
 * The interface mimics the OAuth 2.0 Token Introspection endpoint (RFC 7662)
 * to maintain consistency between internal and external modes.
 */

import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthModule } from '../modules/auth/index.js';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { logger } from '../modules/shared/logger.js';

/**
 * Token introspection response per RFC 7662
 * https://datatracker.ietf.org/doc/html/rfc7662
 */
export interface TokenIntrospectionResponse {
  active: boolean;
  client_id?: string;
  scope?: string;
  exp?: number;
  sub?: string;
  aud?: string | string[];
  username?: string;
  token_type?: string;
  iss?: string;
  nbf?: number;
  iat?: number;
}

/**
 * Token validator interface
 */
export interface ITokenValidator {
  /**
   * Validates a token and returns introspection data
   * Mimics the /introspect endpoint behavior
   */
  introspect(token: string): Promise<TokenIntrospectionResponse>;

  /**
   * For MCP SDK compatibility - converts introspection to AuthInfo
   */
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

/**
 * Base validator with shared logic for converting introspection to AuthInfo
 */
abstract class BaseTokenValidator implements ITokenValidator {
  abstract introspect(token: string): Promise<TokenIntrospectionResponse>;

  /**
   * Convert introspection response to MCP SDK AuthInfo format
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const result = await this.introspect(token);

    if (!result.active) {
      throw new InvalidTokenError('Token is not active');
    }

    // Validate token hasn't expired
    if (result.exp && result.exp < Date.now() / 1000) {
      throw new InvalidTokenError('Token has expired');
    }

    return {
      token,
      clientId: result.client_id || 'unknown',
      scopes: result.scope?.split(' ') || [],
      expiresAt: result.exp,
      extra: {
        userId: result.sub || 'unknown',
        audience: result.aud,
        username: result.username,
        issuer: result.iss
      }
    };
  }
}

/**
 * External token validator - validates tokens via HTTP to external auth server
 * Used when AUTH_MODE=external
 */
export class ExternalTokenValidator extends BaseTokenValidator {
  // Cache tokens for 60 seconds to reduce auth server load
  private cache = new Map<string, {
    result: TokenIntrospectionResponse;
    expiresAt: number;
  }>();

  constructor(private authServerUrl: string) {
    super();

    // Clean up expired cache entries every minute
    setInterval(() => this.cleanupCache(), 60 * 1000);
  }

  async introspect(token: string): Promise<TokenIntrospectionResponse> {
    // Check cache first
    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    try {
      // Call external auth server's introspection endpoint
      const response = await fetch(`${this.authServerUrl}/introspect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `token=${encodeURIComponent(token)}`
      });

      if (!response.ok) {
        console.error(`Token introspection failed: ${response.status} ${response.statusText}`);
        return { active: false };
      }

      const result = await response.json() as TokenIntrospectionResponse;

      // Cache successful introspections for 60 seconds
      if (result.active) {
        const cacheDuration = 60 * 1000; // 60 seconds
        this.cache.set(token, {
          result,
          expiresAt: Date.now() + cacheDuration
        });
      }

      return result;

    } catch (error) {
      console.error('Failed to introspect token:', error);
      // Treat network errors as invalid token
      return { active: false };
    }
  }

  private cleanupCache(): void {
    const now = Date.now();
    for (const [token, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(token);
      }
    }
  }
}

/**
 * Internal token validator - validates tokens via direct method call
 * Used when AUTH_MODE=internal
 *
 * IMPORTANT: Even though auth is running in-process, we still go through
 * the introspection interface to maintain architectural separation.
 * The auth module is a stand-in for an external OAuth server.
 */
export class InternalTokenValidator extends BaseTokenValidator {
  constructor(private authModule: AuthModule) {
    super();
  }

  async introspect(token: string): Promise<TokenIntrospectionResponse> {
    // Direct method call instead of HTTP, but returns same format
    // This maintains the separation - auth module is still "external"
    // architecturally, just running in the same process for convenience
    return this.authModule.introspectToken(token);
  }
}

/**
 * Auth0 token validator - validates JWT tokens using Auth0's JWKS endpoint
 * Used when AUTH_MODE=external and AUTH_PROVIDER=auth0
 *
 * Auth0 issues JWT access tokens (not opaque tokens), so we verify them
 * locally using their public keys from the JWKS endpoint. This is faster
 * than introspection and doesn't require network calls for each validation.
 *
 * IMPORTANT: Auth0 does NOT provide an RFC 7662 introspection endpoint.
 * All Auth0 tokens must be verified as JWTs using this validator.
 */
export class Auth0TokenValidator extends BaseTokenValidator {
  private jwksClient: jwksClient.JwksClient;
  private issuer: string;
  private audience?: string;

  // Cache verified tokens to avoid re-verification
  private cache = new Map<string, {
    result: TokenIntrospectionResponse;
    expiresAt: number;
  }>();

  constructor(auth0Domain: string, audience?: string) {
    super();
    
    this.issuer = `https://${auth0Domain}/`;
    this.audience = audience;
    
    // Initialize JWKS client to fetch Auth0's public keys
    this.jwksClient = jwksClient({
      jwksUri: `https://${auth0Domain}/.well-known/jwks.json`,
      cache: true,
      cacheMaxAge: 86400000, // 24 hours
      rateLimit: true,
      jwksRequestsPerMinute: 5
    });

    // Clean up expired cache entries every minute
    setInterval(() => this.cleanupCache(), 60 * 1000);
  }

  /**
   * Check if a token string looks like a JWT (has 3 parts separated by dots)
   */
  private isJWT(token: string): boolean {
    return token.split('.').length === 3;
  }

  /**
   * Get signing key from JWKS for token verification
   */
  private getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void {
    if (!header.kid) {
      logger.warning('JWT header missing key ID (kid)', {});
      callback(new Error('No kid in token header'));
      return;
    }

    logger.debug('Fetching signing key from JWKS', {
      kid: header.kid
    });

    this.jwksClient.getSigningKey(header.kid, (err, key) => {
      if (err) {
        logger.error('Failed to fetch signing key from JWKS', err instanceof Error ? err : new Error(String(err)), {
          kid: header.kid
        });
        callback(err);
        return;
      }
      
      const signingKey = key?.getPublicKey();
      logger.debug('Successfully fetched signing key from JWKS', {
        kid: header.kid
      });
      callback(null, signingKey);
    });
  }

  async introspect(token: string): Promise<TokenIntrospectionResponse> {
    // Only log first 4 chars of token for debugging (not sensitive)
    const tokenPrefix = token.substring(0, 4) + '...';
    
    // Check cache first
    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      logger.debug('Auth0 token validation cache hit', {
        tokenPrefix,
        sub: cached.result.sub,
        exp: cached.result.exp
      });
      return cached.result;
    }

    logger.debug('Starting Auth0 JWT verification', {
      tokenPrefix,
      issuer: this.issuer,
      audience: this.audience
    });

    // If token doesn't look like a JWT, it's invalid
    if (!this.isJWT(token)) {
      logger.warning('Token is not a valid JWT format', {
        tokenPrefix,
        reason: 'Token does not have 3 parts separated by dots'
      });
      return { active: false };
    }

    try {
      // Decode token header to get key ID (without verification)
      const decodedHeader = jwt.decode(token, { complete: true });
      if (!decodedHeader || typeof decodedHeader === 'string') {
        logger.warning('Failed to decode JWT header', { tokenPrefix });
        return { active: false };
      }

      const kid = decodedHeader.header.kid;
      logger.debug('JWT header decoded', {
        tokenPrefix,
        kid,
        alg: decodedHeader.header.alg
      });

      // Verify JWT using Auth0's public keys
      logger.debug('Fetching signing key from JWKS', {
        tokenPrefix,
        kid
      });

      const decoded = await new Promise<jwt.JwtPayload>((resolve, reject) => {
        jwt.verify(
          token,
          (header, callback) => {
            logger.debug('Getting signing key for JWT verification', {
              tokenPrefix,
              kid: header.kid
            });
            this.getKey(header, callback);
          },
          {
            audience: this.audience,
            issuer: this.issuer,
            algorithms: ['RS256']
          },
          (err, decoded) => {
            if (err) {
              logger.debug('JWT verification failed', {
                tokenPrefix,
                error: err.message,
                errorName: err.name
              });
              reject(err);
            } else {
              logger.debug('JWT verification successful', {
                tokenPrefix,
                sub: (decoded as jwt.JwtPayload).sub,
                iss: (decoded as jwt.JwtPayload).iss,
                aud: (decoded as jwt.JwtPayload).aud,
                exp: (decoded as jwt.JwtPayload).exp,
                iat: (decoded as jwt.JwtPayload).iat
              });
              resolve(decoded as jwt.JwtPayload);
            }
          }
        );
      });

      // Convert JWT claims to RFC 7662 introspection format
      const result: TokenIntrospectionResponse = {
        active: true,
        sub: decoded.sub,
        client_id: decoded.azp || decoded.aud, // Auth0 uses 'azp' (authorized party) or 'aud' (audience)
        scope: decoded.scope as string | undefined,
        exp: decoded.exp,
        aud: decoded.aud,
        username: decoded.email || decoded.nickname || decoded.name,
        token_type: 'Bearer',
        iss: decoded.iss,
        nbf: decoded.nbf,
        iat: decoded.iat
      };

      logger.info('Auth0 token validated successfully', {
        tokenPrefix,
        sub: result.sub,
        client_id: result.client_id,
        username: result.username,
        exp: result.exp,
        scope: result.scope
      });

      // Cache successful verifications until token expiry (or 60 seconds, whichever is shorter)
      if (result.exp) {
        const tokenExpiry = result.exp * 1000; // Convert to milliseconds
        const cacheExpiry = Math.min(tokenExpiry, Date.now() + 60 * 1000);
        this.cache.set(token, {
          result,
          expiresAt: cacheExpiry
        });
        logger.debug('Token validation result cached', {
          tokenPrefix,
          cacheExpiry: new Date(cacheExpiry).toISOString()
        });
      }

      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      
      logger.error('Failed to verify Auth0 JWT', error instanceof Error ? error : new Error(errorMessage), {
        tokenPrefix,
        errorName,
        issuer: this.issuer,
        audience: this.audience
      });
      
      return { active: false };
    }
  }

  private cleanupCache(): void {
    const now = Date.now();
    for (const [token, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(token);
      }
    }
  }
}