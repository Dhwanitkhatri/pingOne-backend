// ============================================================
// Platform credential routes (mounted at /api/v1/platforms, and at
// /api/v1/credentials as a legacy alias). All require an authenticated
// user — you connect accounts to YOUR own PingOne profile.
//
//   GET    /platforms            list connected platforms
//   POST   /platforms/telegram   connect a Telegram bot (manual token)
//   POST   /platforms/telegram/user/start   MTProto login: request a code
//   POST   /platforms/telegram/user/verify  MTProto login: submit code/2FA
//   POST   /platforms/telegram/user/cancel  abandon a half-finished login
//   POST   /platforms/twilio     connect Twilio / SMS (manual credentials)
//   POST   /platforms/whatsapp   connect WhatsApp Cloud API (manual token)
//   POST   /platforms/google     connect Gmail with an existing refresh token
//   DELETE /platforms/:code      disconnect (whatsapp|telegram|gmail|sms)
//
// The browser OAuth alternatives live at GET /auth/google and /auth/meta.
// ============================================================

import { Router } from 'express';
import * as controller from './platforms.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import {
  whatsappSchema,
  telegramSchema,
  telegramUserStartSchema,
  telegramUserVerifySchema,
  telegramUserCancelSchema,
  googleSchema,
  twilioSchema,
  platformCodeParamSchema,
} from './platforms.schema.js';

const router = Router();

// Every credential endpoint is protected.
router.use(authenticate);

router.get('/', controller.list);

router.post('/whatsapp', validate({ body: whatsappSchema }), controller.addWhatsApp);
router.post('/telegram', validate({ body: telegramSchema }), controller.addTelegram);

// Telegram as a real USER account (MTProto), a two-step interactive login.
// Declared before nothing else needs care — these paths are longer than
// '/telegram' so they can't shadow it.
router.post(
  '/telegram/user/start',
  validate({ body: telegramUserStartSchema }),
  controller.startTelegramUser
);
router.post(
  '/telegram/user/verify',
  validate({ body: telegramUserVerifySchema }),
  controller.verifyTelegramUser
);
router.post(
  '/telegram/user/cancel',
  validate({ body: telegramUserCancelSchema }),
  controller.cancelTelegramUser
);
router.post('/google', validate({ body: googleSchema }), controller.addGoogle);
router.post('/twilio', validate({ body: twilioSchema }), controller.addTwilio);

// Legacy alias — Twilio was originally exposed under its platform code.
router.post('/sms', validate({ body: twilioSchema }), controller.addTwilio);

router.delete('/:code', validate({ params: platformCodeParamSchema }), controller.remove);

export default router;
