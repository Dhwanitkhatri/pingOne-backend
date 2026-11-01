// ============================================================
// User settings controllers — HTTP <-> service translation.
// ============================================================

import * as usersService from './users.service.js';
import * as digestService from '../notifications/digest.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const getPreferences = asyncHandler(async (req, res) => {
  const preferences = await usersService.getPreferences(req.user.id);
  res.status(200).json({ data: preferences });
});

export const updatePreferences = asyncHandler(async (req, res) => {
  const preferences = await usersService.updatePreferences(req.user.id, req.body);
  res.status(200).json({ message: 'Preferences updated', data: preferences });
});

export const sendDigestNow = asyncHandler(async (req, res) => {
  const result = await digestService.sendDigestNow(req.user.id);
  res.status(200).json({ message: `Summary sent to ${result.email}`, data: result });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const user = await usersService.updateProfile(req.user.id, req.body);
  res.status(200).json({ message: 'Profile updated', data: user });
});

export const changePassword = asyncHandler(async (req, res) => {
  await usersService.changePassword(req.user.id, req.body);
  res.status(200).json({ message: 'Password changed successfully' });
});

export const deleteAccount = asyncHandler(async (req, res) => {
  await usersService.deleteAccount(req.user.id, req.body);
  res.status(200).json({ message: 'Account deleted successfully' });
});
