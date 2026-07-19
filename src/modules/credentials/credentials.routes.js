// ============================================================
// Platform credential routes. All require an authenticated user —
// you connect accounts to YOUR own PingOne profile.
//
//   POST /api/v1/credentials/whatsapp   connect WhatsApp Cloud API
//   POST /api/v1/credentials/telegram   connect a Telegram bot
//   POST /api/v1/credentials/google     connect Google / Gmail (OAuth2)
//   POST /api/v1/credentials/sms         connect Twilio (SMS)
// ============================================================

import { Router } from 'express';
import * as controller from './credentials.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import {
  whatsappSchema,
  telegramSchema,
  googleSchema,
  twilioSchema,
} from './credentials.schema.js';

const router = Router();

// Every credential endpoint is protected.
router.use(authenticate);

router.post('/whatsapp', validate({ body: whatsappSchema }), controller.addWhatsApp);
router.post('/telegram', validate({ body: telegramSchema }), controller.addTelegram);
router.post('/google', validate({ body: googleSchema }), controller.addGoogle);
router.post('/sms', validate({ body: twilioSchema }), controller.addTwilio);

export default router;
