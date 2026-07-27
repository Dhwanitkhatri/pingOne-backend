// ============================================================
// Platform OAuth routes — mounted onto the /api/v1/auth prefix so the
// public paths read as the spec describes them:
//
//   GET /auth/google            start Gmail OAuth   (protected)
//   GET /auth/google/callback   provider redirect   (public)
//   GET /auth/meta              start WhatsApp OAuth(protected)
//   GET /auth/meta/callback     provider redirect   (public)
//
// The callbacks MUST stay public — the provider's redirect carries no
// Authorization header. They are safe because the `state` parameter is a
// short-lived signed JWT that names the user who started the flow.
// ============================================================

import { Router } from 'express';
import * as controller from './oauth.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { startOAuthQuerySchema, oauthCallbackQuerySchema } from './platforms.schema.js';

const router = Router();

// Callbacks are registered before the `authenticate`-guarded starters so
// the more specific path always wins.
router.get(
  '/google/callback',
  validate({ query: oauthCallbackQuerySchema }),
  controller.googleCallback
);
router.get('/meta/callback', validate({ query: oauthCallbackQuerySchema }), controller.metaCallback);

router.get(
  '/google',
  authenticate,
  validate({ query: startOAuthQuerySchema }),
  controller.startGoogle
);
router.get('/meta', authenticate, validate({ query: startOAuthQuerySchema }), controller.startMeta);

export default router;
