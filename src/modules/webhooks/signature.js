// ============================================================
// Webhook authentication.
//
// These endpoints are public — they have to be, the platforms call them —
// which makes them the one place in the API where an unauthenticated stranger
// can write to message_deliveries. So every request must prove it came from
// the platform it claims to:
//
//   WhatsApp/Meta  X-Hub-Signature-256: HMAC-SHA256 of the raw body, keyed
//                  with the app secret. Requires the *exact* bytes Meta
//                  signed — see the express.json({ verify }) hook in app.js
//                  that stashes req.rawBody.
//
//   Telegram       Bot API has no body signature. Instead setWebhook takes a
//                  `secret_token` that Telegram echoes in a header on every
//                  update, so we compare that.
//
//   Twilio         X-Twilio-Signature: HMAC-SHA1 over the full URL it called
//                  plus the sorted POST params, keyed with the AUTH TOKEN of
//                  the account that sent the message — the server's own for
//                  WhatsApp-via-Twilio, a user's stored one for their SMS.
//                  Checked with the official `twilio` helper.
//
// Comparisons use timingSafeEqual. A plain === leaks how much of a candidate
// signature was correct through response timing, which is enough to forge one
// byte at a time.
// ============================================================

import crypto from 'node:crypto';
import twilio from 'twilio';
import { AppError } from '../../utils/AppError.js';
import { env } from '../../config/env.js';
import { prisma } from '../../config/prisma.js';
import { decryptToken } from '../../utils/crypto.js';

/**
 * Verify Meta's X-Hub-Signature-256 against the raw request body.
 * @throws {AppError} 401 if the header is missing/malformed, 403 if it doesn't match
 */
export function verifyMetaSignature(req) {
  if (!env.META_APP_SECRET) {
    throw new AppError(503, 'WhatsApp webhooks are not configured — META_APP_SECRET is unset', {
      code: 'WEBHOOK_NOT_CONFIGURED',
    });
  }

  const header = req.get('X-Hub-Signature-256');
  if (!header?.startsWith('sha256=')) {
    throw AppError.unauthorized('Missing or malformed X-Hub-Signature-256 header', {
      code: 'WEBHOOK_SIGNATURE_MISSING',
    });
  }

  // Without the raw bytes we cannot verify anything. Failing closed here is
  // deliberate: re-serialising req.body would produce different bytes than
  // Meta signed (key order, whitespace) and the check would silently never pass.
  if (!req.rawBody) {
    throw new AppError(500, 'Raw request body was not captured — cannot verify webhook signature', {
      code: 'WEBHOOK_RAW_BODY_MISSING',
    });
  }

  const expected = crypto
    .createHmac('sha256', env.META_APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  if (!timingSafeEquals(header.slice('sha256='.length), expected)) {
    throw AppError.forbidden('Webhook signature does not match', {
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
  }

  return true;
}

/**
 * Meta's one-time subscription handshake: it GETs the endpoint with a verify
 * token and a challenge, and expects the challenge echoed back verbatim.
 * @returns {string} the challenge to echo
 */
export function verifyMetaSubscription(query) {
  if (!env.META_WEBHOOK_VERIFY_TOKEN) {
    throw new AppError(503, 'WhatsApp webhooks are not configured — META_WEBHOOK_VERIFY_TOKEN is unset', {
      code: 'WEBHOOK_NOT_CONFIGURED',
    });
  }

  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode !== 'subscribe' || !timingSafeEquals(token, env.META_WEBHOOK_VERIFY_TOKEN)) {
    throw AppError.forbidden('Webhook verification failed', {
      code: 'WEBHOOK_VERIFY_TOKEN_INVALID',
    });
  }

  return String(challenge ?? '');
}

/** Verify the secret Telegram echoes back in X-Telegram-Bot-Api-Secret-Token. */
export function verifyTelegramSecret(req) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    throw new AppError(503, 'Telegram webhooks are not configured — TELEGRAM_WEBHOOK_SECRET is unset', {
      code: 'WEBHOOK_NOT_CONFIGURED',
    });
  }

  const provided = req.get('X-Telegram-Bot-Api-Secret-Token');
  if (!timingSafeEquals(provided, env.TELEGRAM_WEBHOOK_SECRET)) {
    throw AppError.forbidden('Telegram webhook secret does not match', {
      code: 'WEBHOOK_SECRET_INVALID',
    });
  }

  return true;
}

/**
 * Verify Twilio's X-Twilio-Signature (status callbacks and inbound messages).
 *
 * The URL must be byte-for-byte the one Twilio called. Behind Render's proxy
 * req.protocol/host aren't trustworthy, so it's rebuilt from PUBLIC_BASE_URL —
 * the same base twilioStatusCallbackUrl() hands Twilio in the first place.
 *
 * @throws {AppError} 401 if the header is missing, 403 if it doesn't match
 */
export async function verifyTwilioSignature(req) {
  const signature = req.get('X-Twilio-Signature');
  if (!signature) {
    throw AppError.unauthorized('Missing X-Twilio-Signature header', { code: 'WEBHOOK_SIGNATURE_MISSING' });
  }

  const authToken = await twilioAuthTokenFor(req.body?.AccountSid);
  const url = `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}${req.originalUrl}`;

  if (!authToken || !twilio.validateRequest(authToken, signature, url, req.body ?? {})) {
    throw AppError.forbidden('Twilio webhook signature does not match', { code: 'WEBHOOK_SIGNATURE_INVALID' });
  }
  return true;
}

/** The auth token of the Twilio account a callback is about, or null if it isn't one of ours. */
async function twilioAuthTokenFor(accountSid) {
  if (!accountSid) return null;
  if (accountSid === env.TWILIO_ACCOUNT_SID) return env.TWILIO_AUTH_TOKEN ?? null;

  // A user's own Twilio account, connected for SMS: their token is stored
  // encrypted, keyed by the account sid kept alongside it.
  const credential = await prisma.userPlatformCredential.findFirst({
    where: { platform: { code: 'sms' }, extraInfo: { path: ['account_sid'], equals: accountSid } },
    select: { encryptedToken: true, tokenIv: true },
  });
  return credential ? decryptToken(credential.encryptedToken, credential.tokenIv) : null;
}

/**
 * Constant-time string comparison. timingSafeEqual throws on length mismatch,
 * so hash both sides first — that makes every comparison the same fixed width
 * and stops the length itself from being an oracle.
 */
function timingSafeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}
