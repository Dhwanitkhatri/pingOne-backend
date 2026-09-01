// ============================================================
// AI Routes
//
// POST    /ai/generate-message       generate a message from a prompt
//
// All routes require authentication.
// ============================================================

import { Router } from 'express';

import * as aiController from './ai.controller.js';

import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';

import { generateMessageSchema } from './ai.schema.js';

const router = Router();

// Protect every route
router.use(authenticate);

router.post(
  '/generate-message',
  validate({ body: generateMessageSchema }),
  aiController.generateMessage
);

export default router;
