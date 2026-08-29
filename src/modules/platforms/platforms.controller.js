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

/**
 * POST /platforms/telegram/user/start — begin the MTProto login.
 *
 * Answers with an opaque `loginId` only. The phoneCodeHash Telegram returns
 * stays server-side: it belongs to a live connection the client has no use
 * for, and echoing it would be handing out half a login.
 */
export const startTelegramUser = asyncHandler(async (req, res) => {
  const result = await service.startTelegramUserLogin(req.user.id, req.body);
  res.status(200).json({ message: 'Telegram sent a login code', ...result });
});

/**
 * POST /platforms/telegram/user/verify — finish it and store the session.
 *
 * A `TELEGRAM_PASSWORD_REQUIRED` error here is not a failure: it means the
 * account has two-step verification, and the client should prompt and call
 * this again with the same `loginId` plus `password`.
 */
export const verifyTelegramUser = asyncHandler(async (req, res) => {
  const credential = await service.connectTelegramUser(req.user.id, req.body);
  res.status(200).json({ message: 'Telegram account connected', credential });
});

/** POST /platforms/telegram/user/cancel — drop a half-finished login. */
export const cancelTelegramUser = asyncHandler(async (req, res) => {
  const result = await service.cancelTelegramUserLogin(req.user.id, req.body);
  res.status(200).json({ message: 'Login cancelled', ...result });
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
