// ============================================================
// User settings routes (mounted at /api/v1/users). All protected.
//
//   GET /users/preferences   read notification preferences
//   PUT /users/preferences   update them (PATCH is accepted too)
//
// The user's own profile lives at GET /auth/me.
// ============================================================

import { Router } from 'express';
import * as controller from './users.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { updatePreferencesSchema } from './users.schema.js';

const router = Router();

router.use(authenticate);

router.get('/preferences', controller.getPreferences);
router.put(
  '/preferences',
  validate({ body: updatePreferencesSchema }),
  controller.updatePreferences
);
router.patch(
  '/preferences',
  validate({ body: updatePreferencesSchema }),
  controller.updatePreferences
);

export default router;
