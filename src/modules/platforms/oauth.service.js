// ============================================================
// OAuth orchestration — the two-legged browser flows.
//
//   start*()     runs while the user is authenticated: it signs a state
//                value carrying their id and returns the provider's
//                consent URL.
//   complete*()  runs on the provider's redirect back, which carries NO
//                Authorization header — the signed state is what proves
//                who started the flow.
//
// The credential itself is stored by the platforms service, so the
// encryption path is identical to the manually-entered platforms.
// ============================================================

import { issueOAuthState, verifyOAuthState } from '../../utils/token.js';
import { AppError } from '../../utils/AppError.js';
import * as google from './providers/google.provider.js';
import * as meta from './providers/meta.provider.js';
import * as platformsService from './platforms.service.js';

// ---- Google / Gmail ------------------------------------------------

/** @returns {{ authorizationUrl: string, state: string, expiresInMinutes: number }} */
export function startGoogle(userId) {
  google.assertConfigured();

  const state = issueOAuthState({ userId, platform: 'google' });
  return { authorizationUrl: google.buildAuthorizationUrl(state), state };
}

/**
 * Finish the Google flow: validate state, swap the code for tokens, note
 * which mailbox was connected, and store the refresh token encrypted.
 */
export async function completeGoogle({ code, state }) {
  const { userId } = verifyOAuthState(state, 'google');

  const tokens = await google.exchangeCode(code);

  // Google only issues a refresh token when the user actually re-consents.
  // Without one there is nothing durable to store, so fail loudly.
  if (!tokens.refreshToken) {
    throw AppError.badRequest(
      'Google did not return a refresh token. Remove PingOne from your Google account ' +
        'permissions (myaccount.google.com/permissions) and connect again.',
      { code: 'NO_REFRESH_TOKEN' }
    );
  }

  const profile = await google.getUserInfo(tokens.accessToken);

  const credential = await platformsService.connectGoogle(userId, {
    gmailAddress: profile.email,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });

  return { userId, platform: 'gmail', account: profile.email, credential };
}

// ---- Meta / WhatsApp -----------------------------------------------

/** @returns {{ authorizationUrl: string, state: string }} */
export function startMeta(userId) {
  meta.assertConfigured();

  const state = issueOAuthState({ userId, platform: 'meta' });
  return { authorizationUrl: meta.buildAuthorizationUrl(state), state };
}

/**
 * Finish the Meta flow. The WhatsApp Business Account / phone-number id are
 * discovered best-effort; when they can't be resolved the credential is
 * still stored and the response says the target is pending.
 */
export async function completeMeta({ code, state }) {
  const { userId } = verifyOAuthState(state, 'meta');

  const { accessToken, expiresAt } = await meta.exchangeCode(code);
  const target = await meta.discoverWhatsAppTarget(accessToken);

  const credential = await platformsService.connectWhatsApp(userId, {
    accessToken,
    phoneNumberId: target.phoneNumberId ?? null,
    businessAccountId: target.businessAccountId,
    expiresAt,
  });

  return {
    userId,
    platform: 'whatsapp',
    account: target.displayPhoneNumber ?? target.businessAccountId ?? null,
    needsPhoneNumberId: !target.phoneNumberId,
    credential,
  };
}
