// ============================================================
// Google OAuth 2.0 provider (Gmail send + Contacts read).
//
// Authorization-code flow with `access_type=offline`, which is what
// yields the long-lived REFRESH token — the only credential worth
// persisting. Access tokens live ~1h and are re-derived on demand by
// getAccessToken().
//
// `prompt=consent` is deliberate: Google only returns a refresh_token on
// the FIRST authorization for a given client/user pair, so without it a
// user who reconnects gets an access token and nothing to store.
// ============================================================

import { env, isGoogleOAuthConfigured } from '../../../config/env.js';
import { fetchJson } from '../../../utils/httpClient.js';
import { AppError } from '../../../utils/AppError.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/contacts.readonly',
];

/** Throw an actionable 503 when the app was started without Google config. */
export function assertConfigured() {
  if (!isGoogleOAuthConfigured) {
    throw new AppError(
      503,
      'Google OAuth is not configured on this server. Set GOOGLE_CLIENT_ID, ' +
        'GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.',
      { code: 'GOOGLE_OAUTH_NOT_CONFIGURED' }
    );
  }
}

/**
 * Build the consent-screen URL the user's browser must visit.
 * @param {string} state signed, short-lived state value
 * @returns {string}
 */
export function buildAuthorizationUrl(state) {
  assertConfigured();

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });

  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 * @param {string} code
 * @returns {Promise<{ accessToken: string, refreshToken?: string, expiresAt: Date, scope: string }>}
 */
export async function exchangeCode(code) {
  assertConfigured();

  const payload = await fetchJson(TOKEN_URL, {
    method: 'POST',
    provider: 'Google',
    form: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: expiryFrom(payload.expires_in),
    scope: payload.scope ?? '',
  };
}

/**
 * Trade a stored refresh token for a usable access token.
 * @param {string} refreshToken
 * @returns {Promise<{ accessToken: string, expiresAt: Date }>}
 */
export async function getAccessToken(refreshToken) {
  assertConfigured();

  const payload = await fetchJson(TOKEN_URL, {
    method: 'POST',
    provider: 'Google',
    form: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });

  return { accessToken: payload.access_token, expiresAt: expiryFrom(payload.expires_in) };
}

/**
 * Who did we just connect?
 * @param {string} accessToken
 * @returns {Promise<{ email: string, name?: string, sub: string }>}
 */
export async function getUserInfo(accessToken) {
  const payload = await fetchJson(USERINFO_URL, {
    provider: 'Google',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  return { email: payload.email, name: payload.name, sub: payload.sub };
}

function expiryFrom(expiresInSeconds) {
  return new Date(Date.now() + (Number(expiresInSeconds) || 3600) * 1000);
}
