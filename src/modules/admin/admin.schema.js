// ============================================================
// Zod schemas for the admin surface.
//
// Query params arrive as strings, so every numeric bound is coerced and
// clamped here rather than in the service. Bounds are not cosmetic: `limit`
// and `days` both feed queries that scan message_deliveries, and an
// unbounded ?days=100000 is a trivially available denial of service against
// our own database.
// ============================================================

import { z } from 'zod';
import { emailString } from '../../utils/validators.js';

export const adminLoginSchema = z.object({
  // The shared validator, not a local copy. It trims, lowercases and caps at
  // 255 — and the lowercasing has to match signup's exactly, or an operator
  // who registered as "Ops@Company.com" could never be found by this lookup.
  email: emailString,
  // No min-length rule on the password. This is a LOGIN, not a signup: the
  // policy applies when a password is set, and enforcing it here would tell
  // an attacker that a short guess isn't worth trying.
  password: z.string({ required_error: 'Password is required' }).min(1, 'Password is required'),
});

/**
 * Mirrors the customer `logoutSchema`, refine included.
 *
 * The refine is not optional politeness: the service hashes `refreshToken`
 * to find the row to revoke, and without this guard an empty body passes
 * validation and reaches `sha256Hex(undefined)`, turning "log me out" into a
 * 500. `allDevices` is the one case where no token is needed, because the
 * revocation is then keyed on the authenticated user instead.
 */
export const adminLogoutSchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
    allDevices: z.coerce.boolean().default(false),
  })
  .refine((data) => data.allDevices || Boolean(data.refreshToken), {
    message: 'refreshToken is required unless allDevices is true',
    path: ['refreshToken'],
  });

/** The area chart offers exactly the two ranges the design shows. */
export const activityQuerySchema = z.object({
  days: z.coerce.number().int().refine((v) => v === 7 || v === 30, {
    message: 'days must be 7 or 30',
  }).default(7),
});

export const statsQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).default(30),
});

export const distributionQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export const recentActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(8),
});

export const overviewQuerySchema = z.object({
  activityDays: z.coerce.number().int().refine((v) => v === 7 || v === 30, {
    message: 'activityDays must be 7 or 30',
  }).default(7),
});

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.coerce.number().int().positive().optional(),
  action: z.string().trim().max(60).optional(),
  adminId: z.coerce.number().int().positive().optional(),
});
