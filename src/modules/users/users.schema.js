// ============================================================
// Zod schemas for user-level settings.
// ============================================================

import { z } from 'zod';

/** How often the digest email goes out. Stored as VARCHAR(20). */
export const DIGEST_FREQUENCIES = ['daily', 'weekly', 'monthly', 'never'];

/** Shared password rule — same constraints as auth.schema.js. */
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters');

/**
 * PUT /users/preferences — a partial update: send only what changes.
 * Every field is optional, but at least one must be present, so an empty
 * body is a mistake rather than a silent no-op.
 */
export const updatePreferencesSchema = z
  .object({
    notifyOnFailure: z.boolean().optional(),
    notifyOnSuccess: z.boolean().optional(),
    notifyOnTokenExpiry: z.boolean().optional(),
    digestFrequency: z
      .enum(DIGEST_FREQUENCIES, {
        errorMap: () => ({
          message: `digestFrequency must be one of: ${DIGEST_FREQUENCIES.join(', ')}`,
        }),
      })
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one preference to update',
  });

/**
 * PATCH /users/profile — rename the account holder.
 * At least one of the two names must be provided.
 */
export const updateProfileSchema = z
  .object({
    firstName: z.string().trim().min(1, 'First name is required').max(100).optional(),
    lastName: z.string().trim().min(1, 'Last name is required').max(100).optional(),
  })
  .refine((data) => data.firstName !== undefined || data.lastName !== undefined, {
    message: 'Provide at least firstName or lastName',
  });

/**
 * PUT /users/password — change the password while signed in.
 * Requires current password for re-authentication.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: password,
});

/**
 * DELETE /users/me — permanently close the account.
 * Password is required so a hijacked tab can't delete the account.
 */
export const deleteAccountSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});
