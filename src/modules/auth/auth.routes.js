// ============================================================
// Auth routes.
//   POST /register  — create an account
//   POST /login     — email + password -> tokens
//   POST /refresh   — refresh token -> new tokens
//   GET  /me        — current user (protected)
//
// A stricter rate limiter guards the credential endpoints against
// brute-force / credential-stuffing attempts.
// ============================================================

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as authController from './auth.controller.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import {
  registerSchema,
  loginSchema,
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

router.post('/register', authLimiter, validate({ body: registerSchema }), authController.register);
router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login);
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
