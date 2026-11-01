// ============================================================
// Webhook Routes — PUBLIC. These are the only unauthenticated write
// endpoints in the API.
//
// GET   /webhooks/whatsapp    Meta subscription handshake (hub.challenge)
// POST  /webhooks/whatsapp    Meta Cloud API status callbacks
// POST  /webhooks/telegram    Telegram Bot API updates
// POST  /webhooks/twilio/status   Twilio delivered/read/failed callbacks
// POST  /webhooks/twilio/inbound  replies to our Twilio WhatsApp/SMS numbers
//
// There is deliberately no `authenticate` on this router: the callers are
// Meta's and Telegram's servers, which have no PingOne session. Authentication
// happens per-request in signature.js instead, via HMAC (Meta) and a shared
// secret token (Telegram). Do not add a JWT check here — it would break the
// integration without adding protection.
//
// Registering these with the platforms:
//
//   WhatsApp   Meta App Dashboard -> WhatsApp -> Configuration -> Callback URL
//              https://<host>/api/v1/webhooks/whatsapp
//              Verify token: META_WEBHOOK_VERIFY_TOKEN
//              Subscribe to the `messages` field to receive status callbacks.
//
//   Telegram   curl -X POST \
//                "https://api.telegram.org/bot<TOKEN>/setWebhook" \
//                -d "url=https://<host>/api/v1/webhooks/telegram" \
//                -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
//
//   Twilio     Status callbacks need no setup — every send passes
//              StatusCallback=https://<host>/api/v1/webhooks/twilio/status.
//              For replies, set "A message comes in" (number / WhatsApp
//              sender / Sandbox settings) to
//              https://<host>/api/v1/webhooks/twilio/inbound  (HTTP POST)
//
// Locally, point both at a tunnel (`ngrok http 4000`) — the platforms need to
// reach the endpoint from the public internet.
// ============================================================

import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import * as webhookController from './webhooks.controller.js';

const router = Router();

/**
 * Generous ceiling — a real burst of status callbacks after a large broadcast
 * is legitimate traffic, so this is here to bound abuse of a public endpoint,
 * not to shape normal load. Requests are cheap: an unsigned one is rejected
 * before it touches the database.
 */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600, // ~10/second sustained
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many webhook requests', code: 'RATE_LIMITED' } },
});

router.use(webhookLimiter);

// WhatsApp — Meta uses GET to verify the subscription, POST to deliver events.
router.get('/whatsapp', webhookController.verifyWhatsAppWebhook);
router.post('/whatsapp', webhookController.receiveWhatsAppWebhook);

// Telegram
router.post('/telegram', webhookController.receiveTelegramWebhook);

// Twilio — status callbacks are requested per message (StatusCallback);
// inbound replies need the URL set once in the Twilio console (see top).
router.post('/twilio/status', webhookController.receiveTwilioStatus);
router.post('/twilio/inbound', webhookController.receiveTwilioInbound);

export default router;
