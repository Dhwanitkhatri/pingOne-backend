// ============================================================
// WhatsApp adapter — Meta WhatsApp Cloud API, or Twilio's WhatsApp sender
// when WHATSAPP_PROVIDER=twilio (see #sendViaTwilio).
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
    if (env.WHATSAPP_PROVIDER === 'twilio') return this.#sendViaTwilio(recipient, message);

    const phoneNumberId = extraInfo?.phone_number_id;
    // An OAuth connect whose number couldn't be discovered stores null here;
    // without this Graph gets POST /null/messages and a baffling error back.
    if (!phoneNumberId) {
      throw AppError.badRequest(
        'WhatsApp is connected without a phone number ID. Reconnect WhatsApp and paste the ' +
          'Phone number ID from WhatsApp → API Setup in your Meta app.',
        { code: 'WHATSAPP_PHONE_NUMBER_ID_MISSING' }
      );
    }
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

  /**
   * WHATSAPP_PROVIDER=twilio: deliver through Twilio's WhatsApp sender with the
   * server's own Twilio account; the user's Meta credential is not used.
   * Templates go out as their filled-in body text, which the Sandbox accepts
   * inside the 24h window that joining it opens.
   */
  async #sendViaTwilio(recipient, message) {
    const accountSid = env.TWILIO_ACCOUNT_SID;
    const authToken = env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      throw new AppError(
        503,
        'WHATSAPP_PROVIDER is "twilio" but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set.',
        { code: 'WHATSAPP_TWILIO_NOT_CONFIGURED' }
      );
    }

    // Contacts hold "+91…" or bare digits; Twilio wants E.164 with the "+".
    const to = `whatsapp:+${String(recipient.handle).replace(/\D/g, '')}`;
    const from = `whatsapp:${env.TWILIO_WHATSAPP_FROM}`;
    // The composer stores the preview as "WhatsApp template: <name>\n<body>".
    const body = message.template
      ? message.template.preview?.split('\n').slice(1).join('\n') ||
        message.template.bodyText ||
        message.template.name
      : message.formatted;

    // WhatsApp carries one media item per message: the first rides with the
    // text, any others follow on their own, in order.
    const [first, ...rest] = message.attachments ?? [];
    const data = await this.#postTwilio({ accountSid, authToken }, { From: from, To: to, Body: body }, first);
    for (const attachment of rest) {
      await this.#postTwilio({ accountSid, authToken }, { From: from, To: to }, attachment);
    }

    return { platformMessageId: data.sid, raw: data };
  }

  async #postTwilio({ accountSid, authToken }, fields, attachment) {
    const params = new URLSearchParams(fields);
    // Twilio fetches media from this URL itself, so PUBLIC_BASE_URL must be public.
    if (attachment) params.append('MediaUrl', attachment.fileUrl);

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    const data = await res.json();

    if (!res.ok) {
      // 63015 = recipient hasn't joined the Sandbox — the usual first failure.
      throw AppError.badRequest(`WhatsApp send failed: ${data.message}`, {
        code: 'WHATSAPP_SEND_FAILED',
        details: data,
      });
    }
    return data;
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
