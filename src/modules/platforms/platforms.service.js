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
import { env, isTelegramPollingEnabled } from '../../config/env.js';
import * as telegramUser from './providers/telegram-user.provider.js';
import { TELEGRAM_MODES, telegramModeOf } from '../../platforms/telegram.adapter.js';

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

/**
 * Connect WhatsApp Cloud. The token/phone-number pair is verified against the
 * Graph API first, so a typo or an expired token fails here instead of
 * silently at send time — the same contract Telegram and Twilio already offer.
 *
 * Verification is SKIPPED when no phoneNumberId is supplied: the OAuth flow
 * stores a credential whose target could not be auto-discovered, and that is a
 * legitimate pending state (completeMeta reports `needsPhoneNumberId`).
 */
export async function connectWhatsApp(
  userId,
  { accessToken, phoneNumberId, businessAccountId, expiresAt }
) {
  businessAccountId = businessAccountId ?? env.META_WABA_ID;
  // OAuth discovery can miss the number even when the WABA is known (e.g. from
  // META_WABA_ID) — ask the WABA directly before settling for a pending row.
  if (!phoneNumberId && businessAccountId) {
    phoneNumberId = await findWhatsAppNumberId(accessToken, businessAccountId);
  }
  const number = phoneNumberId ? await verifyWhatsAppNumber(accessToken, phoneNumberId) : {};

  return connect({
    userId,
    platformCode: 'whatsapp',
    secret: accessToken,
    extraInfo: {
      phone_number_id: phoneNumberId,
      ...(businessAccountId ? { business_account_id: businessAccountId } : {}),
      ...(number.display_phone_number ? { display_phone_number: number.display_phone_number } : {}),
      ...(number.verified_name ? { verified_name: number.verified_name } : {}),
    },
    expiresAt: expiresAt ?? null,
  });
}

/** First phone number on the WABA, or null. Best-effort — never throws. */
async function findWhatsAppNumberId(accessToken, businessAccountId) {
  const numbers = await fetchJson(
    `https://graph.facebook.com/${env.META_API_VERSION}/${businessAccountId}/phone_numbers`,
    { provider: 'Meta', headers: { Authorization: `Bearer ${accessToken}` } }
  ).catch(() => null);
  return numbers?.data?.[0]?.id ?? null;
}

/**
 * Read the phone number back from Graph, which proves three things at once:
 * the token is valid, it hasn't expired, and it is actually scoped to that
 * phone-number id. Returns the number's own details so we record Meta's
 * values rather than whatever the caller typed.
 */
