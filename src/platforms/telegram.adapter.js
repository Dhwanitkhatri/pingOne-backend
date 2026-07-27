// ============================================================
// Telegram adapter — Bot API, plain fetch, no SDK needed.
//
// IMPORTANT LIMITATION (tell your team / mention in the report):
// A bot can only message a chat that has messaged the bot first
// (Telegram doesn't allow cold-outreach). `recipient.handle` must be
// the numeric chat_id captured after the contact starts the bot, not
// just a @username. Document this in your Contact Import flow.
// ============================================================

import { BaseAdapter } from './base.adapter.js';
import { AppError } from '../utils/AppError.js';

const API_BASE = 'https://api.telegram.org';

export class TelegramAdapter extends BaseAdapter {
  static code = 'telegram';

  async validate({ secret: botToken }) {
    const res = await fetch(`${API_BASE}/bot${botToken}/getMe`);
    const data = await res.json();
    if (!data.ok) {
      throw AppError.badRequest('Telegram bot token could not be verified', {
        code: 'INVALID_TELEGRAM_TOKEN',
        details: data.description,
      });
    }
    return true;
  }

  formatMessage(content, attachments = []) {
    // Telegram supports basic HTML formatting in sendMessage.
    // Attachments (if any) are sent as a separate sendPhoto/sendDocument
    // call by the worker — formatMessage only prepares the text part.
    return { formatted: content, hasAttachments: attachments.length > 0, attachments };
  }

  async send({ secret: botToken }, recipient, message) {
    const res = await fetch(`${API_BASE}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: recipient.handle,
        text: message.formatted,
        parse_mode: 'HTML',
      }),
    });
    const data = await res.json();

    if (!data.ok) {
      throw AppError.badRequest(`Telegram send failed: ${data.description}`, {
        code: 'TELEGRAM_SEND_FAILED',
      });
    }

    return { platformMessageId: String(data.result.message_id), raw: data.result };
  }
}
