// ============================================================
// AI controller — translates HTTP <-> service calls.
// ============================================================

import * as aiService from './ai.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/**
 * POST /ai/generate-message
 *
 * Accepts `{ prompt }` and returns `{ data: { message } }`.
 */
export const generateMessage = asyncHandler(async (req, res) => {
  const message = await aiService.generateMessage(req.body.prompt);

  res.status(200).json({
    data: { message },
  });
});
