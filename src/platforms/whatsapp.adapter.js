// ============================================================
// WhatsApp adapter — Meta WhatsApp Cloud API.
//
// IMPORTANT LIMITATION (flag this in your report, decide it up front):
// Business-initiated messages OUTSIDE a 24h customer-service window
// require a pre-approved message TEMPLATE (Meta reviews and approves
// these) — you cannot send arbitrary free text cold. For the capstone
// demo, either:
//   (a) get one template approved in the Meta dev console and map your
//       PingOne `Template` rows 1:1 to approved WhatsApp template names, or
//   (b) only demo WhatsApp sends within a 24h window (reply to a message
//       the test number sent your business number first).
// This adapter implements the free-text path (option b / dev/test mode).
// ============================================================

import { BaseAdapter } from './base.adapter.js';
import { AppError } from '../utils/AppError.js';

const API_VERSION = 'v19.0';

export class WhatsAppAdapter extends BaseAdapter {
  static code = 'whatsapp';

  async validate({ secret: accessToken, extraInfo }) {
    const phoneNumberId = extraInfo?.phone_number_id;
    if (!phoneNumberId) {
      throw AppError.badRequest('WhatsApp credential is missing phone_number_id', {
        code: 'INVALID_WHATSAPP_CREDENTIAL',
      });
    }
    const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${phoneNumberId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    if (data.error) {
      throw AppError.badRequest('WhatsApp access token could not be verified', {
        code: 'INVALID_WHATSAPP_TOKEN',
        details: data.error.message,
      });
    }
    return true;
  }

  formatMessage(content, attachments = []) {
    // WhatsApp free-text messages are plain (no HTML). Attachments are
    // sent via a separate `type: image|document` payload by the worker.
    return { formatted: content, hasAttachments: attachments.length > 0, attachments };
  }

  async send({ secret: accessToken, extraInfo }, recipient, message) {
    const phoneNumberId = extraInfo?.phone_number_id;

    const res = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: recipient.handle, // E.164 phone number, no '+' per Meta's spec
          type: 'text',
          text: { body: message.formatted },
        }),
      }
    );
    const data = await res.json();

    if (data.error) {
      throw AppError.badRequest(`WhatsApp send failed: ${data.error.message}`, {
        code: 'WHATSAPP_SEND_FAILED',
        details: data.error,
      });
    }

    return { platformMessageId: data.messages?.[0]?.id, raw: data };
  }
}
