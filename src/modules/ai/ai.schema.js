// ============================================================
// AI schema — request validation for AI endpoints.
// ============================================================

import { z } from 'zod';

export const generateMessageSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(3, 'Prompt must be at least 3 characters')
    .max(500, 'Prompt must be at most 500 characters'),
});
