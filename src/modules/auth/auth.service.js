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
import {
  issueTokens,
  verifyRefreshToken,
  issueEmailVerificationToken,
  verifyEmailVerificationToken,
} from '../../utils/token.js';
import { generateToken, sha256Hex } from '../../utils/crypto.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../../utils/mailer.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';

// Fields safe to return to the client (never the password hash).
//
// `role` is included so the SPA can decide whether to offer the back office at
// all. It is a display hint only — every /admin endpoint re-checks the role
// server-side (see middleware/authorize.js); nothing trusts this value.
export const publicUserSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  isVerified: true,
  isActive: true,
  role: true,
  lastLoginAt: true,
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

  // Not awaited: an SMTP round-trip shouldn't slow signup down, and a failed
  // send must not fail it either — the dashboard offers "Resend email".
  sendVerification(user).catch((err) => {
    console.error(`[auth] could not send the verification email to ${user.email}: ${err.message}`);
  });

  const tokens = await issueAndPersistTokens(user, session);
  return { user, tokens };
}

/**
 * Email a user the link that verifies their address. Throws if the send
 * fails, so each caller decides whether that matters to the client.
 * @param {{ id: number, email: string, firstName: string }} user
 */
async function sendVerification(user) {
  const token = issueEmailVerificationToken({ userId: user.id, email: user.email });
  // The frontend route is /verifyemail — see VerifyEmailCard.jsx.
  const verifyUrl = `${env.FRONTEND_URL.replace(/\/+$/, '')}/verifyemail?token=${encodeURIComponent(token)}`;

  await sendVerificationEmail(user.email, {
    firstName: user.firstName,
    verifyUrl,
    ttlHours: env.EMAIL_VERIFICATION_TTL_HOURS,
  });
}

/**
 * Send a fresh verification link to a signed-in user. Unlike the reset flow
 * there is nothing to enumerate here — the caller is authenticated — so a
 * failed send is reported instead of swallowed.
 * @returns {Promise<{ alreadyVerified: boolean }>}
 */
export async function resendVerification(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, firstName: true, isVerified: true },
  });
  if (!user) throw AppError.notFound('User not found');

  if (user.isVerified) return { alreadyVerified: true };

  try {
    await sendVerification(user);
  } catch (err) {
    console.error(`[auth] could not resend the verification email to ${user.email}: ${err.message}`);
    throw new AppError(503, "We couldn't send the verification email right now. Please try again shortly.", {
      code: 'EMAIL_SEND_FAILED',
    });
  }

  return { alreadyVerified: false };
}

/**
 * Consume a verification link. Idempotent: opening the link twice, or after
 * verifying some other way, still succeeds.
 * @returns {Promise<object>} the public user, now verified
 */
export async function verifyEmail({ token }) {
  const { userId, email } = verifyEmailVerificationToken(token);

  const user = await prisma.user.findFirst({
    where: { id: userId, isActive: true, deletedAt: null },
    select: publicUserSelect,
  });

  // A link issued for an address the account no longer has proves nothing
  // about the current one.
  if (!user || user.email !== email) {
    throw AppError.badRequest('This verification link is invalid or has expired', {
      code: 'INVALID_VERIFICATION_TOKEN',
    });
  }

  if (user.isVerified) return user;

  return prisma.user.update({
    where: { id: user.id },
    data: { isVerified: true },
    select: publicUserSelect,
  });
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

  const loginAt = await recordLogin(user.id);
  const tokens = await issueAndPersistTokens(user, session);
  return { user: toPublicUser({ ...user, lastLoginAt: loginAt }), tokens };
}

/**
 * Stamp a successful credential login.
 *
 * This is the sole writer of `users.last_login_at`, and the admin dashboard's
 * "Active Users" figure is a count over that column — so any new sign-in path
 * must come through here or it will silently under-report activity.
 *
 * A failure to stamp must never fail the login itself: the user authenticated
 * correctly, and losing one analytics data point is not worth locking them out.
 *
 * @returns {Promise<Date>} the timestamp written
 */
export async function recordLogin(userId) {
  const now = new Date();

  try {
    await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: now } });
  } catch (err) {
    console.error(`[auth] could not record last_login_at for user ${userId}: ${err.message}`);
  }

  return now;
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

  // A failed send must NOT become a 500. The controller answers identically
  // for known and unknown emails precisely so an attacker can't enumerate
  // accounts — and a 500 that only ever happens for real users would hand
  // back exactly that signal. Log it loudly instead; the operator sees the
  // cause in the server log, the caller sees the same reply either way.
  try {
    await sendPasswordResetEmail(user.email, resetUrl, env.PASSWORD_RESET_TTL_MIN);
  } catch (err) {
    console.error(
      `[auth] password reset token was created for ${user.email} but the email could not be sent: ${err.message}`
    );
  }
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

export function toPublicUser(user) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    isVerified: user.isVerified,
    isActive: user.isActive,
    role: user.role,
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt,
  };
}
