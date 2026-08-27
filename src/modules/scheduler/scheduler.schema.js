import { z } from 'zod';
import { DAY_TOKENS } from '../../constants/codes.js';
import { platformCode } from '../../utils/validators.js';

/**
 * A recipient is one (who, where) pair.
 *
 * "Where" may be given as the platform CODE ("sms") or as the numeric
 * platformId. The code is what clients should send — ids are an internal
 * detail of the platforms reference table and no endpoint exposes them —
 * but the numeric form is still accepted so existing callers keep working.
 * The service resolves whichever arrives to an id.
 */
const recipientSchema = z
  .object({
    contactId: z.number().int().positive().optional(),
    groupId: z.number().int().positive().optional(),
    platformId: z.number().int().positive().optional(),
    platform: platformCode.optional(),
  })
  .refine((r) => Boolean(r.contactId) !== Boolean(r.groupId), {
    message: 'Each recipient needs exactly one of contactId or groupId',
  })
  .refine((r) => Boolean(r.platformId) !== Boolean(r.platform), {
    message: 'Each recipient needs exactly one of platform or platformId',
  });

/**
 * "MON,WED,FRI" — uppercased and de-duplicated on the way in so the stored
 * value is always canonical and the recurrence engine's parser never has to
 * guess. Capped at 20 chars by the column, which fits all seven tokens.
 */
const daysOfWeekSchema = z
  .string()
  .max(20)
  .transform((value) =>
    [...new Set(value.split(',').map((token) => token.trim().toUpperCase()).filter(Boolean))].join(',')
  )
  .refine((value) => value.split(',').every((token) => DAY_TOKENS.includes(token)), {
    message: `Days must be a comma-separated list of ${DAY_TOKENS.join(', ')}`,
  });

const recurrenceSchema = z
  .object({
    typeCode: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    intervalValue: z.number().int().positive().default(1),
    daysOfWeek: daysOfWeekSchema.optional(), // e.g. "MON,WED,FRI"
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    monthOfYear: z.number().int().min(1).max(12).optional(),
    endDate: z.coerce.date().optional(),
    maxOccurrences: z.number().int().positive().optional(),
  })
  // daysOfWeek only means anything for weekly. Accepting it silently on a
  // monthly rule would look like it worked and then be ignored at run time.
  .refine((r) => !r.daysOfWeek || r.typeCode === 'weekly', {
    message: 'daysOfWeek only applies to a weekly recurrence',
    path: ['daysOfWeek'],
  });

const inlineMessageSchema = z.object({
  content: z.string().trim().min(1),
  templateId: z.number().int().positive().optional(),
});

export const createScheduleSchema = z
  .object({
    messageId: z.number().int().positive().optional(),
    message: inlineMessageSchema.optional(),
    scheduledAt: z.coerce.date(),
    recurrence: recurrenceSchema.optional(), // omit for a one-time send
    skipIfReplied: z.boolean().default(false),
    recipients: z.array(recipientSchema).min(1, 'At least one recipient is required'),
  })
  .refine((data) => Boolean(data.messageId) !== Boolean(data.message), {
    message: 'Provide exactly one of messageId (existing) or message (inline content)',
  });

/**
 * POST /messages/send — compose and dispatch in one call.
 *
 * `scheduledAt` is what splits the two behaviours: omitted (or already in
 * the past) means send immediately; a future time creates a pending job for
 * the scheduler worker. That mirrors the composer, where "Send" and
 * "Schedule" differ only by whether a time was picked.
 */
export const sendMessageSchema = z
  .object({
    messageId: z.number().int().positive().optional(),
    content: z.string().trim().min(1).max(10000).optional(),
    templateId: z.number().int().positive().optional(),
    scheduledAt: z.coerce.date().optional(),
    skipIfReplied: z.boolean().default(false),
    recipients: z.array(recipientSchema).min(1, 'At least one recipient is required'),
  })
  .refine((data) => Boolean(data.messageId) !== Boolean(data.content), {
    message: 'Provide exactly one of messageId (existing) or content (new message)',
  });

export const updateScheduleSchema = z.object({
  scheduledAt: z.coerce.date().optional(),
  recurrence: recurrenceSchema.optional(),
  skipIfReplied: z.boolean().optional(),
  recipients: z.array(recipientSchema).min(1).optional(),
});
