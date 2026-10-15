// ============================================================
// Gemini provider adapter.
// It owns provider-specific HTTP, timeout, and error mapping so the AI
// service can be switched to another provider without changing routes or
// business rules. The API key remains server-side in env.GEMINI_API_KEY.
// ============================================================

import { env, isAiConfigured } from '../../../config/env.js';
import { AppError } from '../../../utils/AppError.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Gemini answers 503 "model is experiencing high demand" during load spikes
// that usually clear within seconds. Retrying those (and other transient
// 5xx) briefly turns a user-facing error into a slightly slower success.
// The waits stay inside the AI_TIMEOUT_MS abort, so the overall bound on a
// request is unchanged. 429 is not retried: it means the quota is spent.
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
const RETRY_DELAYS_MS = [1000, 2000];

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
}

function toGeminiSchema(schema) {
  const converted = { type: schema.type.toUpperCase() };
  if (schema.required) converted.required = schema.required;
  if (schema.properties) {
    converted.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)])
    );
  }
  if (schema.enum) converted.enum = schema.enum;
  return converted;
}

/**
 * Sends the constrained request and returns parsed JSON only.
 * `instructions`, `input`, and `schema` are assembled by the provider-neutral
 * service; `userId` is hashed before it becomes a provider safety identifier.
 */
export async function generateStructuredContent({ instructions, input, schema }) {
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
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: 'user', parts: [{ text: input }] }],
      generationConfig: {
        maxOutputTokens: 700,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(schema),
      },
    });

    let response;
    for (let attempt = 0; ; attempt += 1) {
      response = await fetch(`${GEMINI_API_URL}/${encodeURIComponent(env.AI_MODEL)}:generateContent`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-goog-api-key': env.GEMINI_API_KEY,
          'Content-Type': 'application/json',
        },
        body,
      });
      if (!TRANSIENT_STATUSES.has(response.status) || attempt >= RETRY_DELAYS_MS.length) break;
      await wait(RETRY_DELAYS_MS[attempt], controller.signal);
    }

    if (!response.ok) {
      // Do not surface provider bodies: they can include operational details.
      if (response.status === 429) {
        throw new AppError(429, 'AI provider rate limit reached. Please try again shortly.', {
          code: 'AI_PROVIDER_RATE_LIMITED',
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppError(502, 'The configured Gemini API key was rejected.', {
          code: 'AI_PROVIDER_AUTH_ERROR',
        });
      }
      if (response.status === 404) {
        throw new AppError(502, 'The configured Gemini model is unavailable.', {
          code: 'AI_MODEL_UNAVAILABLE',
        });
      }
      throw new AppError(502, 'AI content generation is temporarily unavailable', {
        code: 'AI_PROVIDER_ERROR',
      });
    }

    // A successful HTTP status can still represent an incomplete AI response.
    const payload = await response.json();
    const outputText = payload.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === 'string')?.text;
    if (typeof outputText !== 'string') {
      throw new AppError(502, 'AI returned an incomplete response', { code: 'AI_MALFORMED_RESPONSE' });
    }

    try {
      return JSON.parse(outputText);
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
    console.info(`[ai] provider=gemini latency_ms=${Date.now() - startedAt}`);
  }
}
