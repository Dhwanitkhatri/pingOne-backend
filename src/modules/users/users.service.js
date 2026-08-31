// ============================================================
// User settings service — notification preferences and account actions.
//
// Signup creates the preferences row, but reads still upsert: an account
// created before this table existed (or one whose row was cleaned up)
// should get sensible defaults instead of a 404. The schema defaults are
// the single source of truth for what those are.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { AppError } from '../../utils/AppError.js';

// Fields safe to return to the client (never the password hash).
const publicUserSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  isVerified: true,
  isActive: true,
  createdAt: true,
};

const preferenceSelect = {
  notifyOnFailure: true,
  notifyOnSuccess: true,
  notifyOnTokenExpiry: true,
  digestFrequency: true,
  updatedAt: true,
};

/** Read the user's preferences, creating the defaults row if absent. */
export function getPreferences(userId) {
  return prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId }, // all columns fall back to their schema defaults
    update: {},
    select: preferenceSelect,
  });
}

/**
 * Partially update the preferences. Upsert covers the case where the row
 * doesn't exist yet, so the first write never has to be preceded by a read.
 */
export function updatePreferences(userId, input) {
  const data = {};
  if (input.notifyOnFailure !== undefined) data.notifyOnFailure = input.notifyOnFailure;
  if (input.notifyOnSuccess !== undefined) data.notifyOnSuccess = input.notifyOnSuccess;
  if (input.notifyOnTokenExpiry !== undefined) data.notifyOnTokenExpiry = input.notifyOnTokenExpiry;
  if (input.digestFrequency !== undefined) data.digestFrequency = input.digestFrequency;

  return prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
    select: preferenceSelect,
  });
}

/* ── Profile ──────────────────────────────────────────────────────────── */

/**
 * Update the user's first and/or last name.
 * Returns the updated user (public fields only).
 */
export async function updateProfile(userId, { firstName, lastName }) {
  const data = {};
  if (firstName !== undefined) data.firstName = firstName;
  if (lastName !== undefined) data.lastName = lastName;

  const user = await prisma.user.update({
    where: { id: userId },
    data,
    select: publicUserSelect,
  });

  return user;
}

/* ── Password ─────────────────────────────────────────────────────────── */

/**
 * Change the password while signed in.
 *
 * The current password is verified first so a hijacked tab can't lock the
 * real owner out. On success every other session is revoked — the same
 * posture as /auth/reset-password.
 */
export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });

  if (!user) {
    throw AppError.notFound('User not found');
  }

  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    throw AppError.unauthorized('Current password is incorrect', {
      code: 'INVALID_CREDENTIALS',
    });
  }

  const passwordHash = await hashPassword(newPassword);

  // Update password and revoke all other sessions in one transaction.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

/* ── Account deletion ─────────────────────────────────────────────────── */

/**
 * Permanently close the account.
 *
 * Re-authenticates with the password, then soft-deletes the user
 * (sets deletedAt + isActive=false), disconnects every platform
 * credential, and revokes all sessions.
 */
export async function deleteAccount(userId, { password }) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });

  if (!user) {
    throw AppError.notFound('User not found');
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw AppError.unauthorized('Password is incorrect', {
      code: 'INVALID_CREDENTIALS',
    });
  }

  const now = new Date();

  await prisma.$transaction([
    // Soft-delete the user.
    prisma.user.update({
      where: { id: userId },
      data: { isActive: false, deletedAt: now },
    }),
    // Disconnect all platform credentials.
    prisma.userPlatformCredential.deleteMany({
      where: { userId },
    }),
    // Revoke all sessions.
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);
}
