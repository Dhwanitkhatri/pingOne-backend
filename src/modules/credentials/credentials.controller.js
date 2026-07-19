// ============================================================
// Credentials controllers — one per platform. Thin: validate (via
// middleware) -> call service -> return the stored credential.
// req.user is guaranteed by the authenticate middleware on these routes.
// ============================================================

import * as service from './credentials.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const addWhatsApp = asyncHandler(async (req, res) => {
  const credential = await service.connectWhatsApp(req.user.id, req.body);
  res.status(200).json({ message: 'WhatsApp account connected', credential });
});

export const addTelegram = asyncHandler(async (req, res) => {
  const credential = await service.connectTelegram(req.user.id, req.body);
  res.status(200).json({ message: 'Telegram bot connected', credential });
});

export const addGoogle = asyncHandler(async (req, res) => {
  const credential = await service.connectGoogle(req.user.id, req.body);
  res.status(200).json({ message: 'Google (Gmail) account connected', credential });
});

export const addTwilio = asyncHandler(async (req, res) => {
  const credential = await service.connectTwilio(req.user.id, req.body);
  res.status(200).json({ message: 'Twilio (SMS) account connected', credential });
});
