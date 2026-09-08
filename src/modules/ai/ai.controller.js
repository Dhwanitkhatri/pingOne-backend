// ============================================================
// AI controller: adapts the authenticated HTTP request to the AI
// service and returns its draft. It never persists, sends, or
// schedules the generated content.
// ============================================================

import { asyncHandler } from '../../utils/asyncHandler.js';
import { generateAiContent } from './ai.service.js';

/** Handles POST /api/v1/ai/generate after authentication and validation. */
export const generate = asyncHandler(async (req, res) => {
  // Used only for operational latency logs; prompt/content are intentionally
  // omitted to avoid recording potentially sensitive user text.
  const startedAt = Date.now();
  try {
    const result = await generateAiContent(req.body);
    // req.user comes solely from the JWT middleware, never from client input.
    console.info(`[ai] user_id=${req.user.id} operation=${req.body.operation} outcome=success latency_ms=${Date.now() - startedAt}`);
    res.status(200).json({ success: true, result });
  } catch (err) {
    console.warn(`[ai] user_id=${req.user.id} operation=${req.body.operation} outcome=failure latency_ms=${Date.now() - startedAt} code=${err.code ?? 'INTERNAL_ERROR'}`);
    // asyncHandler passes this controlled AppError to the central error handler.
    throw err;
  }
});
