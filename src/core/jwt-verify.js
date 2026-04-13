/**
 * UseEasy JWT Verification — Dual-Algorithm with JWKS Caching
 *
 * Verifies Supabase-issued JWTs supporting both ES256 (ECDSA P-256)
 * and HS256 (HMAC-SHA256) algorithms. Uses timing-safe comparison
 * and automatic JWKS key rotation with configurable TTL.
 *
 * Security features:
 * - Timing-safe signature comparison (prevents timing attacks)
 * - JWKS caching with 10-minute TTL (reduces JWKS endpoint load)
 * - Algorithm allowlist (rejects alg:none and unexpected algorithms)
 * - Token expiry validation with clock skew tolerance
 *
 * @version 4.4.1
 * @author Leon Musawu
 */

'use strict';

const crypto = require('crypto');
const https = require('https');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CLOCK_SKEW_SECONDS = 30;
const ALLOWED_ALGORITHMS = new Set(['ES256', 'HS256']);

// ---------------------------------------------------------------------------
// JWKS Cache
// ---------------------------------------------------------------------------

let jwksCache = null;
let jwksCacheTimestamp = 0;

/**
 * Fetches and caches JWKS (JSON Web Key Set) from the auth provider.
 * Uses in-memory caching with TTL to avoid hammering the JWKS endpoint.
 *
 * @param {string} jwksUrl - JWKS endpoint URL
 * @returns {Promise<Map<string, object>>} Map of kid → JWK
 */
async function getCachedJWKS(jwksUrl) {
  const now = Date.now();

  if (jwksCache && (now - jwksCacheTimestamp) < JWKS_CACHE_TTL_MS) {
    return jwksCache;
  }

  const jwksResponse = await fetchJSON(jwksUrl);
  const keyMap = new Map();

  for (const key of jwksResponse.keys || []) {
    if (key.kid) {
      keyMap.set(key.kid, key);
    }
  }

  jwksCache = keyMap;
  jwksCacheTimestamp = now;
  return keyMap;
}

// ---------------------------------------------------------------------------
// JWT Decoding (no verification — just parsing)
// ---------------------------------------------------------------------------

/**
 * Decodes a JWT header without verification.
 * Used to determine the algorithm before choosing verification strategy.
 */
function decodeJwtHeader(token) {
  const [headerB64] = token.split('.');
  return JSON.parse(Buffer.from(headerB64, 'base64url').toString());
}

/**
 * Decodes a JWT payload without verification.
 * Used to extract claims after signature is verified.
 */
function decodeJwtPayload(token) {
  const [, payloadB64] = token.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
}

// ---------------------------------------------------------------------------
// Signature Verification
// ---------------------------------------------------------------------------

/**
 * Verifies an ES256 (ECDSA P-256) JWT signature using JWKS public key.
 *
 * @param {string} token - Full JWT string
 * @param {object} jwk - JSON Web Key (from JWKS endpoint)
 * @returns {boolean} True if signature is valid
 */
function verifyES256(token, jwk) {
  const parts = token.split('.');
  const signedContent = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], 'base64url');

  const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });

  const verifier = crypto.createVerify('SHA256');
  verifier.update(signedContent);

  // IEEE P1363 encoding for ECDSA (not DER) — required for JWT
  return verifier.verify(
    { key: keyObject, dsaEncoding: 'ieee-p1363' },
    signature
  );
}

/**
 * Verifies an HS256 (HMAC-SHA256) JWT signature using shared secret.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param {string} token - Full JWT string
 * @param {string} secret - HMAC shared secret
 * @returns {boolean} True if signature is valid
 */
function verifyHS256(token, secret) {
  const parts = token.split('.');
  const signedContent = `${parts[0]}.${parts[1]}`;
  const providedSignature = Buffer.from(parts[2], 'base64url');

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedContent)
    .digest();

  // Timing-safe comparison — prevents leaking signature bytes via timing
  if (providedSignature.length !== expectedSignature.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedSignature, providedSignature);
}

// ---------------------------------------------------------------------------
// Main Verification Entry Point
// ---------------------------------------------------------------------------

/**
 * Verifies a Supabase JWT with dual-algorithm support.
 *
 * Flow:
 *   1. Decode header → determine algorithm
 *   2. Reject unexpected algorithms (security)
 *   3. ES256: fetch JWKS, verify with public key
 *   4. HS256: verify with shared secret (fallback)
 *   5. Validate expiry with clock skew tolerance
 *   6. Return decoded payload if valid
 *
 * @param {string} token - JWT Bearer token
 * @param {object} config - { jwksUrl, hmacSecret }
 * @returns {Promise<object>} Decoded JWT payload
 * @throws {Error} If verification fails
 */
async function verifySupabaseJWT(token, config) {
  if (!token || typeof token !== 'string') {
    throw new Error('JWT_MISSING');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('JWT_MALFORMED');
  }

  // Step 1: Decode header
  const header = decodeJwtHeader(token);

  // Step 2: Algorithm allowlist
  if (!ALLOWED_ALGORITHMS.has(header.alg)) {
    throw new Error(`JWT_UNSUPPORTED_ALGORITHM: ${header.alg}`);
  }

  // Step 3-4: Verify signature based on algorithm
  let signatureValid = false;

  if (header.alg === 'ES256') {
    const jwks = await getCachedJWKS(config.jwksUrl);
    const jwk = jwks.get(header.kid);
    if (!jwk) {
      throw new Error('JWT_UNKNOWN_KEY_ID');
    }
    signatureValid = verifyES256(token, jwk);
  } else if (header.alg === 'HS256') {
    if (!config.hmacSecret) {
      throw new Error('JWT_HMAC_SECRET_NOT_CONFIGURED');
    }
    signatureValid = verifyHS256(token, config.hmacSecret);
  }

  if (!signatureValid) {
    throw new Error('JWT_INVALID_SIGNATURE');
  }

  // Step 5: Validate expiry
  const payload = decodeJwtPayload(token);
  const now = Math.floor(Date.now() / 1000);

  if (payload.exp && payload.exp + CLOCK_SKEW_SECONDS < now) {
    throw new Error('JWT_EXPIRED');
  }

  if (payload.nbf && payload.nbf - CLOCK_SKEW_SECONDS > now) {
    throw new Error('JWT_NOT_YET_VALID');
  }

  // Step 6: Return verified payload
  return payload;
}

// ---------------------------------------------------------------------------
// Helper: HTTPS JSON Fetch (no dependencies)
// ---------------------------------------------------------------------------

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JWKS_PARSE_ERROR: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  verifySupabaseJWT,
  verifyES256,
  verifyHS256,
  decodeJwtHeader,
  decodeJwtPayload,
  getCachedJWKS,
};
