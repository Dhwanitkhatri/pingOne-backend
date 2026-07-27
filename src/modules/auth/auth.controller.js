// ============================================================
// Auth controllers — translate HTTP <-> service calls. Thin by design.
// ============================================================

import * as authService from './auth.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/**
 * Request context stored alongside a refresh token so a user can tell
 * their sessions apart (and so we can spot an unfamiliar one).
 */
function sessionContext(req) {
  return { userAgent: req.get('user-agent') ?? undefined, ipAddress: req.ip };
}

export const signup = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.register(req.body, sessionContext(req));
  res.status(201).json({ user, ...tokens });
});

export const login = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.login(req.body, sessionContext(req));
  res.status(200).json({ user, ...tokens });
});

export const refresh = asyncHandler(async (req, res) => {
  const { tokens } = await authService.refresh(req.body, sessionContext(req));
  res.status(200).json(tokens);
});

export const logout = asyncHandler(async (req, res) => {
  // req.user is optional here: an expired access token shouldn't stop
  // someone from logging out.
  const { revoked } = await authService.logout(req.body, req.user?.id ?? null);
  res.status(200).json({ message: 'Logged out', sessionsRevoked: revoked });
});

export const me = asyncHandler(async (req, res) => {
  const user = await authService.getProfile(req.user.id);
  res.status(200).json({ user });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  await authService.requestPasswordReset(req.body);
  // Always the same response — never reveal whether the email is registered.
  res.status(200).json({
    message: 'If an account with that email exists, a password reset link has been sent.',
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body);
  res.status(200).json({ message: 'Your password has been reset. You can now log in.' });
});
