// ============================================================
// Telegram adapter — Bot API, plain fetch, no SDK needed.
//
// IMPORTANT LIMITATION (tell your team / mention in the report):
// A bot can only message a chat that has messaged the bot first
// (Telegram doesn't allow cold-outreach), and the Bot API addresses a
// private user ONLY by numeric chat_id — an @username is rejected with
// "Bad Request: chat not found", and there is no API to resolve one.
//
// This is handled: the contact opens a signed invite link
// (utils/telegramLink.js), presses Start, and webhooks.service.js captures
// their chat_id onto contact_platform_handles.chat_id. The resolver sends
// that, while `handle` stays the readable @username the user typed.
// A contact who hasn't started the bot fails early with
// TELEGRAM_NOT_LINKED rather than reaching this adapter.
//
// Attachments are POSTed as multipart with the raw bytes, not as a URL, so
// they work in local development where PUBLIC_BASE_URL isn't reachable from
// Telegram's servers.
// ============================================================

import { BaseAdapter } from './base.adapter.js';
import { AppError } from '../utils/AppError.js';

const API_BASE = 'https://api.telegram.org';

/**
 * Which Bot API method handles each file type, and the form field it expects.
 * Anything unrecognised goes out as a document, which accepts any file.
 */
const UPLOAD_METHODS = {
  image: { method: 'sendPhoto', field: 'photo' },
  video: { method: 'sendVideo', field: 'video' },
  audio: { method: 'sendAudio', field: 'audio' },
};
const DOCUMENT_UPLOAD = { method: 'sendDocument', field: 'document' };

// Telegram caps captions at 1024 chars, well below the 4096 for plain text.
const CAPTION_LIMIT = 1024;

export class TelegramBotAdapter extends BaseAdapter {
  static code = 'telegram';

  /**
   * Guard the one thing the Bot API can't do.
   *
   * `handle` reaches here as whatever the resolver had: a captured numeric
   * chat_id, or the @username the user typed. Only the former works, and
   * Telegram's own answer for the latter is "Bad Request: chat not found",
   * which tells nobody what to do about it. Catch it here instead.
   */
  #assertSendable(handle) {
    if (/^-?\d+$/.test(String(handle ?? ''))) return;

    throw AppError.badRequest(
      'This contact hasn\'t linked Telegram yet. Send them the invite link from ' +
        'their contact so they can start the bot — the Bot API only allows ' +
        'messaging people who have messaged the bot first. (Connecting Telegram ' +
        'as a user account instead removes this restriction.)',
      { code: 'TELEGRAM_NOT_LINKED' }
    );
  }

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
    return { formatted: content, hasAttachments: attachments.length > 0, attachments };
  }

  async send({ secret: botToken }, recipient, message) {
    this.#assertSendable(recipient.handle);

    const attachments = message.attachments ?? [];

    // One attachment and a short body: send it as a single captioned upload
    // instead of two notifications on the recipient's phone.
    if (attachments.length === 1 && message.formatted.length <= CAPTION_LIMIT) {
      const result = await this.#upload(botToken, recipient.handle, attachments[0], message.formatted);
      return { platformMessageId: String(result.message_id), raw: result };
    }

    const textResult = await this.#sendText(botToken, recipient.handle, message.formatted);

    // Files follow as separate messages. Sequential rather than parallel:
    // Telegram rate-limits per chat, and it keeps them in the order the user
    // attached them.
    for (const attachment of attachments) {
      await this.#upload(botToken, recipient.handle, attachment);
    }

    // The text message is the one we track — its id is what a webhook update
    // would reference.
    return { platformMessageId: String(textResult.message_id), raw: textResult };
  }

  async #sendText(botToken, chatId, text) {
    return this.#call(botToken, 'sendMessage', {
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async #upload(botToken, chatId, attachment, caption) {
    const { method, field } = UPLOAD_METHODS[attachment.typeCode] ?? DOCUMENT_UPLOAD;

    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append(
      field,
      new Blob([attachment.buffer], { type: attachment.mimeType }),
      attachment.fileName
    );
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }

    // No Content-Type header — fetch sets the multipart boundary itself.
    return this.#call(botToken, method, { body: form });
  }

  async #call(botToken, method, init) {
    const res = await fetch(`${API_BASE}/bot${botToken}/${method}`, { method: 'POST', ...init });
    const data = await res.json();

    if (!data.ok) {
      throw AppError.badRequest(`Telegram ${method} failed: ${data.description}`, {
        code: 'TELEGRAM_SEND_FAILED',
        details: data,
      });
    }
    return data.result;
  }
}
