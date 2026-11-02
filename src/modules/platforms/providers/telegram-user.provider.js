// ============================================================
// Telegram MTProto (user account) provider.
//
// This is the CLIENT API — the same protocol the official Telegram apps
// speak — as opposed to the Bot API used by telegram-bot.adapter.js. The
// difference that matters: a user account can message anyone it can resolve,
// including by @username, with none of the bot restrictions (no "must start
// the bot first", no chat_id capture, no invite link).
//
// ⚠️ USE THIS DELIBERATELY. Telegram's Terms of Service prohibit bulk
// unsolicited messaging, and their anti-spam system limits or permanently
// bans USER accounts that message many people who never contacted them —
// PEER_FLOOD is the first warning and it arrives quickly. The Bot API's
// restrictions exist precisely to prevent this pattern. Bot mode remains the
// compliant default; this is opt-in per user.
//
// The stored secret is a StringSession, which grants COMPLETE access to that
// account — reading every conversation, sending as that person. It is
// encrypted at rest like every other credential, but its blast radius is far
// larger than a bot token's. It is never returned by any endpoint.
// ============================================================

import crypto from 'node:crypto';
import { TelegramClient, Api, errors } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { env, isTelegramUserConfigured } from '../../../config/env.js';
import { AppError } from '../../../utils/AppError.js';

/** Login codes stay valid for a few minutes; don't hold clients longer. */
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

/** Throw an actionable 503 when the app has no MTProto application keys. */
export function assertConfigured() {
  if (!isTelegramUserConfigured) {
    throw new AppError(
      503,
      'Telegram user accounts are not configured on this server. Register an ' +
        'app at https://my.telegram.org and set TELEGRAM_API_ID and TELEGRAM_API_HASH.',
      { code: 'TELEGRAM_USER_NOT_CONFIGURED' }
    );
  }
}

/**
 * Build a client for a session string ('' for a fresh login).
 *
 * `connectionRetries` is deliberately low: a request thread waiting on a
 * retry loop is worse than a clean error the caller can act on.
 */
export function createClient(sessionString = '') {
  assertConfigured();

  return new TelegramClient(
    new StringSession(sessionString),
    env.TELEGRAM_API_ID,
    env.TELEGRAM_API_HASH,
    { connectionRetries: 2, useWAL: false, autoReconnect: false }
  );
}

/* ── Pending logins ───────────────────────────────────────────────────── */

/**
 * Half-finished logins, keyed by an opaque id handed to the client.
 *
 * MTProto login is stateful across two HTTP requests: `sendCode` establishes
 * an auth key on a live connection and returns a `phoneCodeHash` that only
 * that connection's session can complete. So the client object itself has to
 * survive between "send me a code" and "here's the code".
 *
 * LIMITATION, stated plainly: this map is per-process and in memory. A server
 * restart between the two steps loses the login (the user just requests a new
 * code), and it will not work across multiple instances behind a load
 * balancer. Moving it to Redis is the fix if this ever runs multi-instance —
 * the value would be the serialised session plus phoneCodeHash.
 */
const pendingLogins = new Map();

/** Drop expired entries. Called on each write, so no timer is needed. */
function evictExpired() {
  const now = Date.now();
  for (const [id, entry] of pendingLogins) {
    if (entry.expiresAt <= now) {
      entry.client?.disconnect?.().catch(() => {});
      pendingLogins.delete(id);
    }
  }
}

function putPending(id, entry) {
  evictExpired();
  pendingLogins.set(id, { ...entry, expiresAt: Date.now() + PENDING_LOGIN_TTL_MS });
}

function takePending(id) {
  const entry = pendingLogins.get(id);
  if (!entry || entry.expiresAt <= Date.now()) {
    pendingLogins.delete(id);
    return null;
  }
  return entry;
}

function dropPending(id) {
  const entry = pendingLogins.get(id);
  entry?.client?.disconnect?.().catch(() => {});
  pendingLogins.delete(id);
}

/* ── Step 1: request the code ─────────────────────────────────────────── */

