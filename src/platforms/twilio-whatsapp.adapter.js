// ============================================================
// Twilio WhatsApp Sandbox adapter.
//
// The Sandbox requires an approved Twilio Content template. PingOne's composed
// text is passed as template variable {{1}}; it is never sent as free-form
// WhatsApp body text. Credentials are server-wide and intentionally separate
// from users' Meta WhatsApp credentials.
// ============================================================

import twilio from 'twilio';
import { BaseAdapter } from './base.adapter.js';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';
import { twilioWhatsAppStatusCallbackUrl } from '../utils/webhook-urls.js';

const META_TEMPLATE_MARKER = '__PINGONE_WHATSAPP_TEMPLATE_V1__:';
const E164 = /^\+[1-9]\d{6,14}$/;

export class TwilioWhatsAppAdapter extends BaseAdapter {
  static code = 'whatsapp';
  static requiresUserCredential = false;

  constructor({ config = env, clientFactory } = {}) {
    super();
    this.config = config;
    this.clientFactory = clientFactory ?? (() =>
      twilio(this.config.TWILIO_ACCOUNT_SID, this.config.TWILIO_AUTH_TOKEN)
    );
  }

  async validate() {
    this.#assertConfigured();
    return true;
  }

  formatMessage(content, attachments = []) {
    if (attachments.length) {
      throw AppError.badRequest(
        'WhatsApp attachments are not supported by the Twilio Sandbox adapter. Select Meta to send attachments.',
        { code: 'TWILIO_WHATSAPP_ATTACHMENTS_UNSUPPORTED' }
      );
    }

    let formatted = content;
    if (typeof content === 'string' && content.startsWith(META_TEMPLATE_MARKER)) {
      try {
        const template = JSON.parse(
          Buffer.from(content.slice(META_TEMPLATE_MARKER.length), 'base64url').toString('utf8')
        );
        // The preview is what PingOne shows to the user after filling the Meta
        // template's variables. Strip its UI label before wrapping it in the
        // configured Twilio Content template.
        formatted = String(template.preview ?? template.name ?? '').replace(/^WhatsApp template:[^\n]*\n?/, '');
      } catch {
        throw AppError.badRequest('WhatsApp template data is invalid. Select the template again.', {
          code: 'INVALID_WHATSAPP_TEMPLATE',
        });
      }
    }

    if (typeof formatted !== 'string' || !formatted.trim()) {
      throw AppError.badRequest('Twilio WhatsApp requires non-empty message text.', {
        code: 'INVALID_WHATSAPP_MESSAGE',
      });
    }

    return { formatted, hasAttachments: false, attachments: [] };
  }

  async send(_credential, recipient, message) {
    this.#assertConfigured();

    const rawHandle = String(recipient?.handle ?? '');
    const e164 = rawHandle.startsWith('whatsapp:') ? rawHandle.slice('whatsapp:'.length) : rawHandle;
    if (!E164.test(e164)) {
      throw AppError.badRequest('WhatsApp recipient must be a phone number in E.164 format.', {
        code: 'INVALID_WHATSAPP_RECIPIENT',
      });
    }

    try {
      const result = await this.clientFactory().messages.create({
        from: this.config.TWILIO_WHATSAPP_FROM,
        to: `whatsapp:${e164}`,
        contentSid: this.config.TWILIO_WHATSAPP_CONTENT_SID,
        contentVariables: JSON.stringify({ '1': message.formatted }),
        statusCallback: twilioWhatsAppStatusCallbackUrl(this.config),
      });

      if (!result?.sid) {
        throw new Error('Twilio response did not include a Message SID');
      }

      return { platformMessageId: result.sid, raw: result };
    } catch (err) {
      const providerCode = err.code ? ` (${err.code})` : '';
      throw new AppError(502, `Twilio WhatsApp send failed${providerCode}: ${err.message}`, {
        code: 'TWILIO_WHATSAPP_SEND_FAILED',
        details: { providerCode: err.code ?? null, status: err.status ?? null },
      });
    }
  }

  #assertConfigured() {
    const missing = [
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_WHATSAPP_FROM',
      'TWILIO_WHATSAPP_CONTENT_SID',
    ].filter((key) => !this.config[key]);

    if (missing.length) {
      throw new AppError(503, 'Twilio WhatsApp is selected but its server configuration is incomplete.', {
        code: 'TWILIO_WHATSAPP_NOT_CONFIGURED',
        details: { missing },
      });
    }
  }
}
