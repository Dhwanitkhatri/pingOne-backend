// ============================================================
// Role guards for the back office.
//
// These run AFTER `authenticate`, never instead of it — they only read
// `req.user.role`, which authenticate has already resolved from the database
// on this request. That ordering matters: a role demoted a second ago must
// take effect immediately, so the check can never be based on a claim baked
// into a token minted fifteen minutes earlier.
//
//   requireAdmin      — ADMIN or SUPER_ADMIN. Guards the whole /admin surface.
//   requireSuperAdmin — SUPER_ADMIN only. Guards privilege escalation itself
//                       (changing roles, deleting operators), so an ADMIN
//                       cannot promote themselves or anyone else.
// ============================================================

import { AppError } from '../utils/AppError.js';

export const ROLE = Object.freeze({
  USER: 'USER',
  ADMIN: 'ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
});

/** Roles that may reach the back office at all. */
const ADMIN_ROLES = [ROLE.ADMIN, ROLE.SUPER_ADMIN];

export function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

/**
 * Build a guard for a set of roles.
 *
 * The 403 is deliberately vague ("Administrator access is required") rather
 * than naming the role the caller is missing — a signed-in customer probing
 * /admin learns nothing about the privilege model from the response.
 */
function requireRole(allowed, message) {
  return function guard(req, res, next) {
    // Belt and braces: if someone mounts this without authenticate in front,
    // fail closed with the same 401 authenticate would have produced rather
    // than reading `role` off undefined.
    if (!req.user) {
      return next(AppError.unauthorized('Missing Bearer token', { code: 'NO_TOKEN' }));
    }

    if (!allowed.includes(req.user.role)) {
      return next(AppError.forbidden(message, { code: 'ADMIN_ACCESS_REQUIRED' }));
    }

    next();
  };
}

export const requireAdmin = requireRole(ADMIN_ROLES, 'Administrator access is required');

export const requireSuperAdmin = requireRole(
  [ROLE.SUPER_ADMIN],
  'This action is restricted to super administrators'
);
