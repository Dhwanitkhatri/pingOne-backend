// ============================================================
// Zod schemas for connecting each messaging platform.
// Every schema validates that platform's own credential shape:
//   - the SECRET (access token / bot token / refresh token / auth token)
//     is encrypted before storage
//   - the remaining fields become the credential's `extra_info` JSONB
// ============================================================

import { z } from 'zod';
import { emailString, platformCode } from '../../utils/validators.js';

// WhatsApp Cloud (Business) API: a long-lived access token + the phone
// number id the token is scoped to.
export const whatsappSchema = z.object({
  accessToken: z.string().trim().min(1, 'accessToken is required'),
  phoneNumberId: z
    .string()
    .trim()
    .regex(/^\d+$/, 'phoneNumberId must be numeric (from Meta / WhatsApp Cloud API)'),
  businessAccountId: z.string().trim().min(1).optional(),
});

// Telegram Bot API: the bot token issued by @BotFather, e.g. 123456789:AA...
// The bot's username is read back from getMe rather than supplied.
export const telegramSchema = z.object({
  botToken: z
    .string()
    .trim()
    .regex(/^\d+:[A-Za-z0-9_-]+$/, 'botToken must look like 123456789:AA... (from @BotFather)'),
});

// Google / Gmail (OAuth2): the long-lived refresh token is the secret we
// persist; the short-lived access token is re-derived when sending and is
// intentionally NOT stored in plaintext extra_info.
//
// Prefer the browser flow at GET /auth/google — this endpoint exists for
// clients that already completed OAuth themselves.
export const googleSchema = z.object({
  gmailAddress: emailString,
  refreshToken: z.string().trim().min(1, 'refreshToken is required'),
  expiresAt: z.coerce.date().optional(), // when the current access token expires
});

// Twilio (SMS): Account SID + Auth Token + the sending number (E.164).
export const twilioSchema = z.object({
  accountSid: z
    .string()
    .trim()
    .regex(/^AC[0-9a-fA-F]{32}$/, 'accountSid must start with "AC" and be 34 characters'),
  authToken: z.string().trim().min(10, 'authToken is required'),
  twilioNumber: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, 'twilioNumber must be E.164 format, e.g. +14155550100'),
});

/** DELETE /platforms/:code */
export const platformCodeParamSchema = z.object({ code: platformCode });

/**
 * GET /auth/google and /auth/meta.
 * By default they answer with JSON containing the consent URL, which is
 * what a SPA wants (it can't attach a Bearer token to a redirect).
 * `?redirect=true` sends a 302 straight to the provider instead.
 */
export const startOAuthQuerySchema = z.object({
  redirect: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
});

/**
 * Provider callback query. Either `code` + `state` on success, or `error`
 * when the user declined — Google and Meta spell the details differently,
 * so both variants are accepted.
 */
export const oauthCallbackQuerySchema = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
    error_reason: z.string().optional(),
    error_message: z.string().optional(),
  })
  .passthrough();
