// ============================================================
// Telegram adapter — dispatcher.
//
// Telegram is the one platform PingOne can talk to two different ways, and
// which one applies is a property of the CREDENTIAL, not of the code:
//
//   extraInfo.mode === 'user'  -> MTProto, the real account (Client API)
//   anything else              -> Bot API  (the default, and the ToS-safe one)
//
// The worker only ever calls getAdapter('telegram'), so the choice is made
// here rather than leaking into adapter.registry.js, the worker or the
// resolver. Credentials connected before user mode existed have no `mode`
// key at all, which is exactly why the default is bot.
// ============================================================

import { BaseAdapter } from './base.adapter.js';
import { TelegramBotAdapter } from './telegram-bot.adapter.js';
import { TelegramUserAdapter } from './telegram-user.adapter.js';

export const TELEGRAM_MODES = { BOT: 'bot', USER: 'user' };

/** Which implementation a stored credential asks for. */
export function telegramModeOf(credential) {
  return credential?.extraInfo?.mode === TELEGRAM_MODES.USER
    ? TELEGRAM_MODES.USER
    : TELEGRAM_MODES.BOT;
}

export class TelegramAdapter extends BaseAdapter {
  static code = 'telegram';

  #bot = new TelegramBotAdapter();
  #user = new TelegramUserAdapter();

  /** The implementation this credential belongs to. */
  #for(credential) {
    return telegramModeOf(credential) === TELEGRAM_MODES.USER ? this.#user : this.#bot;
  }

  async validate(credential) {
    return this.#for(credential).validate(credential);
  }

  /**
   * Formatting is mode-independent today — both send the body as-is — but it
   * still routes through the same switch so the two can diverge (e.g. the Bot
   * API's HTML parse_mode) without touching the worker.
   */
  formatMessage(content, attachments = []) {
    return this.#bot.formatMessage(content, attachments);
  }

  async send(credential, recipient, message) {
    return this.#for(credential).send(credential, recipient, message);
  }
}
