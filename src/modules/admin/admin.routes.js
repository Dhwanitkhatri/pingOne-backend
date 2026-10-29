// ============================================================
// Admin routes (mounted at /api/v1/admin).
//
//   POST /auth/login                  — operator sign-in (403 for non-admins)
//   POST /auth/logout                 — revoke the session
//   GET  /auth/me                     — current operator (protected)
//
//   GET  /dashboard/overview          — every panel in one call
//   GET  /dashboard/stats             — the four headline counters
//   GET  /dashboard/messaging-activity— area-chart series (?days=7|30)
//   GET  /dashboard/platform-distribution — donut slices
//   GET  /dashboard/recent-activity   — merged event feed
//   GET  /dashboard/system-health     — live subsystem probes
//   GET  /audit-log                   — the admin action trail
//
// SECURITY — the two lines that matter:
//
//   router.use(authenticate)   proves who the caller is, from the database
//   router.use(requireAdmin)   proves they may be here at all
//
// They are applied to the router as a whole, below the login route, so a new
// endpoint added to this file is protected by default. Never guard these
// per-route: that is the pattern where someone adds a handler, forgets the
// middleware array, and quietly exposes platform-wide data to every signed-in
// customer. Nothing in the dashboard service filters by user_id.
//
// There is NO refresh route here on purpose. Refresh tokens are shared with
// the customer session (an admin IS a user), so POST /auth/refresh already
// rotates it; a second implementation would be a second place to get token
// rotation subtly wrong.
// ============================================================

import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import * as adminController from './admin.controller.js';
import { validate } from '../../middleware/validate.js';
import { authenticate, optionalAuthenticate } from '../../middleware/authenticate.js';
import { requireAdmin, requireSuperAdmin } from '../../middleware/authorize.js';
import {
  adminLoginSchema,
  adminLogoutSchema,
  overviewQuerySchema,
  statsQuerySchema,
  activityQuerySchema,
  distributionQuerySchema,
  recentActivityQuerySchema,
  auditQuerySchema,
  usersQuerySchema,
  updateUserStatusSchema,
  updateUserRoleSchema,
  messagesQuerySchema,
  platformToggleSchema,
  analyticsQuerySchema,
} from './admin.schema.js';

const router = Router();

/**
 * Tighter than the customer limiter (20/15min): a back-office credential is
 * worth far more to an attacker, and no legitimate operator needs ten
 * attempts in a quarter of an hour.
 */
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { message: 'Too many attempts, please try again later', code: 'RATE_LIMITED' },
  },
});

/* ── Public: the admin login page posts here ─────────────────────────── */

router.post(
  '/auth/login',
  adminLoginLimiter,
  validate({ body: adminLoginSchema }),
  adminController.login
);

// Logout stays reachable with an expired access token — being unable to sign
// out of the back office is a worse failure than an unauthenticated call that
// revokes only a token the caller already holds.
router.post(
  '/auth/logout',
  optionalAuthenticate,
  validate({ body: adminLogoutSchema }),
  adminController.logout
);

/* ── Everything below requires a live ADMIN / SUPER_ADMIN ────────────── */

router.use(authenticate);
router.use(requireAdmin);

router.get('/auth/me', adminController.me);

router.get(
  '/dashboard/overview',
  validate({ query: overviewQuerySchema }),
  adminController.overview
);

router.get('/dashboard/stats', validate({ query: statsQuerySchema }), adminController.stats);

router.get(
  '/dashboard/messaging-activity',
  validate({ query: activityQuerySchema }),
  adminController.messagingActivity
);

router.get(
  '/dashboard/platform-distribution',
  validate({ query: distributionQuerySchema }),
  adminController.platformDistribution
);

router.get(
  '/dashboard/recent-activity',
  validate({ query: recentActivityQuerySchema }),
  adminController.recentActivity
);

router.get('/dashboard/system-health', adminController.systemHealth);

router.get('/audit-log', validate({ query: auditQuerySchema }), adminController.auditLog);

/* ── Users Management ────────────────────────────────────────────────── */
router.get('/users', validate({ query: usersQuerySchema }), adminController.getUsers);
router.get('/users/:id', adminController.getUserDetails);
router.patch('/users/:id/status', validate({ body: updateUserStatusSchema }), adminController.updateUserStatus);
router.patch('/users/:id/role', requireSuperAdmin, validate({ body: updateUserRoleSchema }), adminController.updateUserRole);

/* ── Messages & Deliveries ───────────────────────────────────────────── */
router.get('/messages', validate({ query: messagesQuerySchema }), adminController.getMessages);
router.post('/messages/:id/retry', adminController.retryMessage);

/* ── Platforms Management ────────────────────────────────────────────── */
router.get('/platforms', adminController.getPlatforms);
router.patch('/platforms/:code/toggle', validate({ body: platformToggleSchema }), adminController.togglePlatform);

/* ── Analytics ───────────────────────────────────────────────────────── */
router.get('/analytics', validate({ query: analyticsQuerySchema }), adminController.getAnalytics);

/* ── Settings & Operators ────────────────────────────────────────────── */
router.get('/operators', adminController.getOperators);
router.get('/settings', adminController.getSettings);

export default router;
