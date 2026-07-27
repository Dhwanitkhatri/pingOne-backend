// ============================================================
// Zod schemas for the Contacts API.
//
// Phones, emails and platform handles are child tables, so each accepts
// either a bare value or an object with flags:
//
//   "phones": ["+14155550100", { "phone": "+14155550101", "isPrimary": true }]
//
// which keeps simple payloads simple without losing the isPrimary flag.
// ============================================================

import { z } from 'zod';
import {
  emailString,
  phoneString,
  platformCode,
  paginationSchema,
} from '../../utils/validators.js';

const phoneEntry = z.union([
  phoneString.transform((phone) => ({ phone, isPrimary: false })),
  z.object({ phone: phoneString, isPrimary: z.boolean().default(false) }),
]);

const emailEntry = z.union([
  emailString.transform((email) => ({ email, isPrimary: false })),
  z.object({ email: emailString, isPrimary: z.boolean().default(false) }),
]);

const handleEntry = z.object({
  platform: platformCode,
  handle: z.string().trim().min(1, 'handle is required').max(255),
});

const contactFields = {
  firstName: z.string().trim().min(1, 'firstName is required').max(100),
  lastName: z.string().trim().max(100).nullish(),
  // Platform code (e.g. "telegram"); null clears the preference.
  preferredPlatform: platformCode.nullish(),
  phones: z.array(phoneEntry).max(10, 'At most 10 phone numbers per contact').optional(),
  emails: z.array(emailEntry).max(10, 'At most 10 email addresses per contact').optional(),
  platformHandles: z.array(handleEntry).max(4, 'One handle per platform').optional(),
};

export const createContactSchema = z.object(contactFields);

/**
 * Update. Every key is optional and only the keys PRESENT in the body are
 * touched — sending `phones` replaces the whole phone list, omitting it
 * leaves the existing numbers alone.
 */
export const updateContactSchema = z
  .object({ ...contactFields, firstName: contactFields.firstName.optional() })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

/** GET /contacts */
export const listContactsQuerySchema = paginationSchema.extend({
  // Matches against first/last name, any email, or any phone.
  search: z.string().trim().min(1).max(100).optional(),
  groupId: z.coerce.number().int().positive().optional(),
  platform: platformCode.optional(),
  sortBy: z.enum(['createdAt', 'firstName', 'updatedAt']).default('createdAt'),
});

/** POST /contacts/import/csv — options sent alongside the file. */
export const csvImportOptionsSchema = z.object({
  // When a row matches an existing contact, merge into it (default) or skip it.
  onDuplicate: z.enum(['merge', 'skip']).default('merge'),
});
