// ============================================================
// Admin authentication.
//
// This is a SEPARATE ENTRY POINT, not a separate identity system. An admin is
// a PingOne user whose `role` is ADMIN or SUPER_ADMIN, so:
//
//   * the credential check, the token pair, the refresh-token registry and
//     the rotation/replay defences are exactly the ones in modules/auth —
//     reused, not reimplemented. One auth stack means one place for a
//     security fix to land.
//   * the only thing this layer adds is the role gate, the audit entry, and
//     a deliberately different failure message for "right password, wrong
//     privileges".
//
// It also means the session minted here is the operator's ordinary session:
// the "Exit Admin" link in the back office drops them into their own
// dashboard without a second login, which is what the design calls for.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { verifyPassword } from '../../utils/password.js';
import { issueTokens } from '../../utils/token.js';
import { sha256Hex } from '../../utils/crypto.js';
import { recordLogin, toPublicUser } from '../auth/auth.service.js';
import { isAdminRole } from '../../middleware/authorize.js';
import { AppError } from '../../utils/AppError.js';
import * as audit from './audit.service.js';
import { AUDIT_ACTION } from './audit.service.js';

/**
 * A bcrypt hash of nothing in particular. Compared against when the email is
 * unknown so that "no such account" and "wrong password" take the same
 * ~200ms — otherwise the response time alone enumerates admin accounts.
 */
const DUMMY_HASH = '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';

/**
 * Authenticate an operator into the back office.
 *
 * Order of checks is load-bearing: the password is verified BEFORE the role
 * is examined. Checking the role first would let an unauthenticated caller
 * probe which addresses are admin accounts by watching which ones answer
 * "administrator access required" instead of "invalid credentials".
 */
export async function login({ email, password }, session = {}) {
  const user = await prisma.user.findUnique({ where: { email } });

  const invalid = AppError.unauthorized('Invalid email or password', {
    code: 'INVALID_CREDENTIALS',
  });

  if (!user) {
    await verifyPassword(password, DUMMY_HASH);
    throw invalid;
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw invalid;

  if (!user.isActive || user.deletedAt) {
    throw AppError.forbidden('This account is disabled', { code: 'ACCOUNT_DISABLED' });
  }

  // Correct credentials, insufficient privileges. Worth recording: repeated
  // hits here from a valid customer account is the signature of someone
  // walking the admin surface with a password they legitimately hold.
  if (!isAdminRole(user.role)) {
    await audit.record(
      {
        adminId: user.id,
        action: AUDIT_ACTION.LOGIN_DENIED,
        targetType: 'system',
        targetLabel: user.email,
        metadata: { reason: 'INSUFFICIENT_ROLE', role: user.role },
      },
      session
    );

    throw AppError.forbidden("This account doesn't have admin access.", {
      code: 'ADMIN_ACCESS_REQUIRED',
    });
  }

  // Same housekeeping the customer login does — drop dead refresh rows.
  await prisma.refreshToken.deleteMany({
    where: { userId: user.id, expiresAt: { lt: new Date() } },
  });

  const loginAt = await recordLogin(user.id);
  const { refreshTokenExpiresAt, ...tokens } = issueTokens(user);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256Hex(tokens.refreshToken),
      expiresAt: refreshTokenExpiresAt,
      userAgent: session.userAgent?.slice(0, 255) ?? null,
      ipAddress: session.ipAddress?.slice(0, 64) ?? null,
    },
  });

  await audit.record(
    {
      adminId: user.id,
      action: AUDIT_ACTION.LOGIN,
      targetType: 'system',
      targetLabel: user.email,
      metadata: { role: user.role },
    },
    session
  );

  return { user: toPublicUser({ ...user, lastLoginAt: loginAt }), tokens };
}

/**
 * The admin's own profile. Distinct from GET /auth/me only in that reaching
 * it at all proves the caller still holds the role — the SPA calls this on
 * boot so a demoted operator is bounced out of the back office immediately
 * rather than rendering a shell whose every panel then 403s.
 */
export async function getProfile(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      isVerified: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  if (!user) throw AppError.notFound('User not found');
  return user;
}
