// ============================================================
// JWT helpers — issue and verify access & refresh tokens.
// Access tokens are short-lived and sent on every request.
// Refresh tokens are long-lived and exchanged for a new access token.
// The two use *different* secrets so a leaked access token can never
// be used to mint refresh tokens.
// ============================================================

import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from './AppError.js';

/**
 * @param {{ id: number, email: string }} user
 * @returns {{ accessToken: string, refreshToken: string, tokenType: 'Bearer', expiresIn: string }}
 */
export function issueTokens(user) {
  const payload = { sub: user.id, email: user.email };

  const accessToken = jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  });

  const refreshToken = jwt.sign({ sub: user.id }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  });

  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
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
