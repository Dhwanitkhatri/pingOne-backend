// ============================================================
// WhatsApp adapter — Meta WhatsApp Cloud API.
//
// Outside the customer-service window, business-initiated messages need a
// Meta-approved WhatsApp template. The composer can list approved text
// templates from the user's WABA and sends them through the template API.
//
// Attachments go through Meta's two-step media flow: upload the bytes to
// /{phone-number-id}/media, then send a message referencing the returned media
// id. That's deliberately preferred over passing a `link` — a link has to be
// publicly reachable, which it isn't during local development.
// ============================================================

import { BaseAdapter } from './base.adapter.js';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';

// Read from env so connecting (meta.provider.js) and sending agree on one
// Graph version — they were drifting apart, and a hardcoded version silently
// ages into Meta's 2-year deprecation window.
const GRAPH_BASE = `https://graph.facebook.com/${env.META_API_VERSION}`;

/** file_types code -> WhatsApp message type. Unknown types ride as documents. */
const MEDIA_TYPES = { image: 'image', video: 'video', audio: 'audio' };
const DEFAULT_MEDIA_TYPE = 'document';

// Meta's caption limit for media messages.
const CAPTION_LIMIT = 1024;
const TEMPLATE_MARKER = '__PINGONE_WHATSAPP_TEMPLATE_V1__:';

export class WhatsAppAdapter extends BaseAdapter {
  static code = 'whatsapp';

  async validate({ secret: accessToken, extraInfo }) {
    const phoneNumberId = extraInfo?.phone_number_id;
    if (!phoneNumberId) {
      throw AppError.badRequest('WhatsApp credential is missing phone_number_id', {
        code: 'INVALID_WHATSAPP_CREDENTIAL',
      });
    }
    const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}`, {
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
    if (content.startsWith(TEMPLATE_MARKER)) {
      let template;
      try {
        template = JSON.parse(Buffer.from(content.slice(TEMPLATE_MARKER.length), 'base64url').toString('utf8'));
      } catch {
        throw AppError.badRequest('WhatsApp template data is invalid. Select the template again.', {
          code: 'INVALID_WHATSAPP_TEMPLATE',
        });
      }
      return { formatted: template.preview ?? template.name, template, hasAttachments: attachments.length > 0, attachments };
    }
    // WhatsApp free-text messages are plain (no HTML).
    return { formatted: content, hasAttachments: attachments.length > 0, attachments };
  }

  async send({ secret: accessToken, extraInfo }, recipient, message) {
    const phoneNumberId = extraInfo?.phone_number_id;
    const attachments = message.attachments ?? [];
    const ctx = { accessToken, phoneNumberId, to: recipient.handle };

    if (message.template) {
      if (attachments.length) {
        throw AppError.badRequest('Attachments are not supported with WhatsApp template messages.', {
          code: 'WHATSAPP_TEMPLATE_ATTACHMENTS_UNSUPPORTED',
        });
      }
      const { name, language, parameters = [] } = message.template;
      if (!name || !language || !Array.isArray(parameters)) {
        throw AppError.badRequest('WhatsApp template name, language, and parameters are required.', {
          code: 'INVALID_WHATSAPP_TEMPLATE',
        });
      }
      const components = parameters.length
        ? [{
            type: 'body',
            parameters: parameters.map((text) => ({ type: 'text', text: String(text) })),
          }]
        : undefined;
      const data = await this.#post(ctx, {
        messaging_product: 'whatsapp',
        to: ctx.to,
        type: 'template',
        template: {
          name,
          language: { code: language },
          ...(components ? { components } : {}),
        },
      });
      return { platformMessageId: data.messages?.[0]?.id, raw: data };
    }

    // The marker is storage metadata, never user-facing text. If a stale or
    // mismatched worker reaches the plain-text path with it, fail closed so
    // it cannot be delivered to the recipient as a WhatsApp message.
    if (typeof message.formatted === 'string' && message.formatted.includes(TEMPLATE_MARKER)) {
      throw AppError.badRequest(
        'WhatsApp template data was not decoded. Restart the PingOne worker and select the template again.',
        { code: 'WHATSAPP_TEMPLATE_NOT_DECODED' }
      );
    }

    // Single short attachment: one captioned media message rather than two
    // separate notifications.
    if (attachments.length === 1 && message.formatted.length <= CAPTION_LIMIT) {
      const data = await this.#sendMedia(ctx, attachments[0], message.formatted);
      return { platformMessageId: data.messages?.[0]?.id, raw: data };
    }

    const textData = await this.#sendText(ctx, message.formatted);

    // Sequential — Meta rate-limits per recipient and this preserves order.
    for (const attachment of attachments) {
      await this.#sendMedia(ctx, attachment);
    }

    // The text message id is the one webhook status callbacks will reference.
    return { platformMessageId: textData.messages?.[0]?.id, raw: textData };
  }

  async #sendText(ctx, body) {
    return this.#post(ctx, {
      messaging_product: 'whatsapp',
      to: ctx.to, // E.164 phone number, no '+' per Meta's spec
      type: 'text',
      text: { body },
    });
  }

  async #sendMedia(ctx, attachment, caption) {
    const mediaId = await this.#uploadMedia(ctx, attachment);
    const type = MEDIA_TYPES[attachment.typeCode] ?? DEFAULT_MEDIA_TYPE;

    const media = { id: mediaId };
    // Only document and image accept a filename/caption pair; audio accepts
    // neither, and sending an unsupported field makes Meta reject the whole call.
    if (type === 'document') media.filename = attachment.fileName;
    if (caption && type !== 'audio') media.caption = caption;

    return this.#post(ctx, {
      messaging_product: 'whatsapp',
      to: ctx.to,
      type,
      [type]: media,
    });
  }

  /** Step one of the media flow: POST the bytes, get an id back. */
  async #uploadMedia({ accessToken, phoneNumberId }, attachment) {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', attachment.mimeType);
    form.append(
      'file',
      new Blob([attachment.buffer], { type: attachment.mimeType }),
      attachment.fileName
    );

    const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` }, // no Content-Type — fetch sets the boundary
      body: form,
    });
    const data = await res.json();

    if (data.error || !data.id) {
      throw AppError.badRequest(
        `WhatsApp media upload failed for "${attachment.fileName}": ${data.error?.message ?? 'no media id returned'}`,
        { code: 'WHATSAPP_MEDIA_UPLOAD_FAILED', details: data.error }
      );
    }
    return data.id;
  }

  async #post({ accessToken, phoneNumberId }, payload) {
    const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.error) {
      throw AppError.badRequest(`WhatsApp send failed: ${data.error.message}`, {
        code: 'WHATSAPP_SEND_FAILED',
        details: data.error,
      });
    }
    return data;
  }
}