async function verifyWhatsAppNumber(accessToken, phoneNumberId) {
  return fetchJson(`https://graph.facebook.com/${env.META_API_VERSION}/${phoneNumberId}`, {
    provider: 'Meta',
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch((err) => {
    // 400/401/403 from Graph is a bad credential — user error, not an outage.
    const status = err.details?.status;
    if (status === 400 || status === 401 || status === 403) {
      throw AppError.badRequest(
        'Meta rejected that WhatsApp token or phone number id. Check both on the ' +
          'WhatsApp → API Setup page; temporary tokens expire after 24 hours.',
        { code: 'INVALID_WHATSAPP_CREDENTIAL', details: err.details?.body?.error?.message }
      );
    }
    throw err;
  });
}

/**
 * WhatsApp templates the composer can offer: Meta's approved ones plus any
 * Twilio trial templates configured in TWILIO_WHATSAPP_TEMPLATES. With Twilio
 * templates on hand, a Meta failure (locked account, no WABA) only empties
 * Meta's half of the list instead of failing the whole request.
 */
export async function listWhatsAppTemplates(userId) {
  const twilio = twilioWhatsAppTemplates();
  if (!twilio.length) return listMetaWhatsAppTemplates(userId);

  const meta = await listMetaWhatsAppTemplates(userId).catch((err) => {
    console.warn(`[whatsapp] could not list Meta templates, offering Twilio's only: ${err.message}`);
    return [];
  });
  return [...meta, ...twilio];
}

/** TWILIO_WHATSAPP_TEMPLATES in the composer's template shape, tagged with their ContentSid. */
function twilioWhatsAppTemplates() {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return [];
  return env.TWILIO_WHATSAPP_TEMPLATES.map(({ sid, name, body, language }) => ({
    name,
    language,
    category: 'TWILIO',
    contentSid: sid,
    components: [{ type: 'BODY', text: body }],
  }));
}

/** List the connected user's approved Meta WhatsApp message templates. */
async function listMetaWhatsAppTemplates(userId) {
  const { secret: accessToken, extraInfo } = await getDecryptedCredential(userId, 'whatsapp');
  const businessAccountId = extraInfo.business_account_id ?? env.META_WABA_ID;
  if (!businessAccountId) {
    throw AppError.badRequest(
      'WhatsApp Business Account ID is missing. Set META_WABA_ID in pingOne-backend/.env and restart the backend, or reconnect WhatsApp with its WABA ID.',
      { code: 'WHATSAPP_WABA_ID_MISSING' }
    );
  }

  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${businessAccountId}/message_templates?${new URLSearchParams({
    fields: 'name,language,status,category,components',
    limit: '100',
  })}`;
  const response = await fetchJson(url, {
    provider: 'Meta',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  return (response.data ?? [])
    .filter((template) => {
      if (template.status !== 'APPROVED') return false;
      const header = template.components?.find((component) => component.type === 'HEADER');
      const body = template.components?.find((component) => component.type === 'BODY');
      const variables = body?.text?.match(/{{\s*([^{}]+?)\s*}}/g) ?? [];
      const positions = [...new Set(variables.map((variable) => Number(variable.match(/\d+/)?.[0])))].sort((a, b) => a - b);
      // This first dashboard version supports text body parameters, but not
      // media/dynamic headers, named parameters, or interactive button params.
      return Boolean(body?.text) &&
        (!header || (header.format === 'TEXT' && !/{{\s*[^{}]+?\s*}}/.test(header.text ?? ''))) &&
        variables.every((variable) => /^{{\s*\d+\s*}}$/.test(variable)) &&
        positions.every((position, index) => position === index + 1) &&
        !template.components?.some((component) => component.type === 'BUTTONS');
    })
    .map(({ name, language, category, components = [] }) => ({
      name,
      language,
      category,
      components: components
        .filter((component) => ['HEADER', 'BODY'].includes(component.type))
        .map(({ type, format, text }) => ({ type, format, text })),
    }));
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

  const credential = await connect({
    userId,
    platformCode: 'telegram',
    secret: botToken,
    extraInfo: {
      // Explicit, even though it's the default the dispatcher assumes — a
      // credential that says which mode it is beats one you have to infer.
      mode: TELEGRAM_MODES.BOT,
      ...(bot.username ? { bot_username: `@${bot.username}` } : {}),
      ...(bot.id ? { bot_id: bot.id } : {}),
      ...(bot.first_name ? { bot_name: bot.first_name } : {}),
    },
  });

  await registerTelegramWebhook(botToken, bot.username ? `@${bot.username}` : 'bot');

  return credential;
}

/* ── Telegram bot webhook registration ────────────────────────────────── */

/**
 * Where Telegram should POST this deployment's bot updates, or null when
 * webhooks can't or shouldn't be used here.
 *
 * Without a registered webhook (and with polling off, the production default)
 * Telegram holds every update on its side and the app never sees a contact
 * press Start — so no chat_id is ever captured and every bot send fails
 * TELEGRAM_NOT_LINKED even for contacts who did everything right. Telegram
 * only accepts HTTPS, signature.js rejects updates without the shared
 * secret, and a webhook would make the getUpdates poller stand down, so all
 * three must line up.
 */
function telegramWebhookUrl() {
  if (isTelegramPollingEnabled) return null;
  if (!env.TELEGRAM_WEBHOOK_SECRET) return null;
  if (!env.PUBLIC_BASE_URL.startsWith('https://')) return null;

  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}${env.API_PREFIX}/webhooks/telegram`;
}

/**
 * Point a bot's updates at POST /webhooks/telegram. Idempotent.
 *
 * Best-effort: a failure is logged, never thrown, because the token itself
 * is valid and the connection should still succeed. Pending updates are kept
 * (no `drop_pending_updates`), so contacts who pressed Start before the
 * webhook existed are linked as soon as Telegram redelivers them.
 */
export async function registerTelegramWebhook(botToken, label = 'bot') {
  const url = telegramWebhookUrl();
  if (!url) return false;

  try {
    await fetchJson(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      provider: 'Telegram',
      json: {
        url,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        // Same set the poller asks for — the only updates the handler acts on.
        allowed_updates: ['message', 'edited_message', 'my_chat_member'],
      },
    });
    console.log(`[telegram] webhook registered for ${label}`);
    return true;
  } catch (err) {
    console.warn(`[telegram] could not register the webhook for ${label}: ${err.message}`);
    return false;
  }
}

/**
 * Register the webhook for every connected bot. Run at API boot so bots
 * connected before registration existed — or under a different secret or
 * host — start receiving updates without each user reconnecting.
 */
export async function registerAllTelegramWebhooks() {
  if (!telegramWebhookUrl()) return;

  const platformId = await getPlatformId('telegram');
  const credentials = await prisma.userPlatformCredential.findMany({
    where: { platformId, isActive: true },
    select: { userId: true, encryptedToken: true, tokenIv: true, extraInfo: true },
  });

  // Several users can connect the same bot; one setWebhook per token is enough.
  const tokens = new Map();
  for (const credential of credentials) {
    if (telegramModeOf(credential) === TELEGRAM_MODES.USER) continue;
    try {
      const token = decryptToken(credential.encryptedToken, credential.tokenIv);
      if (!tokens.has(token)) {
        tokens.set(token, credential.extraInfo?.bot_username ?? `user ${credential.userId}'s bot`);
      }
    } catch (err) {
      console.warn(`[telegram] skipping user ${credential.userId}: token could not be decrypted (${err.message})`);
    }
  }

  for (const [token, label] of tokens) {
    await registerTelegramWebhook(token, label);
  }
}

/* ── Telegram as a real user account (MTProto) ────────────────────────── */

/**
 * Step 1 of the user-account login: ask Telegram to send a code.
 *
 * Nothing is stored yet — the half-finished login lives in the provider's
 * in-memory map until the code comes back. `loginId` is the opaque handle to
 * it, not a credential.
 */
export function startTelegramUserLogin(_userId, { phoneNumber }) {
  return telegramUser.startLogin(phoneNumber);
}

/**
 * Step 2: submit the code (plus the 2FA password when the account has one)
 * and persist the resulting session.
 *
 * ⚠️ The stored secret is a StringSession — FULL access to that Telegram
 * account, not a scoped token. It is encrypted at rest by `connect()` like
 * every other secret and is never returned by any endpoint, but the blast
 * radius of a leak is the user's entire Telegram identity. See the ToS
 * warning in providers/telegram-user.provider.js before enabling this for
 * broadcast traffic.
 */
export async function connectTelegramUser(userId, { loginId, code, password }) {
  const { session, user } = await telegramUser.completeLogin({ loginId, code, password });

  return connect({
    userId,
    platformCode: 'telegram',
    secret: session,
    extraInfo: {
      mode: TELEGRAM_MODES.USER,
      // Identity only — enough for the UI to show whose account is connected.
      // No part of the session is copied here; extraInfo is returned to the
      // client in the clear.
      user_id: user.id,
      ...(user.username ? { username: user.username } : {}),
      ...(user.firstName ? { first_name: user.firstName } : {}),
      ...(user.phone ? { phone: user.phone } : {}),
    },
  });
}

/** Abandon a half-finished login (the user closed the dialog). */
export function cancelTelegramUserLogin(_userId, { loginId }) {
  telegramUser.cancelLogin(loginId);
  return { cancelled: true };
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

/**
 * Connect Twilio via Twilio Connect. The account was already verified by the
 * provider (fetchAuthorizedAccount) during the callback, so there is nothing
 * left to check here.
 *
 * The stored secret is OUR auth token, because that is what signs on-behalf
 * calls for a Connect-authorized account — see twilio.provider.js. Stored the
 * same encrypted way as every other secret, and it lands in the exact shape
 * SmsAdapter already reads, so sending is identical for both paths.
 *
 * `twilioNumber` may be absent when the account owns no number yet; the
 * credential is still stored and the caller reports the pending state.
 */
export function connectTwilioConnect(userId, { accountSid, accountName, twilioNumber }) {
  return connect({
    userId,
    platformCode: 'sms',
    secret: env.TWILIO_AUTH_TOKEN,
    extraInfo: {
      account_sid: accountSid,
      ...(twilioNumber ? { twilio_number: twilioNumber } : {}),
      ...(accountName ? { account_name: accountName } : {}),
      // Marks the credential as Connect-granted: the secret is this server's
      // auth token, so revoking access means revoking the Connect App grant
      // in the user's Twilio console, not rotating a token they hold.
      connect: true,
    },
  });
}
