// ============================================================
// Auth routes (mounted at /api/v1/auth).
//
//   POST /signup           — create an account
//   POST /login            — email + password -> tokens
//   POST /logout           — revoke a refresh token (or every session)
//   POST /refresh          — rotate a refresh token -> new pair
//   POST /forgot-password  — email a reset link
//   POST /reset-password   — consume the link, set a new password
//   GET  /me               — current user (protected)
//
// The OAuth provider routes (/auth/google, /auth/meta) live in the
// platforms module and are mounted onto this same prefix in api/routes.js.
//
// A stricter rate limiter guards the credential endpoints against
// brute-force / credential-stuffing attempts.
// ============================================================

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as authController from './auth.controller.js';
import { validate } from '../../middleware/validate.js';
import { authenticate, optionalAuthenticate } from '../../middleware/authenticate.js';
import {
  signupSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './auth.schema.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, please try again later', code: 'RATE_LIMITED' } },
});

router.post('/signup', authLimiter, validate({ body: signupSchema }), authController.signup);

// Legacy alias — the endpoint shipped as /register before /signup was adopted.
router.post('/register', authLimiter, validate({ body: signupSchema }), authController.signup);

router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login);

// Not rate-limited: logging out must always work, and it revokes nothing
// the caller doesn't already hold.
router.post(
  '/logout',
  optionalAuthenticate,
  validate({ body: logoutSchema }),
  authController.logout
);

router.post('/refresh', authLimiter, validate({ body: refreshSchema }), authController.refresh);

router.post(
  '/forgot-password',
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  authController.forgotPassword
);

router.post(
  '/reset-password',
  authLimiter,
  validate({ body: resetPasswordSchema }),
  authController.resetPassword
);

router.get('/me', authenticate, authController.me);

export default router;
