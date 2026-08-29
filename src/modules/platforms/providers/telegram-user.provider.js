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

/**
 * Ask Telegram to send a login code to `phoneNumber`.
 *
 * The code arrives in the Telegram app itself when the user is signed in
 * elsewhere, and by SMS otherwise — that's Telegram's choice, not ours.
 *
 * @param {string} phoneNumber E.164, e.g. "+919876543210"
 * @returns {Promise<{ loginId: string, timeout: number }>}
 */
export async function startLogin(phoneNumber) {
  assertConfigured();

  const client = createClient('');

  try {
    await client.connect();

    const { phoneCodeHash, isCodeViaApp } = await client.sendCode(
      { apiId: env.TELEGRAM_API_ID, apiHash: env.TELEGRAM_API_HASH },
      phoneNumber
    );

    // Random, unguessable, and meaningless outside this process — it is a
    // lookup key, never a credential.
    const loginId = crypto.randomUUID();
    putPending(loginId, { client, phoneNumber, phoneCodeHash });

    return { loginId, viaApp: Boolean(isCodeViaApp) };
  } catch (error) {
    await client.disconnect().catch(() => {});
    throw toAppError(error, 'Could not start the Telegram login.');
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
