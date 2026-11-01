// ============================================================
// Auth routes (mounted at /api/v1/auth).
//
//   POST /signup           — create an account
//   POST /login            — email + password -> tokens (403 for admin accounts,
//                            which use POST /admin/auth/login instead)
//   POST /logout           — revoke a refresh token (or every session)
//   POST /refresh          — rotate a refresh token -> new pair
//   POST /forgot-password  — email a reset link (404 for an unknown email)
//   POST /reset-password   — consume the link, set a new password
//   POST /verify-email     — consume the emailed link, mark the address verified
//   POST /resend-verification — email a fresh verification link (protected)
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
  verifyEmailSchema,
} from './auth.schema.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, please try again later', code: 'RATE_LIMITED' } },
});

// Each resend is a real email, so this is tighter than authLimiter — enough
// for "it went to spam, send another" without letting a script flood an inbox.
const resendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { message: 'Too many verification emails requested, please try again later', code: 'RATE_LIMITED' },
  },
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

// Public: the link is opened from an inbox, often on a device with no session.
router.post(
  '/verify-email',
  authLimiter,
  validate({ body: verifyEmailSchema }),
  authController.verifyEmail
);

router.post('/resend-verification', resendLimiter, authenticate, authController.resendVerification);

router.get('/me', authenticate, authController.me);

export default router;