/** auth.SentCodeType* -> where the user should look for the code. */
const DELIVERY_BY_TYPE = {
  'auth.SentCodeTypeApp': 'app',
  'auth.SentCodeTypeSms': 'sms',
  'auth.SentCodeTypeSmsWord': 'sms',
  'auth.SentCodeTypeSmsPhrase': 'sms',
  'auth.SentCodeTypeFirebaseSms': 'sms',
  'auth.SentCodeTypeFragmentSms': 'fragment_sms',
  'auth.SentCodeTypeCall': 'call',
  'auth.SentCodeTypeFlashCall': 'flash_call',
  'auth.SentCodeTypeMissedCall': 'missed_call',
  'auth.SentCodeTypeEmailCode': 'email',
  'auth.SentCodeTypeSetUpEmailRequired': 'email_setup_required',
};

/** auth.CodeType* -> what a resend would switch to. */
const NEXT_DELIVERY_BY_TYPE = {
  'auth.CodeTypeSms': 'sms',
  'auth.CodeTypeCall': 'call',
  'auth.CodeTypeFlashCall': 'flash_call',
  'auth.CodeTypeMissedCall': 'missed_call',
  'auth.CodeTypeFragmentSms': 'fragment_sms',
};

/**
 * Read where Telegram actually sent the code.
 *
 * The library's own sendCode() collapses this to a single `isCodeViaApp`
 * flag, which hid the cases where the code went to the login email, or was
 * never sent at all (email setup required, paid SMS) — the UI then told the
 * user to check their SMS for a code that wasn't coming. So the raw
 * auth.SentCode is inspected here instead, and the non-delivery cases are
 * turned into errors the user can act on.
 */
function describeSentCode(sent) {
  if (sent instanceof Api.auth.SentCodeSuccess) {
    throw AppError.badRequest('Telegram signed in without a code. Try again.', {
      code: 'TELEGRAM_USER_ERROR',
    });
  }

  if (sent?.className === 'auth.SentCodePaymentRequired') {
    throw AppError.badRequest(
      'Telegram wants a payment before it will send a login code by SMS to this number. ' +
        'Sign in to the official Telegram app on this phone first — the code is then sent there for free.',
      { code: 'TELEGRAM_CODE_PAYMENT_REQUIRED' }
    );
  }

  const delivery = DELIVERY_BY_TYPE[sent?.type?.className] ?? 'unknown';

  if (delivery === 'email_setup_required') {
    throw AppError.badRequest(
      'Telegram requires this account to have a login email before it sends a code to a new app. ' +
        'In the official Telegram app open Settings → Privacy and Security → Login Email, set one, then try again.',
      { code: 'TELEGRAM_EMAIL_SETUP_REQUIRED' }
    );
  }

  return {
    delivery,
    viaApp: delivery === 'app',
    nextDelivery: NEXT_DELIVERY_BY_TYPE[sent?.nextType?.className] ?? null,
    // Seconds before Telegram allows a resend; absent when it doesn't say.
    timeout: sent?.timeout ?? null,
    ...(delivery === 'email' && sent.type.emailPattern
      ? { emailPattern: sent.type.emailPattern }
      : {}),
  };
}

/** "+919876543210" -> "+91******10", for logs. */
function maskPhone(phoneNumber) {
  return phoneNumber.replace(/^(\+\d{2})\d+(\d{2})$/, (_, head, tail) => `${head}******${tail}`);
}

/**
 * Ask Telegram to send a login code to `phoneNumber`.
 *
 * Telegram picks the channel, not us: the Telegram app when the account is
 * signed in elsewhere, otherwise SMS, a call, or the account's login email.
 * The response says which, so the UI can tell the user where to look.
 *
 * @param {string} phoneNumber E.164, e.g. "+919876543210"
 * @returns {Promise<{ loginId: string, viaApp: boolean, delivery: string,
 *                     nextDelivery: string|null, timeout: number|null,
 *                     emailPattern?: string }>}
 */
