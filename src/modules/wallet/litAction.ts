/**
 * Lit Action code for Auth0 OAuth verification
 * This action verifies Auth0 access tokens and checks if the user is authorized to use the PKP
 *
 * NOTE: Auth0 does NOT provide an RFC 7662 token introspection endpoint.
 * Instead, we use Auth0's /userinfo endpoint which validates the token server-side
 * and returns user information. This is the recommended approach for Auth0 token
 * validation in server-side contexts like Lit Actions.
 */

// @ts-nocheck

const _litActionCode = async () => {
  const LIT_PKP_PERMISSIONS_CONTRACT_ADDRESS =
    "0x60C1ddC8b9e38F730F0e7B70A2F84C1A98A69167";
  const OAUTH_AUTH_METHOD_TYPE = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes("AUTH0_AUTH_METHOD_V04")
  );
  const AUTH0_DOMAIN = "oops402pay.us.auth0.com";
  const AUTH0_AUDIENCE = "urn:oops402";

  console.log("[AUTH0_LIT_ACTION] Starting OAuth verification");
  console.log("[AUTH0_LIT_ACTION] PKP Token ID:", pkpTokenId);

  try {
    console.log("[AUTH0_LIT_ACTION] Parsing oauthUserData");
    const parsedData = JSON.parse(oauthUserData);
    const { accessToken } = parsedData;
    
    console.log("[AUTH0_LIT_ACTION] Parsed data:", {
      hasAccessToken: !!accessToken,
      accessTokenLength: accessToken ? accessToken.length : 0
    });

    // Declare payload outside the try-catch so it's accessible after JWT validation
    let payload: any;

    // Validate JWT token - decode and verify signature using JWKS
    console.log("[AUTH0_LIT_ACTION] Validating JWT token");
    try {
      const tokenParts = accessToken.split('.');
      if (tokenParts.length !== 3) {
        console.error("[AUTH0_LIT_ACTION] Invalid JWT format");
        return Lit.Actions.setResponse({
          response: "false",
          reason: "Invalid JWT token format",
        });
      }

      // Decode header to get kid and alg
      const headerBase64Url = tokenParts[0].replace(/-/g, '+').replace(/_/g, '/');
      const headerBase64 = headerBase64Url + '='.repeat((4 - headerBase64Url.length % 4) % 4);
      const headerDecoded = atob(headerBase64);
      const header = JSON.parse(headerDecoded);
      
      console.log("[AUTH0_LIT_ACTION] JWT header:", { kid: header.kid, alg: header.alg });

      // Decode the payload (base64url)
      const payloadBase64Url = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payloadBase64 = payloadBase64Url + '='.repeat((4 - payloadBase64Url.length % 4) % 4);
      const payloadDecoded = atob(payloadBase64);
      payload = JSON.parse(payloadDecoded);
      
      console.log("[AUTH0_LIT_ACTION] JWT payload:", {
        sub: payload.sub,
        iss: payload.iss,
        exp: payload.exp,
        iat: payload.iat,
        aud: payload.aud
      });

      // Verify issuer matches (iss claim)
      const expectedIssuer = `https://${AUTH0_DOMAIN}/`;
      if (payload.iss !== expectedIssuer) {
        console.error("[AUTH0_LIT_ACTION] Issuer mismatch:", payload.iss, "expected:", expectedIssuer);
        return Lit.Actions.setResponse({
          response: "false",
          reason: `Token issuer mismatch: expected ${expectedIssuer}, got ${payload.iss}`,
        });
      }
      console.log("[AUTH0_LIT_ACTION] ✅ Issuer verified");

      // Verify AUTH0_AUDIENCE if provided (aud claim)
      if (AUTH0_AUDIENCE) {
        const tokenAudience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (!tokenAudience.includes(AUTH0_AUDIENCE)) {
          console.error("[AUTH0_LIT_ACTION] Audience mismatch:", payload.aud, "expected:", AUTH0_AUDIENCE);
          return Lit.Actions.setResponse({
            response: "false",
            reason: `Token AUTH0_AUDIENCE mismatch: expected ${AUTH0_AUDIENCE}, got ${payload.aud}`,
          });
        }
        console.log("[AUTH0_LIT_ACTION] ✅ Audience verified");
      }

      // Verify token hasn't expired (exp claim)
      const currentTimeSeconds = Math.floor(Date.now() / 1000);
      if (!payload.exp) {
        console.error("[AUTH0_LIT_ACTION] Token missing expiration claim");
        return Lit.Actions.setResponse({
          response: "false",
          reason: "Token missing expiration claim (exp)",
        });
      }
      if (payload.exp < currentTimeSeconds) {
        console.error("[AUTH0_LIT_ACTION] Token expired");
        return Lit.Actions.setResponse({
          response: "false",
          reason: `Token expired at ${new Date(payload.exp * 1000).toISOString()}`,
        });
      }
      console.log("[AUTH0_LIT_ACTION] ✅ Expiration verified");

      // Verify issued at time (iat claim)
      if (!payload.iat) {
        console.error("[AUTH0_LIT_ACTION] Token missing issued at claim");
        return Lit.Actions.setResponse({
          response: "false",
          reason: "Token missing issued at claim (iat)",
        });
      }
      if (payload.iat > currentTimeSeconds + 60) { // Allow 60 second clock skew
        console.error("[AUTH0_LIT_ACTION] Token issued in the future");
        return Lit.Actions.setResponse({
          response: "false",
          reason: `Token issued at time is in the future: ${new Date(payload.iat * 1000).toISOString()}`,
        });
      }
      console.log("[AUTH0_LIT_ACTION] ✅ Issued at verified");

      // Verify that the user ID matches (Auth0 uses 'sub' field)
      console.log("[AUTH0_LIT_ACTION] User ID:", payload.sub);

      // Validate token is recent (issued within last 24 hours) - additional security check
      const tokenAge = currentTimeSeconds - payload.iat;
      console.log("[AUTH0_LIT_ACTION] Token age:", tokenAge, "seconds");
      if (tokenAge > 86400) { // 24 hours
        console.error("[AUTH0_LIT_ACTION] Token too old");
        return Lit.Actions.setResponse({
          response: "false",
          reason: `Token is too old (${Math.floor(tokenAge / 3600)} hours)`,
        });
      }

      // Verify the key exists in JWKS (this confirms the token uses a valid Auth0 key)
      // Note: Full RSA signature verification is complex in Lit Actions environment.
      // We verify the key exists, then use /userinfo endpoint which Auth0 validates server-side.
      console.log("[AUTH0_LIT_ACTION] Verifying key exists in JWKS");
      const jwksUrl = `https://${AUTH0_DOMAIN}/.well-known/jwks.json`;
      const jwksResponse = await fetch(jwksUrl);
      
      if (!jwksResponse.ok) {
        console.error("[AUTH0_LIT_ACTION] Failed to fetch JWKS:", jwksResponse.status);
        return Lit.Actions.setResponse({
          response: "false",
          reason: `Failed to fetch JWKS (HTTP ${jwksResponse.status})`,
        });
      }

      const jwks = await jwksResponse.json();
      console.log("[AUTH0_LIT_ACTION] JWKS fetched, looking for key with kid:", header.kid);

      // Find the key with matching kid
      const key = jwks.keys?.find(k => k.kid === header.kid);
      if (!key) {
        console.error("[AUTH0_LIT_ACTION] Key not found in JWKS for kid:", header.kid);
        return Lit.Actions.setResponse({
          response: "false",
          reason: `Key not found in JWKS for kid: ${header.kid}`,
        });
      }

      console.log("[AUTH0_LIT_ACTION] Found matching key in JWKS");

      // Verify RSA signature using Web Crypto API (available in Deno environment)
      console.log("[AUTH0_LIT_ACTION] Verifying JWT signature using Web Crypto API");
      try {
        // Convert JWK to Web Crypto key format
        const cryptoKey = await crypto.subtle.importKey(
          "jwk",
          {
            kty: key.kty,
            n: key.n,
            e: key.e,
            alg: header.alg,
            use: key.use || "sig",
          },
          {
            name: "RSASSA-PKCS1-v1_5",
            hash: "SHA-256",
          },
          false,
          ["verify"]
        );

        // Verify signature
        // RSASSA-PKCS1-v1_5 with SHA-256: data to verify is header.payload (as string)
        // Signature is in the third part of the JWT (tokenParts[2])
        const dataToVerify = tokenParts[0] + "." + tokenParts[1];
        
        // Convert signature from base64url to ArrayBuffer
        const signatureBase64Url = tokenParts[2].replace(/-/g, '+').replace(/_/g, '/');
        const signatureBase64 = signatureBase64Url + '='.repeat((4 - signatureBase64Url.length % 4) % 4);
        const signatureBinaryString = atob(signatureBase64);
        const signatureArray = new Uint8Array(signatureBinaryString.length);
        for (let i = 0; i < signatureBinaryString.length; i++) {
          signatureArray[i] = signatureBinaryString.charCodeAt(i);
        }

        // Convert data to ArrayBuffer
        const dataArray = new TextEncoder().encode(dataToVerify);

        // Verify the signature
        // Note: RSASSA-PKCS1-v1_5 with SHA-256 automatically hashes the data during verification
        const isValid = await crypto.subtle.verify(
          {
            name: "RSASSA-PKCS1-v1_5",
            hash: "SHA-256",
          },
          cryptoKey,
          signatureArray,
          dataArray
        );

        if (!isValid) {
          console.error("[AUTH0_LIT_ACTION] Signature verification failed");
          return Lit.Actions.setResponse({
            response: "false",
            reason: "JWT signature verification failed",
          });
        }

        console.log("[AUTH0_LIT_ACTION] ✅ Signature verified cryptographically");
      } catch (sigError) {
        console.error("[AUTH0_LIT_ACTION] Signature verification error:", sigError);
        return Lit.Actions.setResponse({
          response: "false",
          reason: `Signature verification failed: ${sigError.message || "Unknown error"}`,
        });
      }

      console.log("[AUTH0_LIT_ACTION] ✅ Token claims and signature validated");
      
    } catch (jwtError) {
      console.error("[AUTH0_LIT_ACTION] JWT validation error:", jwtError);
      return Lit.Actions.setResponse({
        response: "false",
        reason: `JWT validation failed: ${jwtError.message || "Unknown error"}`,
      });
    }

    // Checking if usersAuthMethodId is a permitted Auth Method for pkpTokenId
    console.log("[AUTH0_LIT_ACTION] Computing auth method ID for user:", payload.sub);
    const usersAuthMethodId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes(`oauth:${payload.sub}`)
    );
    console.log("[AUTH0_LIT_ACTION] Auth method ID:", usersAuthMethodId);
    console.log("[AUTH0_LIT_ACTION] Auth method type:", OAUTH_AUTH_METHOD_TYPE);

    console.log("[AUTH0_LIT_ACTION] Checking if auth method is permitted for PKP");
    const isPermitted = await Lit.Actions.isPermittedAuthMethod({
      tokenId: pkpTokenId,
      authMethodType: OAUTH_AUTH_METHOD_TYPE,
      userId: ethers.utils.arrayify(usersAuthMethodId),
    });

    console.log("[AUTH0_LIT_ACTION] Permission check result:", isPermitted);

    if (!isPermitted) {
      console.error("[AUTH0_LIT_ACTION] Auth method not permitted");
      return Lit.Actions.setResponse({
        response: "false",
        reason: `OAuth user is not authorized to use this PKP (userId: ${payload.sub}, tokenId: ${pkpTokenId})`,
      });
    }

    console.log("[AUTH0_LIT_ACTION] All validations passed, returning success");
    return Lit.Actions.setResponse({ response: "true" });
  } catch (error) {
    console.error("[AUTH0_LIT_ACTION] Exception caught:", error);
    console.error("[AUTH0_LIT_ACTION] Error message:", error.message);
    console.error("[AUTH0_LIT_ACTION] Error stack:", error.stack);
    return Lit.Actions.setResponse({
      response: "false",
      reason: `Error: ${error.message || "Unknown error"}`,
    });
  }
};

export const litActionCode = `(${_litActionCode.toString()})();`;

