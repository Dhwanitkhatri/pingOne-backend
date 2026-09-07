// ============================================================
// OpenAI provider adapter.
// It owns provider-specific HTTP, timeout, and error mapping so the AI
// service can be switched to another provider without changing routes or
// business rules. The API key remains server-side in env.AI_API_KEY.
// ============================================================

import crypto from 'node:crypto';

import { env, isAiConfigured } from '../../../config/env.js';
import { AppError } from '../../../utils/AppError.js';

// Responses API endpoint used for one-shot, structured draft generation.
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/**
 * Sends the constrained request and returns parsed JSON only.
 * `instructions`, `input`, and `schema` are assembled by the provider-neutral
 * service; `userId` is hashed before it becomes a provider safety identifier.
 */
export async function generateStructuredContent({ instructions, input, schema, userId }) {
  // The optional environment setting allows every non-AI PingOne feature to
  // boot without a provider account, while making this endpoint fail clearly.
  if (!isAiConfigured) {
    throw new AppError(503, 'AI content generation is not configured', { code: 'AI_NOT_CONFIGURED' });
  }

  // Abort an unresponsive upstream request rather than leaving the HTTP client
  // hanging indefinitely. The timer is always cleared in finally.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.AI_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        // The secret is sent only to the provider and is never logged/returned.
        Authorization: `Bearer ${env.AI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        instructions,
        input,
        // Do not retain this interactive draft as a provider-side response.
        store: false,
        // Cap completion size for predictable latency and token cost.
        max_output_tokens: 700,
        // A stable one-way hash supports provider safety monitoring without
        // disclosing PingOne's raw internal user id.
        safety_identifier: crypto.createHash('sha256').update(String(userId)).digest('hex'),
        text: {
          // Force machine-readable output that matches the requested type.
          format: { type: 'json_schema', name: 'pingone_content', strict: true, schema },
        },
      }),
    });

    if (!response.ok) {
      // Do not surface provider bodies: they can include operational details.
      if (response.status === 429) {
        throw new AppError(429, 'AI provider rate limit reached. Please try again shortly.', {
          code: 'AI_PROVIDER_RATE_LIMITED',
        });
      }
      throw new AppError(502, 'AI content generation is temporarily unavailable', {
        code: 'AI_PROVIDER_ERROR',
      });
    }

    // A successful HTTP status can still represent an incomplete AI response.
    const payload = await response.json();
    if (payload.status !== 'completed' || typeof payload.output_text !== 'string') {
      throw new AppError(502, 'AI returned an incomplete response', { code: 'AI_MALFORMED_RESPONSE' });
    }

    try {
      return JSON.parse(payload.output_text);
    } catch {
      throw new AppError(502, 'AI returned an invalid response', { code: 'AI_MALFORMED_RESPONSE' });
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // AbortController uses this named error for the configured timeout.
    if (err.name === 'AbortError') {
      throw new AppError(504, 'AI content generation timed out', { code: 'AI_TIMEOUT' });
    }
    throw new AppError(502, 'AI content generation is temporarily unavailable', {
      code: 'AI_PROVIDER_ERROR',
    });
  } finally {
    clearTimeout(timeout);
    // The timing log helps monitor the provider without exposing prompt text,
    // response text, API keys, or provider error bodies.
    console.info(`[ai] provider=openai latency_ms=${Date.now() - startedAt}`);
  }
}