export async function startLogin(phoneNumber) {
  assertConfigured();

  const client = createClient('');

  try {
    await client.connect();

    const sent = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber,
        apiId: env.TELEGRAM_API_ID,
        apiHash: env.TELEGRAM_API_HASH,
        settings: new Api.CodeSettings({}),
      })
    );

    console.log(
      `[telegram:user] login code for ${maskPhone(phoneNumber)}: ${sent?.className} ` +
        `type=${sent?.type?.className ?? '-'} next=${sent?.nextType?.className ?? '-'}`
    );

    const described = describeSentCode(sent);

    // Random, unguessable, and meaningless outside this process — it is a
    // lookup key, never a credential.
    const loginId = crypto.randomUUID();
    putPending(loginId, { client, phoneNumber, phoneCodeHash: sent.phoneCodeHash });

    return { loginId, ...described };
  } catch (error) {
    await client.disconnect().catch(() => {});
    throw toAppError(error, 'Could not start the Telegram login.');
  }
}

/**
 * Ask Telegram to send the code again, by its next channel (usually SMS
 * after an in-app code). For when the user can't see the first one.
 *
 * Telegram answers SEND_CODE_UNAVAILABLE when it has no other channel left,
 * and FLOOD_WAIT when asked too soon; both map to readable errors below.
 *
 * @param {string} loginId from startLogin()
 */
export async function resendLogin(loginId) {
  const pending = takePending(loginId);

  if (!pending) {
    throw AppError.badRequest(
      'That login has expired. Request a new code and try again.',
      { code: 'TELEGRAM_LOGIN_EXPIRED' }
    );
  }

  const { client, phoneNumber, phoneCodeHash } = pending;

  try {
    if (!client.connected) await client.connect();

    const sent = await client.invoke(new Api.auth.ResendCode({ phoneNumber, phoneCodeHash }));

    console.log(
      `[telegram:user] resent login code for ${maskPhone(phoneNumber)}: ${sent?.className} ` +
        `type=${sent?.type?.className ?? '-'} next=${sent?.nextType?.className ?? '-'}`
    );

    const described = describeSentCode(sent);

    // The resend issues a new hash; the old one no longer signs in.
    putPending(loginId, { ...pending, phoneCodeHash: sent.phoneCodeHash });

    return { loginId, ...described };
  } catch (error) {
    // The first code may still be valid — keep the login so the user can enter it.
    putPending(loginId, pending);
    throw toAppError(error, 'Could not resend the Telegram code.');
  }
}

/* ── Step 2: submit the code (and 2FA password if set) ────────────────── */

/**
 * Complete a login and return the session to persist.
 *
 * Telegram answers `SESSION_PASSWORD_NEEDED` when the account has
 * two-step verification enabled — that isn't a failure, it's a second
 * factor, so it's surfaced as its own code for the UI to prompt on.
 *
 * @param {{ loginId: string, code: string, password?: string }} input
 * @returns {Promise<{ session: string, user: object }>}
 */
export async function completeLogin({ loginId, code, password }) {
  const pending = takePending(loginId);

  if (!pending) {
    throw AppError.badRequest(
      'That login has expired. Request a new code and try again.',
      { code: 'TELEGRAM_LOGIN_EXPIRED' }
    );
  }

  const { client, phoneNumber, phoneCodeHash } = pending;

  try {
    if (!client.connected) await client.connect();

    try {
      await client.invoke(
        new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode: code })
      );
    } catch (error) {
      if (error?.errorMessage !== 'SESSION_PASSWORD_NEEDED') throw error;

      // Two-step verification. Keep the pending login alive so the client can
      // come straight back with the password instead of re-requesting a code.
      if (!password) {
        putPending(loginId, pending);
        throw AppError.badRequest(
          'This account has two-step verification enabled. Send the password too.',
          { code: 'TELEGRAM_PASSWORD_REQUIRED' }
        );
      }

      await client.signInWithPassword(
        { apiId: env.TELEGRAM_API_ID, apiHash: env.TELEGRAM_API_HASH },
        {
          password: async () => password,
          onError: (err) => {
            throw err;
          },
        }
      );
    }

    const me = await client.getMe();
    const session = client.session.save();

    dropPending(loginId);

    return {
      session,
      user: {
        id: String(me.id),
        username: me.username ? `@${me.username}` : null,
        firstName: me.firstName ?? null,
        lastName: me.lastName ?? null,
        phone: me.phone ? `+${me.phone}` : phoneNumber,
      },
    };
  } catch (error) {
    // A wrong code is retryable — keep the pending login so the user gets
    // another go without a fresh SMS.
    if (error instanceof AppError) throw error;

    if (isRetryableCodeError(error)) {
      putPending(loginId, pending);
    } else {
      dropPending(loginId);
    }

    throw toAppError(error, 'Could not complete the Telegram login.');
  }
}

