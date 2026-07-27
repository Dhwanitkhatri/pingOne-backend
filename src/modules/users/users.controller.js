// ============================================================
// User settings controllers — HTTP <-> service translation.
// ============================================================

import * as usersService from './users.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const getPreferences = asyncHandler(async (req, res) => {
  const preferences = await usersService.getPreferences(req.user.id);
  res.status(200).json({ data: preferences });
});

export const updatePreferences = asyncHandler(async (req, res) => {
  const preferences = await usersService.updatePreferences(req.user.id, req.body);
  res.status(200).json({ message: 'Preferences updated', data: preferences });
});
