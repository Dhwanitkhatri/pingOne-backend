// ============================================================
// Environment loading + validation.
// Loads `.env` (via dotenv) and validates every variable the app
// depends on. Fails fast with a clear message if something is missing
// or malformed, so we never boot in a half-configured state.
// ============================================================

import 'dotenv/config';
import { z } from 'zod';

/**
 * An optional variable left blank in `.env` (`GOOGLE_CLIENT_ID=`) arrives as
 * an empty string, not as undefined — which would fail `.min(1)` and stop the
 * app from booting over a placeholder line. Treat blank as "not set" so the
 * provider simply reports itself unconfigured, as designed.
 */
const optional = (schema) =>
  z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), schema);

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default('/api/v1'),

  // Public URL of the frontend — used to build links in emails
  // (e.g. the password-reset link).
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  // Comma-separated origins -> string[]
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((val) =>
      val
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    ),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // 32-byte key, hex-encoded (64 hex chars) for AES-256.
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),

  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  // How long a password-reset link stays valid, in minutes.
  PASSWORD_RESET_TTL_MIN: z.coerce.number().int().positive().default(60),

  // How long an OAuth `state` value stays valid, in minutes. Short by design:
  // it only has to survive one redirect round-trip.
  OAUTH_STATE_TTL_MIN: z.coerce.number().int().positive().default(10),

  // Where the browser lands after an OAuth callback finishes. The result is
  // appended as query params (?platform=…&status=connected|error).
  OAUTH_SUCCESS_REDIRECT: optional(z.string().url().optional()),

  // ---- Google / Gmail OAuth (optional) ----------------------------
  // Leave unset to run without Google: /auth/google then returns a clear
  // 503 instead of the app failing to boot.
  GOOGLE_CLIENT_ID: optional(z.string().trim().min(1).optional()),
  GOOGLE_CLIENT_SECRET: optional(z.string().trim().min(1).optional()),
  GOOGLE_REDIRECT_URI: optional(z.string().url().optional()),

  // ---- Meta / WhatsApp OAuth (optional) ---------------------------
  META_APP_ID: optional(z.string().trim().min(1).optional()),
  META_APP_SECRET: optional(z.string().trim().min(1).optional()),
  META_REDIRECT_URI: optional(z.string().url().optional()),
  META_API_VERSION: z.string().trim().default('v21.0'),
  // Embedded-signup configuration id (Meta "config_id"), if you use one.
  META_CONFIG_ID: z.string().trim().min(1).optional(),

  // ---- Twilio Connect (optional) ----------------------------------
  // Twilio Connect is Twilio's authorization flow: the user approves our
  // Connect App from their own Twilio account, and we then call the API on
  // their behalf using THEIR AccountSid as the username and OUR auth token
  // as the password. So the two secrets below are this server's own Twilio
  // credentials, not the end user's.
  //   TWILIO_CONNECT_APP_SID — the Connect App's CNxxxx… sid
  //   TWILIO_ACCOUNT_SID     — our ACxxxx… (owner of the Connect App)
  //   TWILIO_AUTH_TOKEN      — our auth token; signs every on-behalf call
  // Leave unset to run without Connect: /auth/twilio then returns a clear
  // 503 and the manual POST /platforms/twilio path keeps working.
  TWILIO_CONNECT_APP_SID: optional(
    z
      .string()
      .trim()
      .regex(/^CN[0-9a-fA-F]{32}$/, 'TWILIO_CONNECT_APP_SID must start with "CN" and be 34 characters')
      .optional()
  ),
  TWILIO_ACCOUNT_SID: optional(
    z
      .string()
      .trim()
      .regex(/^AC[0-9a-fA-F]{32}$/, 'TWILIO_ACCOUNT_SID must start with "AC" and be 34 characters')
      .optional()
  ),
  TWILIO_AUTH_TOKEN: optional(z.string().trim().min(10).optional()),

  // Max size of an uploaded contacts CSV, in megabytes.
  CSV_MAX_UPLOAD_MB: z.coerce.number().positive().max(50).default(5),

  // Redis, backing the BullMQ delivery/retry queues. Only the worker process
  // and the scheduler need it — the API boots fine without Redis running.
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // ---- Message attachments ----------------------------------------
  // Where attachment files are written, relative to the project root.
  UPLOAD_DIR: z.string().trim().default('uploads'),
  ATTACHMENT_MAX_UPLOAD_MB: z.coerce.number().positive().max(100).default(10),
  ATTACHMENT_MAX_FILES: z.coerce.number().int().positive().max(20).default(5),

  // Public origin of THIS API. Attachment fileUrls are built from it, and
  // Twilio MMS fetches media over the public internet — so for real MMS this
  // has to be a tunnel/deployed host, not localhost. Telegram, WhatsApp and
  // Gmail upload the bytes directly and don't care.
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),

  // ---- Webhooks ---------------------------------------------------
  // Value Meta echoes back during the GET verification handshake. Set the same
  // string in the Meta dashboard's "Verify token" field.
  META_WEBHOOK_VERIFY_TOKEN: z.string().trim().min(1).optional(),
  // Shared secret passed to Telegram's setWebhook as `secret_token`; Telegram
  // returns it in the X-Telegram-Bot-Api-Secret-Token header on every update.
  TELEGRAM_WEBHOOK_SECRET: z.string().trim().min(1).optional(),

  // ---- Telegram user accounts (MTProto) ---------------------------
  // Register an application at https://my.telegram.org -> API development
  // tools. These identify the APPLICATION, not any account, and are the same
  // for every user who connects — each user's own credential is the session
  // string produced by their login, which is encrypted per-user like any
  // other secret.
  //
  // Only needed for the "user account" Telegram mode; bot mode ignores them.
  // Wrapped in `optional()` so a blank line (`TELEGRAM_API_ID=`) reads as
  // "not set" rather than coercing to 0 and failing the positive() check —
  // which would stop the app booting over a placeholder.
  TELEGRAM_API_ID: optional(z.coerce.number().int().positive().optional()),
  TELEGRAM_API_HASH: optional(z.string().trim().min(1).optional()),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';

// Provider availability — checked by the OAuth routes so an unconfigured
// provider fails with an actionable 503 at request time instead of
// preventing the whole app from starting.
export const isGoogleOAuthConfigured = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI
);
export const isMetaOAuthConfigured = Boolean(
  env.META_APP_ID && env.META_APP_SECRET && env.META_REDIRECT_URI
);
// Telegram "user account" mode. Bot mode needs none of this, so the app runs
// fine without it — only the MTProto login endpoints 503.
export const isTelegramUserConfigured = Boolean(
  env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH
);
// No redirect URI here: Twilio Connect takes the callback from the Connect
// App's own dashboard configuration, not from the authorize request.
export const isTwilioConnectConfigured = Boolean(
  env.TWILIO_CONNECT_APP_SID && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
);
