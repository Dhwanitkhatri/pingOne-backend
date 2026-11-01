// ============================================================
// JWT helpers — issue and verify access & refresh tokens.
// Access tokens are short-lived and sent on every request.
// Refresh tokens are long-lived and exchanged for a new access token.
// The two use *different* secrets so a leaked access token can never
// be used to mint refresh tokens.
//
// The refresh token also carries a random `jti`. Two logins in the same
// second would otherwise produce byte-identical JWTs (same sub/iat/exp),
// which collides with the UNIQUE index on refresh_tokens.token_hash.
// ============================================================

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from './AppError.js';

/**
 * Mint a fresh access + refresh pair.
 *
 * `refreshTokenExpiresAt` is derived from the token's own `exp` claim so the
 * DB row and the JWT can never disagree about when it dies. It is metadata
 * for the persistence layer — strip it before sending the response.
 *
 * @param {{ id: number, email: string }} user
 * @returns {{ accessToken: string, refreshToken: string, tokenType: 'Bearer',
 *            expiresIn: string, refreshTokenExpiresAt: Date }}
 */
export function issueTokens(user) {
  const accessToken = jwt.sign({ sub: user.id, email: user.email }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  });

  const refreshToken = jwt.sign(
    { sub: user.id, jti: crypto.randomUUID() },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN }
  );

  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    refreshTokenExpiresAt: new Date(jwt.decode(refreshToken).exp * 1000),
  };
}

/** Verify an access token, returning its decoded payload. */
export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch {
    throw AppError.unauthorized('Invalid or expired access token', {
      code: 'INVALID_ACCESS_TOKEN',
    });
  }
}

/** Verify a refresh token, returning its decoded payload. */
export function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET);
  } catch {
    throw AppError.unauthorized('Invalid or expired refresh token', {
      code: 'INVALID_REFRESH_TOKEN',
    });
  }
}

// ---- OAuth `state` ------------------------------------------------
// The state param has to survive a round-trip through the provider and
// come back to a callback that carries no Authorization header, so it
// must itself prove which user started the flow. A short-lived signed
// JWT does that without a database table. `typ` pins its purpose so an
// access token (same secret) can never be replayed as a state value.

const OAUTH_STATE_TYP = 'oauth_state';

/**
 * @param {{ userId: number, platform: string }} params
 * @returns {string} signed state value
 */
export function issueOAuthState({ userId, platform }) {
  return jwt.sign(
    { sub: userId, platform, typ: OAUTH_STATE_TYP, nonce: crypto.randomBytes(8).toString('hex') },
    env.JWT_ACCESS_SECRET,
    { expiresIn: `${env.OAUTH_STATE_TTL_MIN}m` }
  );
}

/**
 * Verify a state value coming back from a provider callback.
 * @param {string} state
 * @param {string} expectedPlatform
 * @returns {{ userId: number }}
 */
export function verifyOAuthState(state, expectedPlatform) {
  const invalid = AppError.badRequest(
    'This authorization link is invalid or has expired — please start again',
    { code: 'INVALID_OAUTH_STATE' }
  );

  let payload;
  try {
    payload = jwt.verify(state, env.JWT_ACCESS_SECRET);
  } catch {
    throw invalid;
  }

  if (payload.typ !== OAUTH_STATE_TYP || payload.platform !== expectedPlatform) throw invalid;

  return { userId: payload.sub };
}

// ---- Email verification ------------------------------------------
// Like the OAuth state, the link must prove which user it belongs to without
// a database table. Unlike it, it travels by email and lives for a day, so it
// is signed with its own key, derived from the access secret. Signing it with
// JWT_ACCESS_SECRET itself would let a leaked link double as a day-long access
// token, because verifyAccessToken only checks the signature. `email` is
// pinned so the link dies if the account's address ever changes.

const EMAIL_VERIFY_TYP = 'email_verify';
const EMAIL_VERIFY_SECRET = crypto
  .createHmac('sha256', env.JWT_ACCESS_SECRET)
  .update('pingone:email-verification')
  .digest('hex');

/**
 * @param {{ userId: number, email: string }} params
 * @returns {string} signed token for the emailed link
 */
export function issueEmailVerificationToken({ userId, email }) {
  return jwt.sign({ sub: userId, email, typ: EMAIL_VERIFY_TYP }, EMAIL_VERIFY_SECRET, {
    expiresIn: `${env.EMAIL_VERIFICATION_TTL_HOURS}h`,
  });
}

/**
 * @param {string} token
 * @returns {{ userId: number, email: string }}
 */
export function verifyEmailVerificationToken(token) {
  const invalid = AppError.badRequest('This verification link is invalid or has expired', {
    code: 'INVALID_VERIFICATION_TOKEN',
  });

  let payload;
  try {
    payload = jwt.verify(token, EMAIL_VERIFY_SECRET);
  } catch {
    throw invalid;
  }

  if (payload.typ !== EMAIL_VERIFY_TYP) throw invalid;

  return { userId: payload.sub, email: payload.email };
}
