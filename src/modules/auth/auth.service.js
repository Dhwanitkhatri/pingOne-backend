// ============================================================
// Auth service — all business logic for authentication.
// Controllers stay thin; this layer owns DB access and rules.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { issueTokens, verifyRefreshToken } from '../../utils/token.js';
import { generateToken, sha256Hex } from '../../utils/crypto.js';
import { sendPasswordResetEmail } from '../../utils/mailer.js';
import { env } from '../../config/env.js';
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

/**
 * Register a new user. Also creates their default notification
 * preferences row in the same transaction (nested create).
 */
export async function register({ firstName, lastName, email, password }) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw AppError.conflict('An account with that email already exists', {
      code: 'EMAIL_TAKEN',
    });
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      firstName,
      lastName,
      email,
      passwordHash,
      notificationPreferences: { create: {} }, // defaults from schema
    },
    select: publicUserSelect,
  });

  const tokens = issueTokens(user);
  return { user, tokens };
}

/** Authenticate with email + password. */
export async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });

  // Uniform error + always run a compare to blunt user-enumeration and
  // timing side-channels (don't reveal whether the email exists).
  const invalid = AppError.unauthorized('Invalid email or password', {
    code: 'INVALID_CREDENTIALS',
  });

  if (!user) {
    await verifyPassword(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
    throw invalid;
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw invalid;

  if (!user.isActive || user.deletedAt) {
    throw AppError.forbidden('This account is disabled', { code: 'ACCOUNT_DISABLED' });
  }

  const tokens = issueTokens(user);
  return { user: toPublicUser(user), tokens };
}

/** Exchange a valid refresh token for a fresh access/refresh pair. */
export async function refresh({ refreshToken }) {
  const payload = verifyRefreshToken(refreshToken);

  const user = await prisma.user.findFirst({
    where: { id: payload.sub, isActive: true, deletedAt: null },
    select: { id: true, email: true },
  });
  if (!user) {
    throw AppError.unauthorized('User no longer exists or is inactive', {
      code: 'USER_INACTIVE',
    });
  }

  return { tokens: issueTokens(user) };
}

/**
 * Start a password reset. Generates a single-use token, stores only its
 * hash, and emails the raw token as a link. Intentionally reveals nothing
 * about whether the email exists — the caller always returns the same
 * response (no user enumeration).
 */
export async function requestPasswordReset({ email }) {
  const user = await prisma.user.findFirst({
    where: { email, isActive: true, deletedAt: null },
    select: { id: true, email: true },
  });

  // Unknown / disabled account: do nothing, but let the caller respond
  // identically to the success case.
  if (!user) return;

  const rawToken = generateToken(32);
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MIN * 60_000);

  // Keep at most one active reset token per user — invalidate any older ones.
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
    prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt } }),
  ]);

  const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${rawToken}`;
  await sendPasswordResetEmail(user.email, resetUrl, env.PASSWORD_RESET_TTL_MIN);
}

/**
 * Complete a password reset. Validates the token (exists, unused, unexpired,
 * belongs to a live account), sets the new password, and destroys every reset
 * token for that user so the link can't be replayed.
 */
export async function resetPassword({ token, password }) {
  const tokenHash = sha256Hex(token);

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, isActive: true, deletedAt: true } } },
  });

  const invalid = AppError.badRequest('This password reset link is invalid or has expired', {
    code: 'INVALID_RESET_TOKEN',
  });

  if (!record || record.usedAt || record.expiresAt < new Date()) throw invalid;
  if (!record.user.isActive || record.user.deletedAt) throw invalid;

  const passwordHash = await hashPassword(password);

  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.deleteMany({ where: { userId: record.userId } }),
  ]);
}

/** Load the full public profile for an authenticated user. */
export async function getProfile(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...publicUserSelect, notificationPreferences: true },
  });
  if (!user) throw AppError.notFound('User not found');
  return user;
}

function toPublicUser(user) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    isVerified: user.isVerified,
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
}
