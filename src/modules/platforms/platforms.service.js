// ============================================================
// Platform credentials service — connect a user's messaging accounts.
//
// Shared flow for every platform:
//   1. resolve the platform id from its code (platforms reference table)
//   2. AES-256-GCM encrypt the platform secret -> encrypted_token + token_iv
//   3. upsert one row per (user, platform) into user_platform_credentials,
//      so re-connecting simply refreshes the stored credential
//
// The plaintext secret never leaves this layer: nothing returned from here
// contains encrypted_token, token_iv, or the decrypted value — except
// getDecryptedCredential(), which exists for internal senders/importers.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { encryptToken, decryptToken } from '../../utils/crypto.js';
import { getPlatformId } from '../../utils/platforms.js';
import { fetchJson } from '../../utils/httpClient.js';
import { AppError } from '../../utils/AppError.js';

// Fields safe to return to the client (never the secret / iv).
const publicSelect = {
  id: true,
  platform: { select: { code: true, name: true } },
  extraInfo: true,
  isActive: true,
  connectedAt: true,
  expiresAt: true,
  updatedAt: true,
};

/**
 * Encrypt the secret and upsert the credential for (userId, platformCode).
 * @returns {Promise<object>} the stored credential, without the secret.
 */
async function connect({ userId, platformCode, secret, extraInfo = {}, expiresAt = null }) {
  const platformId = await getPlatformId(platformCode);
  const { encryptedToken, iv } = encryptToken(secret);

  const data = { encryptedToken, tokenIv: iv, extraInfo, expiresAt, isActive: true };

  return prisma.userPlatformCredential.upsert({
    where: { userId_platformId: { userId, platformId } },
    create: { userId, platformId, ...data },
    update: data,
    select: publicSelect,
  });
}

// ---- reads --------------------------------------------------------

/** Every platform this user has connected. */
export function listCredentials(userId) {
  return prisma.userPlatformCredential.findMany({
    where: { userId },
    select: publicSelect,
    orderBy: { connectedAt: 'asc' },
  });
}

/**
 * Fetch and DECRYPT a stored credential. For server-side use only
 * (contact import, message senders) — never return this from a route.
 *
 * @param {number} userId
 * @param {string} platformCode
 * @returns {Promise<{ secret: string, extraInfo: object, expiresAt: Date | null }>}
 */
export async function getDecryptedCredential(userId, platformCode) {
  const platformId = await getPlatformId(platformCode);

  const credential = await prisma.userPlatformCredential.findUnique({
    where: { userId_platformId: { userId, platformId } },
  });

  if (!credential || !credential.isActive) {
    throw AppError.badRequest(`No active ${platformCode} account is connected`, {
      code: 'PLATFORM_NOT_CONNECTED',
      details: { platform: platformCode },
    });
  }

  return {
    secret: decryptToken(credential.encryptedToken, credential.tokenIv),
    extraInfo: credential.extraInfo ?? {},
    expiresAt: credential.expiresAt,
  };
}

/** Disconnect a platform: the row (and its encrypted secret) is removed. */
export async function disconnect(userId, platformCode) {
  const platformId = await getPlatformId(platformCode);

  const { count } = await prisma.userPlatformCredential.deleteMany({
    where: { userId, platformId },
  });

  if (!count) {
    throw AppError.notFound(`No ${platformCode} account is connected`, {
      code: 'PLATFORM_NOT_CONNECTED',
    });
  }

  return { platform: platformCode, disconnected: true };
}

// ---- per-platform entry points ------------------------------------

export function connectWhatsApp(userId, { accessToken, phoneNumberId, businessAccountId, expiresAt }) {
  return connect({
    userId,
    platformCode: 'whatsapp',
    secret: accessToken,
    extraInfo: {
      phone_number_id: phoneNumberId,
      ...(businessAccountId ? { business_account_id: businessAccountId } : {}),
    },
    expiresAt: expiresAt ?? null,
  });
}

/**
 * Connect a Telegram bot. The token is verified against getMe first, so a
 * typo fails here instead of silently at send time — and the bot's real
 * username is recorded rather than whatever the user typed.
 */
export async function connectTelegram(userId, { botToken }) {
  const me = await fetchJson(`https://api.telegram.org/bot${botToken}/getMe`, {
    provider: 'Telegram',
  }).catch((err) => {
    // Telegram answers a bad token with 401/404 — that's user error, not an outage.
    if (err.details?.status === 401 || err.details?.status === 404) {
      throw AppError.badRequest('Telegram rejected that bot token — check it with @BotFather', {
        code: 'INVALID_BOT_TOKEN',
      });
    }
    throw err;
  });

  const bot = me?.result ?? {};

  return connect({
    userId,
    platformCode: 'telegram',
    secret: botToken,
    extraInfo: {
      ...(bot.username ? { bot_username: `@${bot.username}` } : {}),
      ...(bot.id ? { bot_id: bot.id } : {}),
      ...(bot.first_name ? { bot_name: bot.first_name } : {}),
    },
  });
}

export function connectGoogle(userId, { gmailAddress, refreshToken, expiresAt }) {
  return connect({
    userId,
    platformCode: 'gmail',
    secret: refreshToken, // the OAuth refresh token is the long-lived secret
    extraInfo: { gmail_address: gmailAddress },
    expiresAt: expiresAt ?? null,
  });
}

/**
 * Connect Twilio (SMS). Credentials are verified by fetching the account,
 * which also confirms the SID and auth token actually pair up.
 */
export async function connectTwilio(userId, { accountSid, authToken, twilioNumber }) {
  const basic = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const account = await fetchJson(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`,
    { provider: 'Twilio', headers: { Authorization: `Basic ${basic}` } }
  ).catch((err) => {
    if (err.details?.status === 401 || err.details?.status === 404) {
      throw AppError.badRequest('Twilio rejected those credentials — check the SID and auth token', {
        code: 'INVALID_TWILIO_CREDENTIALS',
      });
    }
    throw err;
  });

  return connect({
    userId,
    platformCode: 'sms',
    secret: authToken,
    extraInfo: {
      account_sid: accountSid,
      twilio_number: twilioNumber,
      ...(account?.friendly_name ? { account_name: account.friendly_name } : {}),
    },
  });
}
