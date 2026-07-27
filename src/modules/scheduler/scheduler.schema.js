import { z } from 'zod';

const recipientSchema = z
  .object({
    contactId: z.number().int().positive().optional(),
    groupId: z.number().int().positive().optional(),
    platformId: z.number().int().positive(),
  })
  .refine((r) => Boolean(r.contactId) !== Boolean(r.groupId), {
    message: 'Each recipient needs exactly one of contactId or groupId',
  });

const recurrenceSchema = z.object({
  typeCode: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  intervalValue: z.number().int().positive().default(1),
  daysOfWeek: z.string().max(20).optional(), // e.g. "MON,WED,FRI"
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  monthOfYear: z.number().int().min(1).max(12).optional(),
  endDate: z.coerce.date().optional(),
  maxOccurrences: z.number().int().positive().optional(),
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
    recipients: z.array(recipientSchema).min(1, 'At least one recipient is required'),
  })
  .refine((data) => Boolean(data.messageId) !== Boolean(data.message), {
    message: 'Provide exactly one of messageId (existing) or message (inline content)',
  });

export const updateScheduleSchema = z.object({
  scheduledAt: z.coerce.date().optional(),
  recurrence: recurrenceSchema.optional(),
  recipients: z.array(recipientSchema).min(1).optional(),
});
