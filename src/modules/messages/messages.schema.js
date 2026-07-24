// ============================================================
// Zod schemas for Message APIs
// ============================================================

import { z } from "zod";

export const createMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Content is required")
    .max(10000, "Content is too long"),

  templateId: z
    .number()
    .int()
    .positive()
    .optional(),
});

export const updateMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1)
    .max(10000)
    .optional(),

  templateId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional(),
});