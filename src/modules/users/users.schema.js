// ============================================================
// Zod schemas for user-level settings.
// ============================================================

import { z } from 'zod';

/** How often the digest email goes out. Stored as VARCHAR(20). */
export const DIGEST_FREQUENCIES = ['daily', 'weekly', 'monthly', 'never'];

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
