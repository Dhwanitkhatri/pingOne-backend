import { z } from 'zod';
import { VARIABLE_SOURCE } from '../../constants/codes.js';
import { CONTACT_FIELDS } from './contact-fields.js';

const variableSchema = z
  .object({
    variableName: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'variableName must be a valid identifier, e.g. "name" or "due_date"'),
    defaultValue: z.string().trim().max(255).optional(),
    isRequired: z.boolean().default(false),

    /**
     * 'manual' — the sender types a value when they pick the template.
     * 'contact' — read off each recipient's own contact row at delivery time.
     * Defaults to 'manual' so existing clients that don't send the field keep
     * the behaviour they had.
     */
    source: z
      .enum([VARIABLE_SOURCE.MANUAL, VARIABLE_SOURCE.CONTACT])
      .default(VARIABLE_SOURCE.MANUAL),

    contactField: z.enum(CONTACT_FIELDS).nullish(),
  })
  // Mirrors chk_template_variables_source in the migration. Rejecting the
  // mismatch here turns what would be a 500 from Postgres into a readable 400.
  .refine((v) => v.source !== VARIABLE_SOURCE.CONTACT || Boolean(v.contactField), {
    message: 'A variable with source "contact" needs a contactField',
    path: ['contactField'],
  })
  .refine((v) => v.source !== VARIABLE_SOURCE.MANUAL || !v.contactField, {
    message: 'contactField only applies to a variable with source "contact"',
    path: ['contactField'],
  })
  // A manual variable can be required — the sender is asked for it. A contact
  // variable can too: "required" then means the send fails rather than going
  // out with a hole where the name should be.
  .transform((v) => ({ ...v, contactField: v.contactField ?? null }));

export const createTemplateSchema = z.object({
  platformId: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(100),
  content: z.string().trim().min(1, 'content is required'),
  variables: z.array(variableSchema).default([]),
});

export const updateTemplateSchema = createTemplateSchema.partial();

export const renderTemplateSchema = z.object({
  variables: z.record(z.string(), z.string()).default({}),
});
