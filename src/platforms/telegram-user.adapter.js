// ============================================================
// Telegram adapter — MTProto (real user account).
//
// The counterpart to telegram-bot.adapter.js. Same BaseAdapter interface,
// completely different rules:
//
//   Bot API      can only message someone who messaged the bot first, and
//                addresses them only by numeric chat_id.
//   Client API   messages anyone it can resolve, INCLUDING by @username.
//                No invite link, no chat_id capture, no webhook needed.
//
// That's the whole reason this exists — but see the ToS warning in
// providers/telegram-user.provider.js before pointing a broadcast tool at it.
// PEER_FLOOD is Telegram telling you the account is about to be limited.
//
// Connection model: one client per send, connected and torn down around the
// call. A pool keyed by user would cut the ~1s handshake, but a long-lived
// MTProto connection per user is real state to own (reconnects, DC
// migration, session invalidation), and the worker already runs sends
// through a queue where a second of setup is not the bottleneck. Revisit if
// throughput ever demands it.
// ============================================================

import { CustomFile } from 'teleproto/client/uploads.js';
import { BaseAdapter } from './base.adapter.js';
import { AppError } from '../utils/AppError.js';
import { createClient, toAppError } from '../modules/platforms/providers/telegram-user.provider.js';

/** Telegram rejects a text message over 4096 characters outright. */
const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

export class TelegramUserAdapter extends BaseAdapter {
  static code = 'telegram';

  /**
   * Confirm the stored session still authenticates.
   *
   * A session dies when the account signs that device out from Telegram's
   * "Active Sessions" screen, which the user can do at any time and won't
   * tell us about — so this is checked before sending, not just at connect.
   */
  async validate({ secret: session }) {
    const client = createClient(session);

    try {
      await client.connect();

      if (!(await client.checkAuthorization())) {
        throw AppError.badRequest(
          'This Telegram session was signed out. Reconnect the account.',
          { code: 'TELEGRAM_SESSION_REVOKED' }
        );
      }
      return true;
    } catch (error) {
      throw toAppError(error, 'Could not verify the Telegram session.');
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  formatMessage(content, attachments = []) {
    return { formatted: content, hasAttachments: attachments.length > 0, attachments };
  }

  /**
   * `recipient.handle` may be an @username, a phone number, or a numeric id —
   * MTProto resolves all three, which is exactly the flexibility the Bot API
   * lacks. Resolution is one round trip and is what turns "@aarav" into a
   * peer we can send to.
   */
  async send({ secret: session }, recipient, message) {
    const client = createClient(session);

    try {
      await client.connect();

      const peer = await this.#resolve(client, recipient.handle);
      const attachments = message.attachments ?? [];
      const text = String(message.formatted ?? '');

      if (text.length > TEXT_LIMIT && attachments.length === 0) {
        throw AppError.badRequest(
          `Telegram messages are limited to ${TEXT_LIMIT} characters.`,
          { code: 'TELEGRAM_MESSAGE_TOO_LONG' }
        );
      }

      // One attachment with a short body goes as a single captioned upload,
      // matching the bot adapter's behaviour so the recipient's experience
      // doesn't depend on which mode the sender happens to use.
      if (attachments.length === 1 && text.length <= CAPTION_LIMIT) {
        const sent = await client.sendFile(peer, {
          file: this.#toFile(attachments[0]),
          caption: text || undefined,
          forceDocument: attachments[0].typeCode === 'document',
        });
        return { platformMessageId: String(sent.id), raw: { id: sent.id } };
      }

      const sent = await client.sendMessage(peer, { message: text });

      // Files follow as separate messages, sequentially — Telegram rate-limits
      // per chat and this keeps them in the order they were attached.
      for (const attachment of attachments) {
        await client.sendFile(peer, {
          file: this.#toFile(attachment),
          forceDocument: attachment.typeCode === 'document',
        });
      }

      return { platformMessageId: String(sent.id), raw: { id: sent.id } };
    } catch (error) {
      throw this.#sendError(error, recipient.handle);
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  /**
   * Wrap a Buffer so the upload keeps its original filename.
   *
   * A bare Buffer uploads as "unnamed", which is a poor experience for a
   * document. `CustomFile` is teleproto's carrier for name + size + bytes.
   */
  #toFile(attachment) {
    return new CustomFile(
      attachment.fileName ?? 'attachment',
      attachment.fileSizeBytes ?? attachment.buffer.length,
      '',
      attachment.buffer
    );
  }

  async #resolve(client, handle) {
    try {
      return await client.getEntity(handle);
    } catch (error) {
      // A username that simply doesn't exist is a data problem the user can
      // fix on the contact, so it gets its own code rather than a raw RPC one.
      if (/USERNAME_INVALID|USERNAME_NOT_OCCUPIED|Cannot find any entity/i.test(
        error?.errorMessage ?? error?.message ?? ''
      )) {
        throw AppError.badRequest(
          `Telegram has no account matching "${handle}". Check the username on this contact.`,
          { code: 'TELEGRAM_USERNAME_NOT_FOUND' }
        );
      }
      throw error;
    }
  }

  /**
   * Translate the send-time failures that mean something specific.
   *
   * PEER_FLOOD is the important one: it is Telegram's anti-spam system saying
   * this account has messaged too many strangers. Continuing through it is
   * how accounts get permanently banned, so the message says so.
   */
  #sendError(error, handle) {
    if (error instanceof AppError) return error;

    const code = error?.errorMessage ?? '';

    if (code === 'PEER_FLOOD') {
      return AppError.badRequest(
        'Telegram has flagged this account for spam and is blocking new messages ' +
          'to people who haven\'t contacted it. Stop sending from this account — ' +
          'continuing risks a permanent ban.',
        { code: 'TELEGRAM_PEER_FLOOD' }
      );
    }

    if (code === 'USER_IS_BLOCKED' || code === 'USER_PRIVACY_RESTRICTED') {
      return AppError.badRequest(
        `${handle} has blocked this account or doesn't accept messages from ` +
          'people they haven\'t added.',
        { code: 'TELEGRAM_RECIPIENT_UNREACHABLE' }
      );
    }

    if (code === 'AUTH_KEY_UNREGISTERED' || code === 'SESSION_REVOKED') {
      return AppError.badRequest(
        'This Telegram session was signed out. Reconnect the account.',
        { code: 'TELEGRAM_SESSION_REVOKED' }
      );
    }

    return toAppError(error, 'Telegram rejected the message.');
  }
}
