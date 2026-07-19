// ============================================================
// Auth service — all business logic for authentication.
// Controllers stay thin; this layer owns DB access and rules.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { issueTokens, verifyRefreshToken } from '../../utils/token.js';
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
