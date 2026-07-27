// ============================================================
// Meta (Facebook) OAuth for the WhatsApp Business Cloud API.
//
// Flow: authorization code -> short-lived user token -> exchanged for a
// long-lived (~60 day) token, which is what we persist. Sending also
// needs the WhatsApp Business Account id and a phone-number id; both are
// discovered from the granted token where possible. Discovery is
// BEST-EFFORT — a token with narrower permissions still connects, it just
// stores less in extra_info for the sender to fill in later.
// ============================================================

import { env, isMetaOAuthConfigured } from '../../../config/env.js';
import { fetchJson } from '../../../utils/httpClient.js';
import { AppError } from '../../../utils/AppError.js';

export const META_SCOPES = [
  'whatsapp_business_messaging',
  'whatsapp_business_management',
  'business_management',
];

const graph = (path) => `https://graph.facebook.com/${env.META_API_VERSION}${path}`;

/** Throw an actionable 503 when the app was started without Meta config. */
export function assertConfigured() {
  if (!isMetaOAuthConfigured) {
    throw new AppError(
      503,
      'Meta / WhatsApp OAuth is not configured on this server. Set META_APP_ID, ' +
        'META_APP_SECRET and META_REDIRECT_URI.',
      { code: 'META_OAUTH_NOT_CONFIGURED' }
    );
  }
}

/**
 * Build the Facebook login dialog URL.
 * @param {string} state signed, short-lived state value
 * @returns {string}
 */
export function buildAuthorizationUrl(state) {
  assertConfigured();

  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: env.META_REDIRECT_URI,
    response_type: 'code',
    scope: META_SCOPES.join(','),
    state,
  });

  // Embedded Signup onboards a business in-dialog; only sent when configured.
  if (env.META_CONFIG_ID) params.set('config_id', env.META_CONFIG_ID);

  return `https://www.facebook.com/${env.META_API_VERSION}/dialog/oauth?${params.toString()}`;
}

/**
 * Exchange the authorization code for a short-lived token, then upgrade it
 * to a long-lived one.
 * @param {string} code
 * @returns {Promise<{ accessToken: string, expiresAt: Date | null }>}
 */
export async function exchangeCode(code) {
  assertConfigured();

  const short = await fetchJson(
    graph(
      `/oauth/access_token?${new URLSearchParams({
        client_id: env.META_APP_ID,
        client_secret: env.META_APP_SECRET,
        redirect_uri: env.META_REDIRECT_URI,
        code,
      })}`
    ),
    { provider: 'Meta' }
  );

  const long = await fetchJson(
    graph(
      `/oauth/access_token?${new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: env.META_APP_ID,
        client_secret: env.META_APP_SECRET,
        fb_exchange_token: short.access_token,
      })}`
    ),
    { provider: 'Meta' }
  );

  // A long-lived token may come back without expires_in, meaning "no expiry".
  const expiresIn = Number(long.expires_in);
  return {
    accessToken: long.access_token,
    expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
  };
}

/**
 * Discover the WhatsApp Business Account and phone number the token can
 * send from. Never throws — returns whatever it manages to resolve.
 *
 * @param {string} accessToken
 * @returns {Promise<{ businessAccountId?: string, phoneNumberId?: string, displayPhoneNumber?: string }>}
 */
export async function discoverWhatsAppTarget(accessToken) {
  try {
    // debug_token reports which WABA ids the whatsapp_business_management
    // grant was scoped to — the reliable way to find them without guessing.
    const debug = await fetchJson(
      `https://graph.facebook.com/debug_token?${new URLSearchParams({
        input_token: accessToken,
        access_token: `${env.META_APP_ID}|${env.META_APP_SECRET}`,
      })}`,
      { provider: 'Meta' }
    );

    const grants = debug?.data?.granular_scopes ?? [];
    const wabaGrant =
      grants.find((g) => g.scope === 'whatsapp_business_management') ??
      grants.find((g) => g.scope === 'whatsapp_business_messaging');

    const businessAccountId = wabaGrant?.target_ids?.[0];
    if (!businessAccountId) return {};

    const numbers = await fetchJson(
      graph(`/${businessAccountId}/phone_numbers?${new URLSearchParams({ access_token: accessToken })}`),
      { provider: 'Meta' }
    );

    const first = numbers?.data?.[0];
    return {
      businessAccountId,
      ...(first?.id ? { phoneNumberId: first.id } : {}),
      ...(first?.display_phone_number ? { displayPhoneNumber: first.display_phone_number } : {}),
    };
  } catch {
    // Narrower permissions, a personal account, or a Graph hiccup — the
    // connection is still valid, we just couldn't auto-fill the target.
    return {};
  }
}
