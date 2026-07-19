// ============================================================
// Credentials service — connect a user's messaging platform account.
//
// Shared flow for all four platforms:
//   1. resolve the platform id from its code (platforms reference table)
//   2. AES-256-GCM encrypt the platform secret (token) -> encrypted_token + token_iv
//   3. upsert one row per (user, platform) into user_platform_credentials
//      so re-connecting simply refreshes the stored credential
//
// The plaintext token never leaves this layer, and no response ever
// includes encrypted_token / token_iv.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { encryptToken } from '../../utils/crypto.js';
import { AppError } from '../../utils/AppError.js';

// platform code -> id rarely changes after seeding; cache the lookups.
const platformIdCache = new Map();

async function getPlatformId(code) {
  if (platformIdCache.has(code)) return platformIdCache.get(code);

  const platform = await prisma.platform.findUnique({ where: { code } });
  if (!platform) {
    throw new AppError(500, `Platform "${code}" is not seeded — run \`npm run db:seed\``, {
      code: 'PLATFORM_NOT_SEEDED',
    });
  }
  platformIdCache.set(code, platform.id);
  return platform.id;
}

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
 * @returns the stored credential (without the secret).
 */
async function connect({ userId, platformCode, secret, extraInfo = {}, expiresAt = null }) {
  const platformId = await getPlatformId(platformCode);
  const { encryptedToken, iv } = encryptToken(secret);

  const data = {
    encryptedToken,
    tokenIv: iv,
    extraInfo,
    expiresAt,
    isActive: true,
  };

  return prisma.userPlatformCredential.upsert({
    where: { userId_platformId: { userId, platformId } },
    create: { userId, platformId, ...data },
    update: data,
    select: publicSelect,
  });
}

// ---- per-platform entry points -----------------------------------

export function connectWhatsApp(userId, { accessToken, phoneNumberId, businessAccountId }) {
  return connect({
    userId,
    platformCode: 'whatsapp',
    secret: accessToken,
    extraInfo: {
      phone_number_id: phoneNumberId,
      ...(businessAccountId ? { business_account_id: businessAccountId } : {}),
    },
  });
}

export function connectTelegram(userId, { botToken, botUsername }) {
  const handle = botUsername
    ? botUsername.startsWith('@')
      ? botUsername
      : `@${botUsername}`
    : undefined;

  return connect({
    userId,
    platformCode: 'telegram',
    secret: botToken,
    extraInfo: { ...(handle ? { bot_username: handle } : {}) },
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

export function connectTwilio(userId, { accountSid, authToken, twilioNumber }) {
  return connect({
    userId,
    platformCode: 'sms',
    secret: authToken,
    extraInfo: { twilio_number: twilioNumber, account_sid: accountSid },
  });
}
