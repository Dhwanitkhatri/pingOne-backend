// ============================================================
// Shared Zod building blocks reused across feature modules.
// Keeping them in one place means "what is a valid phone number"
// has exactly one answer everywhere in the API.
// ============================================================

import { z } from 'zod';
import { PLATFORM_CODES } from './platforms.js';

/** A positive integer path/route id, coerced from the URL string. */
export const idParam = z.coerce
  .number({ invalid_type_error: 'id must be a number' })
  .int('id must be an integer')
  .positive('id must be a positive integer');

/** `/:id` route params. */
export const idParamSchema = z.object({ id: idParam });

/**
 * Standard list pagination + sort direction.
 * `page` is 1-based; `limit` is capped so a client can't ask for the
 * whole table in one request.
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  sort: z.enum(['asc', 'desc']).default('desc'),
});

/** Turn {page, limit} into Prisma's {skip, take}. */
export function toSkipTake({ page, limit }) {
  return { skip: (page - 1) * limit, take: limit };
}

/** Uniform pagination envelope returned by every list endpoint. */
export function paginationMeta({ page, limit }, total) {
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasMore: page * limit < total,
  };
}

/**
 * E.164-ish phone number. Deliberately permissive about the separators a
 * human might type — normalizePhone() strips them — but the stored value
 * must end up as +<country><number>, which is what every platform API
 * (Twilio, WhatsApp Cloud) expects.
 */
export const phoneString = z
  .string()
  .trim()
  .transform(normalizePhone)
  .refine((v) => /^\+[1-9]\d{6,14}$/.test(v), {
    message: 'Phone must be in E.164 format, e.g. +14155550100',
  });

/**
 * Strip spaces, dashes, dots and parentheses; convert a leading "00"
 * international prefix to "+".
 * @param {string} raw
 * @returns {string}
 */
export function normalizePhone(raw) {
  const cleaned = String(raw).replace(/[\s().-]/g, '');
  return cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned;
}

/** Lowercased, trimmed email capped at the column width. */
export const emailString = z
  .string()
  .trim()
  .toLowerCase()
  .email('A valid email address is required')
  .max(255);

/**
 * A first or last name: letters only, words separated by single spaces.
 * Stray whitespace is trimmed and collapsed before the check, so
 * "  Van   Der Berg " is stored as "Van Der Berg" rather than rejected.
 * Mirrors the signup form's rule so the API can't be used to bypass it.
 * @param {string} label  e.g. "First name" — used in the error messages
 */
export function personNameString(label) {
  return z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(
      z
        .string()
        .min(1, `${label} is required`)
        .max(100)
        // Empty is left to min() above, so a blank name reports one error, not two.
        .regex(/^(?:[A-Za-z]+(?: [A-Za-z]+)*)?$/, `${label} can only contain letters and spaces`)
    );
}

/** One of the seeded platform codes. */
export const platformCode = z.enum(PLATFORM_CODES, {
  errorMap: () => ({ message: `platform must be one of: ${PLATFORM_CODES.join(', ')}` }),
});
