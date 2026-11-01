// ============================================================
// What an unverified account may do.
//
// An unverified user can sign in and look at everything — reads are always
// allowed — but cannot change anything that reaches other people or other
// services until they confirm their email address: sending, scheduling,
// contacts, groups, templates, AI drafting, and connecting platforms.
//
// This is an ALLOWLIST of the writes that stay open, not a blocklist of the
// ones that don't, so a feature module added later is locked by default
// instead of silently left open.
// ============================================================

import { env } from '../config/env.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Writes an unverified user still needs: signing out and resending the link
 * (/auth), managing their own account (/users), clearing notifications, and
 * the back office, which is role-gated separately.
 */
const OPEN_WRITE_PREFIXES = ['/auth/', '/users/', '/notifications/', '/admin/'];

/**
 * GETs that are really actions: each starts connecting a platform by
 * returning the provider's consent URL.
 */
const BLOCKED_READS = new Set(['/auth/google', '/auth/meta', '/auth/twilio']);

/** @returns {boolean} whether an unverified user must be refused this request */
export function isBlockedUntilVerified(req) {
  const path = req.originalUrl.split('?')[0].slice(env.API_PREFIX.length).replace(/\/+$/, '');

  if (SAFE_METHODS.has(req.method)) return BLOCKED_READS.has(path);

  return !OPEN_WRITE_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix));
}
