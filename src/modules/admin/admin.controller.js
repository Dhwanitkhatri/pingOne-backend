// ============================================================
// Admin controllers — HTTP in, service call, JSON out. Thin by design,
// matching the convention in modules/auth.
// ============================================================

import * as adminAuthService from './admin.auth.service.js';
import * as dashboardService from './admin.dashboard.service.js';
import * as audit from './audit.service.js';
import { AUDIT_ACTION } from './audit.service.js';
import { logout as revokeSession } from '../auth/auth.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/** Recorded alongside the refresh token so an operator can tell sessions apart. */
function sessionContext(req) {
  return { userAgent: req.get('user-agent') ?? undefined, ipAddress: req.ip };
}

/* ── Auth ────────────────────────────────────────────────────────────── */

export const login = asyncHandler(async (req, res) => {
  const { user, tokens } = await adminAuthService.login(req.body, sessionContext(req));
  res.status(200).json({ user, ...tokens });
});

export const me = asyncHandler(async (req, res) => {
  const user = await adminAuthService.getProfile(req.user.id);
  res.status(200).json({ user });
});

/**
 * Sign out of the back office.
 *
 * Delegates the actual revocation to the shared auth service — there is one
 * refresh-token registry, and an admin session is an ordinary session, so
 * there is nothing admin-specific to do beyond writing the audit row.
 */
export const logout = asyncHandler(async (req, res) => {
  const { revoked } = await revokeSession(req.body, req.user?.id ?? null);

  if (req.user) {
    await audit.record(
      {
        adminId: req.user.id,
        action: AUDIT_ACTION.LOGOUT,
        targetType: 'system',
        targetLabel: req.user.email,
        metadata: { allDevices: Boolean(req.body?.allDevices) },
      },
      sessionContext(req)
    );
  }

  res.status(200).json({ message: 'Logged out', sessionsRevoked: revoked });
});

/* ── Dashboard ───────────────────────────────────────────────────────── */

export const overview = asyncHandler(async (req, res) => {
  res.status(200).json(await dashboardService.getOverview(req.query));
});

export const stats = asyncHandler(async (req, res) => {
  res.status(200).json(await dashboardService.getStats(req.query));
});

export const messagingActivity = asyncHandler(async (req, res) => {
  res.status(200).json(await dashboardService.getMessagingActivity(req.query));
});

export const platformDistribution = asyncHandler(async (req, res) => {
  res.status(200).json(await dashboardService.getPlatformDistribution(req.query));
});

export const recentActivity = asyncHandler(async (req, res) => {
  res.status(200).json(await dashboardService.getRecentActivity(req.query));
});

export const systemHealth = asyncHandler(async (req, res) => {
  const health = await dashboardService.getSystemHealth();

  // Always 200. This endpoint REPORTS health; it is not itself a probe, and
  // a non-2xx would make the admin SPA's error path swallow the very payload
  // the operator needs to read.
  res.status(200).json(health);
});

/* ── Audit trail ─────────────────────────────────────────────────────── */

export const auditLog = asyncHandler(async (req, res) => {
  res.status(200).json(await audit.list(req.query));
});
