// ============================================================
// Auth controllers — translate HTTP <-> service calls. Thin by design.
// ============================================================

import * as authService from './auth.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const register = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.register(req.body);
  res.status(201).json({ user, ...tokens });
});

export const login = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.login(req.body);
  res.status(200).json({ user, ...tokens });
});

export const refresh = asyncHandler(async (req, res) => {
  const { tokens } = await authService.refresh(req.body);
  res.status(200).json(tokens);
});

export const me = asyncHandler(async (req, res) => {
  const user = await authService.getProfile(req.user.id);
  res.status(200).json({ user });
});
