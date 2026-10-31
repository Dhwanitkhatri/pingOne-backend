// ============================================================
// Environment loading + validation.
// Loads `.env` (via dotenv) and validates every variable the app
// depends on. Fails fast with a clear message if something is missing
// or malformed, so we never boot in a half-configured state.
// ============================================================

import 'dotenv/config';
import path from 'node:path';
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
  META_API_VERSION: z.string().trim().default('v26.0'),
  // Embedded-signup configuration id (Meta "config_id"), if you use one.
  META_CONFIG_ID: z.string().trim().min(1).optional(),
  // Optional single-WABA fallback for local/manual credentials when Meta
  // OAuth cannot discover a WABA. Per-user credentials remain stored encrypted.
  META_WABA_ID: optional(z.string().trim().regex(/^\d+$/, 'META_WABA_ID must be numeric').optional()),

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

  // All WhatsApp deliveries on this server use the selected provider. Meta is
  // the existing/default path; Twilio Sandbox uses the server credentials
  // below, rather than a per-user platform credential.
  WHATSAPP_PROVIDER: z.enum(['meta', 'twilio']).default('meta'),
  TWILIO_WHATSAPP_FROM: optional(
    z.string().trim().regex(/^whatsapp:\+[1-9]\d{6,14}$/, 'TWILIO_WHATSAPP_FROM must be whatsapp:+<E.164 number>').optional()
  ),
  TWILIO_WHATSAPP_CONTENT_SID: optional(
    z.string().trim().regex(/^HX[0-9a-fA-F]{32}$/, 'TWILIO_WHATSAPP_CONTENT_SID must be a Content SID starting with HX').optional()
  ),
  // Set false only in the worker process for a one-shot Sandbox test. The
  // normal retry policy remains enabled unless explicitly disabled.
  TWILIO_WHATSAPP_RETRY_ENABLED: z.enum(['true', 'false']).default('true'),

  // ---- Outbound email (SMTP) --------------------------------------
  // Transactional mail the SERVER sends as itself: password-reset links and
  // permanent-failure alerts. Nothing to do with the Gmail platform adapter,
  // which sends as a connected user via OAuth.
  //
  // Leave unset and mail is printed to the console instead of sent — fine for
  // a demo, useless for a real inbox. Works with any SMTP provider (Gmail app
  // password, Brevo, Mailtrap, SES, Resend, Postmark…).
  SMTP_HOST: optional(z.string().trim().min(1).optional()),
  SMTP_PORT: optional(z.coerce.number().int().positive().max(65535).default(587)),
  SMTP_USER: optional(z.string().trim().min(1).optional()),
  SMTP_PASS: optional(z.string().min(1).optional()),
  // Implicit TLS from the first byte (port 465). Port 587 uses STARTTLS
  // instead and must leave this false — setting both is the single most
  // common way SMTP hangs until it times out.
  SMTP_SECURE: optional(z.enum(['true', 'false']).optional()),
  // What recipients see in From:. Many providers reject a From: that isn't a
  // domain you've verified with them, so this defaults to SMTP_USER.
  MAIL_FROM: optional(z.string().trim().min(1).optional()),

  // Max size of an uploaded contacts CSV, in megabytes.
  CSV_MAX_UPLOAD_MB: z.coerce.number().positive().max(50).default(5),

  // Redis, backing the BullMQ delivery/retry queues. Only the worker process
  // and the scheduler need it — the API boots fine without Redis running.
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // ---- Message attachments ----------------------------------------
  // Where attachment files are written. A relative path (the dev default) is
  // resolved against the project root; in production this must be an ABSOLUTE
  // path inside a mounted Render persistent disk — e.g. /var/data/uploads —
  // because the default filesystem is wiped on every deploy and restart, and a
  // job scheduled for tomorrow would find its attachments gone. See render.yaml.
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

  // Poll Telegram with getUpdates instead of waiting for webhook callbacks.
  // A webhook needs a public HTTPS origin, so on a laptop without a tunnel
  // no updates ever arrive and no contact can be linked — polling is the
  // local substitute. Unset means "on in development, off elsewhere"; set it
  // explicitly to override. Harmless if a webhook IS registered: Telegram
  // answers getUpdates with 409 and the worker stands down on its own.
  TELEGRAM_POLLING: optional(z.enum(['true', 'false']).optional()),

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

  // ---- AI content assistant (optional) --------------------------
  // The AI endpoint remains unavailable until a server-only API key is set.
  // Keeping this optional lets local development and all non-AI features boot
  // normally without an AI provider account.
  GEMINI_API_KEY: optional(z.string().trim().min(1).optional()),
  AI_API_KEY: optional(z.string().trim().min(1).optional()),
  // `optional` turns AI_MODEL= into undefined, so blank and missing values
  // both safely use the default rather than making an invalid provider call.
  AI_MODEL: optional(z.string().trim().min(1).optional()).default('gemini-2.5-flash'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
}).superRefine((values, ctx) => {
  if (values.WHATSAPP_PROVIDER !== 'twilio') return;

  for (const key of [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_WHATSAPP_FROM',
    'TWILIO_WHATSAPP_CONTENT_SID',
  ]) {
    if (!values[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `is required when WHATSAPP_PROVIDER=twilio`,
      });
    }
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const resolvedGeminiKey = parsed.data.GEMINI_API_KEY ?? parsed.data.AI_API_KEY;

export const env = Object.freeze({
  ...parsed.data,
  GEMINI_API_KEY: resolvedGeminiKey,
});
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
// Whether real email can be sent. Host + credentials are all required — a
// half-filled SMTP block is the same as none, and silently falling back is
// better than the app refusing to boot over an optional feature.
export const isSmtpConfigured = Boolean(
  env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS
);
// getUpdates polling as a webhook substitute. Defaults to on in development
// (where a public callback URL usually doesn't exist) and off otherwise, so a
// deployment with a real webhook never starts a competing poller by accident.
export const isTelegramPollingEnabled =
  env.TELEGRAM_POLLING === undefined ? isDev : env.TELEGRAM_POLLING === 'true';
// No redirect URI here: Twilio Connect takes the callback from the Connect
// App's own dashboard configuration, not from the authorize request.
export const isTwilioConnectConfigured = Boolean(
  env.TWILIO_CONNECT_APP_SID && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
);
export const isAiConfigured = Boolean(env.GEMINI_API_KEY || env.AI_API_KEY);

// A relative UPLOAD_DIR in production means attachments are being written to
// the container's ephemeral filesystem, where they survive until the next
// deploy and no longer. That breaks silently and hours late — when a scheduled
// job finally tries to send — so say it loudly at boot instead. Warn, not
// exit: an instance that refuses to start is worse than one sending text.
if (isProd && !path.isAbsolute(env.UPLOAD_DIR)) {
  console.warn(
    `⚠️  UPLOAD_DIR="${env.UPLOAD_DIR}" is a relative path. On Render this is ephemeral storage — ` +
      'attachments will be lost on the next deploy or restart. Point it at a mounted persistent disk ' +
      '(e.g. /var/data/uploads).'
  );
}
