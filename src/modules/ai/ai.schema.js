// ============================================================
// AI request/result validation.
// This module is the single source of truth for the public AI API
// contract. `validate` middleware applies generateAiSchema before
// the controller runs; result schemas validate untrusted AI output.
// ============================================================

import { z } from 'zod';
import { PLATFORM } from '../../constants/codes.js';

// Operations intentionally cover only message/email drafting work. Keeping
// the enum closed prevents the endpoint becoming a general AI interface.
export const AI_OPERATION = Object.freeze({
  GENERATE: 'generate',
  REWRITE: 'rewrite',
  SHORTEN: 'shorten',
  EXPAND: 'expand',
  IMPROVE: 'improve',
  TRANSLATE: 'translate',
  PERSONALIZE: 'personalize',
});

// These transformations need an existing message/email body; `generate`
// creates new content from the prompt instead.
const contentOperations = [
  AI_OPERATION.REWRITE,
  AI_OPERATION.SHORTEN,
  AI_OPERATION.EXPAND,
  AI_OPERATION.IMPROVE,
  AI_OPERATION.TRANSLATE,
  AI_OPERATION.PERSONALIZE,
];

// Shared string rule: trim whitespace, reject empty values, and bound input
// size to control cost and avoid accepting unbounded request bodies.
const trimmedText = (max, label) => z.string().trim().min(1, `${label} is required`).max(max);
const platformSchema = z.enum(Object.values(PLATFORM));

/**
 * Input for POST /ai/generate. All fields except prompt are optional controls.
 * Content becomes mandatory for an operation that modifies existing content.
 */
export const generateAiSchema = z
  .object({
    operation: z.enum(Object.values(AI_OPERATION)).default(AI_OPERATION.GENERATE),
    type: z.enum(['message', 'email']).default('message'),
    prompt: trimmedText(2000, 'prompt'),
    content: z.string().trim().min(1).max(10000).optional(),
    tone: z.enum(['professional', 'formal', 'friendly', 'casual', 'polite', 'promotional']).optional(),
    language: z.string().trim().min(1).max(80).optional(),
    length: z.enum(['short', 'medium', 'long']).optional(),
    platform: platformSchema.optional(),
    purpose: z.string().trim().min(1).max(160).optional(),
    audience: z.string().trim().min(1).max(160).optional(),
  })
  .superRefine((value, ctx) => {
    // Zod can validate each field independently, while these rules validate
    // relationships between fields.
    if (contentOperations.includes(value.operation) && !value.content) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: `content is required for the ${value.operation} operation`,
      });
    }
    if (value.operation === AI_OPERATION.TRANSLATE && !value.language) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['language'],
        message: 'language is required for the translate operation',
      });
    }
    // Gmail is PingOne's email transport. All other platforms carry a plain
    // message, so reject combinations that cannot preserve the requested type.
    if (value.type === 'email' && value.platform && value.platform !== PLATFORM.GMAIL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['platform'],
        message: 'Email content can only use the gmail platform',
      });
    }
    if (value.type === 'message' && value.platform === PLATFORM.GMAIL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['platform'],
        message: 'Use type "email" for the gmail platform',
      });
    }
  });

// The model must return this exact shape for a normal message draft.
export const aiMessageResultSchema = z.object({
  type: z.literal('message'),
  content: z.string().trim().min(1).max(10000),
});

// Emails require a separately usable subject as well as their body content.
export const aiEmailResultSchema = z.object({
  type: z.literal('email'),
  subject: z.string().trim().min(1).max(250),
  content: z.string().trim().min(1).max(10000),
});
