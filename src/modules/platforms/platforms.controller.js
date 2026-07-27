// ============================================================
// Platform credential controllers — one per platform, plus list and
// disconnect. Thin: validate (via middleware) -> call service -> return
// the stored credential. req.user is guaranteed by `authenticate`.
// ============================================================

import * as service from './platforms.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
  const credentials = await service.listCredentials(req.user.id);
  res.status(200).json({ data: credentials });
});

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

export const remove = asyncHandler(async (req, res) => {
  const result = await service.disconnect(req.user.id, req.params.code);
  res.status(200).json({ message: `${req.params.code} disconnected`, ...result });
});
