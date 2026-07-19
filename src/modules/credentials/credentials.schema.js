// ============================================================
// Zod schemas for connecting each messaging platform.
// Every schema validates the platform's own credential shape:
//   - the SECRET (access token / bot token / refresh token / auth token)
//     is encrypted before storage
//   - the remaining fields become the credential's `extra_info` JSONB
// ============================================================

import { z } from 'zod';

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
export const telegramSchema = z.object({
  botToken: z
    .string()
    .trim()
    .regex(/^\d+:[A-Za-z0-9_-]+$/, 'botToken must look like 123456789:AA... (from @BotFather)'),
  botUsername: z.string().trim().min(1).max(64).optional(),
});

// Google / Gmail (OAuth2): the long-lived refresh token is the secret we
// persist; the short-lived access token is re-derived when sending and is
// intentionally NOT stored in plaintext extra_info.
export const googleSchema = z.object({
  gmailAddress: z.string().trim().toLowerCase().email('A valid Gmail address is required').max(255),
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
