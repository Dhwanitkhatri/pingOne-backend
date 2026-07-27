// ============================================================
// Zod schemas for the Contact Groups API.
// ============================================================

import { z } from 'zod';
import { idParam, paginationSchema } from '../../utils/validators.js';

export const createGroupSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(100),
  description: z.string().trim().max(255).nullish(),
  // Optionally seed the group at creation time.
  contactIds: z.array(idParam).max(500).optional(),
});

export const updateGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(255).nullish(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

export const listGroupsQuerySchema = paginationSchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
  sortBy: z.enum(['createdAt', 'name', 'updatedAt']).default('createdAt'),
});

/** POST /groups/:id/members — one id or many. */
export const addMembersSchema = z
  .object({
    contactIds: z.array(idParam).max(500, 'At most 500 contacts per request').optional(),
    contactId: idParam.optional(),
  })
  .transform((data) => ({
    contactIds: data.contactIds ?? (data.contactId ? [data.contactId] : []),
  }))
  .refine((data) => data.contactIds.length > 0, {
    message: 'Provide contactId or a non-empty contactIds array',
    path: ['contactIds'],
  });

/** DELETE /groups/:id/members/:contactId */
export const memberParamsSchema = z.object({
  id: idParam,
  contactId: idParam,
});
