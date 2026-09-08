// ============================================================
// AI HTTP routes, mounted by src/api/routes.js at /api/v1/ai.
// Generation is synchronous and interactive; it deliberately does
// not enter BullMQ, which remains reserved for actual delivery.
// ============================================================

import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { generateAiSchema } from './ai.schema.js';
import * as aiController from './ai.controller.js';

// A dedicated router keeps the AI boundary isolated from message delivery.
const router = Router();

// Limit each source IP to bound provider cost and prevent accidental repeated
// regeneration from a client. Standard headers expose reset information.
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many AI requests, please try again later', code: 'RATE_LIMITED' } },
});

// Middleware order is security-significant: authenticate first, then apply
// the cost guard and schema validation, and finally invoke the thin controller.
// Keep the older descriptive path as an alias for existing clients.
router.post(
  ['/generate', '/generate-message'],
  authenticate,
  aiLimiter,
  validate({ body: generateAiSchema }),
  aiController.generate
);

export default router;
