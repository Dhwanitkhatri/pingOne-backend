// ============================================================
// Auth service — all business logic for authentication.
// Controllers stay thin; this layer owns DB access and rules.
//
// Refresh tokens are mirrored in the `refresh_tokens` table (SHA-256
// hash only). That registry is what makes logout real — the token is
// revoked server-side rather than merely dropped by the client — and
// it lets /auth/refresh ROTATE: every use revokes the presented token
// and issues a new one, so replaying an old token is detectable.
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
 * Mint a token pair and record the refresh half in the registry.
 * @param {{ id: number, email: string }} user
 * @param {{ userAgent?: string, ipAddress?: string }} [session] request context
 * @returns {Promise<object>} the client-facing token payload
 */
async function issueAndPersistTokens(user, session = {}) {
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

  return tokens;
}

/**
 * Register a new user. Also creates their default notification
 * preferences row in the same statement (nested create).
 */
export async function register({ firstName, lastName, email, password }, session) {
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

  const tokens = await issueAndPersistTokens(user, session);
  return { user, tokens };
}

/** Authenticate with email + password. */
export async function login({ email, password }, session) {
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

  // Opportunistic housekeeping — keep the registry from growing forever.
  await prisma.refreshToken.deleteMany({
    where: { userId: user.id, expiresAt: { lt: new Date() } },
  });

  const tokens = await issueAndPersistTokens(user, session);
  return { user: toPublicUser(user), tokens };
}

/**
 * Exchange a valid refresh token for a fresh pair, rotating it.
 *
 * Presenting an ALREADY-REVOKED token means either a replay or a stolen
 * token being used alongside the legitimate client. We can't tell which,
 * so every session for that user is revoked and they must log in again.
 */
export async function refresh({ refreshToken }, session) {
  const payload = verifyRefreshToken(refreshToken);
  const tokenHash = sha256Hex(refreshToken);

  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  // Signature is valid but we've never seen it (or it was pruned):
  // treat as unusable rather than trusting the JWT alone.
  if (!stored) {
    throw AppError.unauthorized('This session is no longer valid — please log in again', {
      code: 'REFRESH_TOKEN_UNKNOWN',
    });
  }

  if (stored.revokedAt) {
    await revokeAllSessions(stored.userId);
    throw AppError.unauthorized('This session was revoked — please log in again', {
      code: 'REFRESH_TOKEN_REUSED',
    });
  }

  if (stored.expiresAt < new Date()) {
    throw AppError.unauthorized('This session has expired — please log in again', {
      code: 'REFRESH_TOKEN_EXPIRED',
    });
  }

  const user = await prisma.user.findFirst({
    where: { id: payload.sub, isActive: true, deletedAt: null },
    select: { id: true, email: true },
  });
  if (!user) {
    throw AppError.unauthorized('User no longer exists or is inactive', {
      code: 'USER_INACTIVE',
    });
  }

  // Rotate: the presented token dies the moment it is spent.
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  const tokens = await issueAndPersistTokens(user, session);
  return { tokens };
}

/**
 * Log out. Revokes the presented refresh token — or every session for
 * the user when `allDevices` is set. Idempotent: logging out twice, or
 * with a token we don't recognise, still reports success (there is no
 * useful distinction for the client, and no information to leak).
 */
export async function logout({ refreshToken, allDevices = false }, userId = null) {
  if (allDevices) {
    if (!userId) {
      throw AppError.unauthorized('Log in to sign out of all devices', { code: 'NO_TOKEN' });
    }
    const { count } = await revokeAllSessions(userId);
    return { revoked: count };
  }

  const { count } = await prisma.refreshToken.updateMany({
    where: { tokenHash: sha256Hex(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return { revoked: count };
}

/** Revoke every live refresh token belonging to a user. */
export function revokeAllSessions(userId) {
  return prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
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
 * belongs to a live account), sets the new password, destroys every reset
 * token for that user so the link can't be replayed, and signs out all
 * existing sessions — a reset is usually a response to a compromise.
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
    prisma.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
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
