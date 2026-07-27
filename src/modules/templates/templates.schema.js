import { z } from 'zod';

const variableSchema = z.object({
  variableName: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'variableName must be a valid identifier, e.g. "name" or "due_date"'),
  defaultValue: z.string().trim().max(255).optional(),
  isRequired: z.boolean().default(false),
});

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
