// ============================================================
// Webhook controllers.
//
// One rule governs the response codes here, and it's the opposite of the rest
// of the API: acknowledge fast, and only fail when a retry would actually help.
//
//   * A signature that doesn't verify -> 401/403. Never retryable.
//   * An event we processed, ignored, or couldn't match -> 200. Meta retries a
//     non-2xx for up to 7 days, and retrying a payload we already understand
//     and rejected on its merits accomplishes nothing.
//   * A genuine infrastructure failure (DB down) -> let it throw. That reaches
//     errorHandler as a 500 and the platform retries later, which is exactly
//     what we want, because every handler is idempotent.
// ============================================================

import * as webhookService from './webhooks.service.js';
import {
  verifyMetaSignature,
  verifyMetaSubscription,
  verifyTelegramSecret,
  verifyTwilioSignature,
} from './signature.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/**
 * GET /webhooks/whatsapp — Meta's subscription handshake.
 * Must reply with the raw challenge as text/plain; a JSON-wrapped body fails
 * verification in the Meta dashboard.
 */
export const verifyWhatsAppWebhook = asyncHandler(async (req, res) => {
  const challenge = verifyMetaSubscription(req.query);
  res.status(200).type('text/plain').send(challenge);
});

/** POST /webhooks/whatsapp — Meta Cloud API status callbacks. */
export const receiveWhatsAppWebhook = asyncHandler(async (req, res) => {
  verifyMetaSignature(req);

  const summary = await webhookService.handleWhatsAppEvent(req.body);

  console.log(
    `[webhook:whatsapp] processed=${summary.processed} ignored=${summary.ignored} unmatched=${summary.unmatched}`
  );
  res.status(200).json({ received: true, ...summary });
});

/** POST /webhooks/twilio/whatsapp — Twilio message status callback. */
export const receiveTwilioWhatsAppStatus = asyncHandler(async (req, res) => {
  verifyTwilioSignature(req);

  const summary = await webhookService.handleTwilioWhatsAppStatus(req.body);

  console.log(
    `[webhook:twilio:whatsapp] processed=${summary.processed} ignored=${summary.ignored} unmatched=${summary.unmatched}`
  );
  res.status(200).json({ received: true, ...summary });
});

/** POST /webhooks/telegram — Telegram Bot API updates. */
export const receiveTelegramWebhook = asyncHandler(async (req, res) => {
  verifyTelegramSecret(req);

  const summary = await webhookService.handleTelegramEvent(req.body);

  console.log(
    `[webhook:telegram] processed=${summary.processed} ignored=${summary.ignored} unmatched=${summary.unmatched}`
  );
  res.status(200).json({ received: true, ...summary });
});
