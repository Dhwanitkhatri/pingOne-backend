// ============================================================
// AI service — calls the Gemini REST API to generate messages.
//
// Uses native `fetch` (Node 18+), so no new dependencies are needed.
// The API key is read from env and never leaves the server.
// ============================================================

import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * System prompt that shapes the output: short, ready-to-send messages
 * with no markdown or explanatory preamble.
 */
const SYSTEM_INSTRUCTION = `You are PingOne's AI messaging assistant. The user will describe the kind of message they want to send, and you will generate a polished, ready-to-send message.

Rules:
- Output ONLY the message body — no subject line, no greeting line like "Here's a message:", no quotes, no markdown formatting.
- Keep the message concise: 1–4 sentences for casual messages, up to a short paragraph for professional ones.
- Match the tone the user asks for (friendly, formal, professional, etc.). Default to friendly-professional if unspecified.
- If the user's prompt mentions a person's name, use it naturally in the message.
- Use {name} as a placeholder when the user wants personalisation but hasn't given a specific name.
- Do NOT include emojis unless the user explicitly asks for them or the context is very casual (like a birthday wish).
- Write in plain text — no bullet points, no numbered lists, no headers.`;

/**
 * Generate a message via Gemini.
 *
 * @param {string} prompt  The user's natural-language description.
 * @returns {Promise<string>}  The generated message text.
 */
export async function generateMessage(prompt) {
  if (!env.GEMINI_API_KEY) {
    throw new AppError(
      503,
      'AI message generation is not configured. Add a GEMINI_API_KEY to the server environment.',
      { code: 'AI_NOT_CONFIGURED' }
    );
  }

  const response = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 300,
        topP: 0.95,
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    console.error(`Gemini API error (${response.status}):`, errorBody);

    if (response.status === 429) {
      throw new AppError(429, 'AI rate limit reached. Please try again in a moment.', {
        code: 'AI_RATE_LIMITED',
      });
    }

    throw new AppError(502, 'AI message generation failed. Please try again.', {
      code: 'AI_GENERATION_FAILED',
    });
  }

  const data = await response.json();

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

  if (!text) {
    throw new AppError(502, 'The AI returned an empty response. Try rephrasing your prompt.', {
      code: 'AI_EMPTY_RESPONSE',
    });
  }

  return text;
}
