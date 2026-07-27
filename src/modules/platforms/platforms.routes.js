// ============================================================
// Platform credential routes (mounted at /api/v1/platforms, and at
// /api/v1/credentials as a legacy alias). All require an authenticated
// user — you connect accounts to YOUR own PingOne profile.
//
//   GET    /platforms            list connected platforms
//   POST   /platforms/telegram   connect a Telegram bot (manual token)
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
router.post('/google', validate({ body: googleSchema }), controller.addGoogle);
router.post('/twilio', validate({ body: twilioSchema }), controller.addTwilio);

// Legacy alias — Twilio was originally exposed under its platform code.
router.post('/sms', validate({ body: twilioSchema }), controller.addTwilio);

router.delete('/:code', validate({ params: platformCodeParamSchema }), controller.remove);

export default router;