/** Abandon a half-finished login (user closed the dialog). */
export function cancelLogin(loginId) {
  dropPending(loginId);
}

/* ── Error translation ────────────────────────────────────────────────── */

const RETRYABLE_CODE_ERRORS = new Set([
  'PHONE_CODE_INVALID',
  'PHONE_CODE_EMPTY',
  'PASSWORD_HASH_INVALID',
]);

function isRetryableCodeError(error) {
  return RETRYABLE_CODE_ERRORS.has(error?.errorMessage);
}

/**
 * MTProto errors are terse constants. Map the ones a user can actually do
 * something about; everything else keeps the provider's own text.
 */
const MESSAGES = {
  PHONE_NUMBER_INVALID: 'That phone number isn\'t valid. Include the country code, e.g. +919876543210.',
  PHONE_NUMBER_BANNED: 'Telegram has banned this phone number.',
  PHONE_CODE_INVALID: 'That code is incorrect.',
  PHONE_CODE_EXPIRED: 'That code has expired. Request a new one.',
  PHONE_CODE_EMPTY: 'Enter the code Telegram sent you.',
  PASSWORD_HASH_INVALID: 'That two-step verification password is incorrect.',
  SESSION_PASSWORD_NEEDED: 'This account has two-step verification enabled.',
  PHONE_NUMBER_FLOOD: 'Too many login attempts for this number. Wait a while before trying again.',
  AUTH_RESTART: 'Telegram asked us to restart the login. Request a new code.',
  SEND_CODE_UNAVAILABLE: 'Telegram has no other way to send the code right now. Check the Telegram app on your other devices, or start again later.',
  PHONE_NUMBER_UNOCCUPIED: 'No Telegram account uses this phone number. Sign up in the Telegram app first.',
};

export function toAppError(error, fallback) {
  if (error instanceof AppError) return error;

  const code = error?.errorMessage;

  // FLOOD_WAIT_<seconds> — Telegram is rate-limiting us and says for how long.
  if (typeof code === 'string' && code.startsWith('FLOOD_WAIT_')) {
    const seconds = Number(code.slice('FLOOD_WAIT_'.length)) || 0;
    const minutes = Math.ceil(seconds / 60);
    return AppError.badRequest(
      `Telegram is rate-limiting this account. Try again in about ${
        minutes > 1 ? `${minutes} minutes` : `${seconds} seconds`
      }.`,
      { code: 'TELEGRAM_FLOOD_WAIT', details: { retryAfterSeconds: seconds } }
    );
  }

  if (code && MESSAGES[code]) {
    return AppError.badRequest(MESSAGES[code], { code: `TELEGRAM_${code}` });
  }

  if (error instanceof errors.RPCError) {
    return AppError.badRequest(`Telegram rejected the request: ${code}`, {
      code: 'TELEGRAM_RPC_ERROR',
    });
  }

  return AppError.badRequest(error?.message || fallback, {
    code: 'TELEGRAM_USER_ERROR',
  });
}

/**
 * Confirm a stored session still works, and read back who it belongs to.
 * Used when connecting, and defensively before a send.
 */
export async function describeSession(sessionString) {
  const client = createClient(sessionString);

  try {
    await client.connect();

    if (!(await client.checkAuthorization())) {
      throw AppError.badRequest(
        'This Telegram session is no longer valid — the account signed it out. Reconnect.',
        { code: 'TELEGRAM_SESSION_REVOKED' }
      );
    }

    const me = await client.getMe();
    return {
      id: String(me.id),
      username: me.username ? `@${me.username}` : null,
      firstName: me.firstName ?? null,
      phone: me.phone ? `+${me.phone}` : null,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}
