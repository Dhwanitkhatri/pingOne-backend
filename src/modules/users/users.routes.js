// ============================================================
// User settings routes (mounted at /api/v1/users). All protected.
//
//   GET   /users/preferences   read notification preferences
//   PUT   /users/preferences   update them (PATCH is accepted too)
//   POST  /users/digest/send-now  email the last 7 days' summary right away
//   PATCH /users/profile        update first/last name
//   PUT   /users/password       change password (while signed in)
//   DELETE /users/me            permanently close the account
//
// The user's own profile lives at GET /auth/me.
// ============================================================

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as controller from './users.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import {
  updatePreferencesSchema,
  updateProfileSchema,
  changePasswordSchema,
  deleteAccountSchema,
} from './users.schema.js';

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

// Each press is a real email, so keep it to a handful per quarter-hour.
const digestNowLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { message: 'Too many summary emails requested, please try again later', code: 'RATE_LIMITED' },
  },
});

router.post('/digest/send-now', digestNowLimiter, controller.sendDigestNow);

router.patch(
  '/profile',
  validate({ body: updateProfileSchema }),
  controller.updateProfile
);

router.put(
  '/password',
  validate({ body: changePasswordSchema }),
  controller.changePassword
);

router.delete(
  '/me',
  validate({ body: deleteAccountSchema }),
  controller.deleteAccount
);

export default router;
