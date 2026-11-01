// ============================================================
// Turns inbound platform callbacks into MessageDelivery status changes.
//
// Everything funnels through deliveries/delivery-status.service, which is
// monotonic and idempotent — that matters more here than anywhere else in the
// app, because:
//
//   * Meta retries a webhook for up to 7 days until it gets a 2xx, so the same
//     event WILL arrive multiple times.
//   * Status events arrive out of order. `read` before `delivered` is routine,
//     not an anomaly.
//
// Every handler returns a small summary of what it did rather than throwing on
// events it doesn't recognise. A webhook payload is not a request we control:
// unknown event types are normal (Meta adds fields), and a 500 would just make
// the platform retry something that will never succeed.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { transitionStatus } from '../deliveries/delivery-status.service.js';
import { lookupByCode } from '../../utils/lookupCache.js';
import { MESSAGE_STATUS, CHANGED_BY, PLATFORM } from '../../constants/codes.js';
import { extractStartPayload, parseStartPayload } from '../../utils/telegramLink.js';

/** Meta's status strings -> our message_statuses codes. */
const META_STATUS_MAP = {
  sent: MESSAGE_STATUS.SENT,
  delivered: MESSAGE_STATUS.DELIVERED,
  read: MESSAGE_STATUS.READ,
  failed: MESSAGE_STATUS.FAILED,
};

// ---- WhatsApp -------------------------------------------------------

/**
 * Process a Meta Cloud API webhook body.
 *
 * Shape (only the parts we care about):
 *   { entry: [{ changes: [{ value: { statuses: [
 *       { id, status, timestamp, recipient_id, errors?: [{ title, message }] }
 *   ] } }] }] }
 *
 * Inbound *messages* (as opposed to statuses) are ignored here — PingOne is a
 * one-way broadcast tool and has nowhere to put a reply. The 24h
 * customer-service window they'd open is noted in whatsapp.adapter.js.
 */
export async function handleWhatsAppEvent(body) {
  const summary = { processed: 0, ignored: 0, unmatched: 0 };

  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const statuses = change?.value?.statuses ?? [];
      const messages = change?.value?.messages ?? [];

      for (const status of statuses) {
        const result = await applyWhatsAppStatus(status);
        summary[result] += 1;
      }

      for (const message of messages) {
        const recorded = await recordWhatsAppReply(message);
        summary[recorded ? 'processed' : 'unmatched'] += 1;
      }

      if (statuses.length === 0 && messages.length === 0) summary.ignored += 1;
    }
  }

  return summary;
}

/** Store reply signals without retaining the inbound message content. */
async function recordWhatsAppReply(message) {
  if (!message?.from) return false;
  const whatsapp = await lookupByCode('platform', PLATFORM.WHATSAPP);
  // Meta supplies `from` as digits without the E.164 `+`; contacts store E.164.
  const rawHandle = String(message.from);
  const phoneCandidates = rawHandle.startsWith('+') ? [rawHandle] : [rawHandle, `+${rawHandle}`];
  const contacts = await prisma.contact.findMany({
    where: {
      deletedAt: null,
      OR: [
        { platformHandles: { some: { platformId: whatsapp.id, handle: rawHandle } } },
        { phones: { some: { phone: { in: phoneCandidates } } } },
      ],
    },
    select: { id: true },
  });
  if (!contacts.length) return false;

  await prisma.contactReply.createMany({
    data: contacts.map((contact) => ({
      contactId: contact.id,
      platformId: whatsapp.id,
      repliedAt: parseUnixSeconds(message.timestamp),
    })),
  });
  return true;
}

async function applyWhatsAppStatus(status) {
  const toCode = META_STATUS_MAP[status.status];
  if (!toCode) return 'ignored';

  const delivery = await findDeliveryByPlatformMessageId(PLATFORM.WHATSAPP, status.id);
  if (!delivery) {
    // Normal in a shared dev environment: the message was sent by a different
    // PingOne instance pointed at the same Meta app.
    console.warn(`[webhook:whatsapp] no delivery found for message id ${status.id}`);
    return 'unmatched';
  }

  const result = await transitionStatus({
    deliveryId: delivery.id,
    toCode,
    changedBy: CHANGED_BY.WEBHOOK,
    occurredAt: parseUnixSeconds(status.timestamp),
    errorReason: toCode === MESSAGE_STATUS.FAILED ? describeMetaErrors(status.errors) : undefined,
  });

  return result.changed ? 'processed' : 'ignored';
}

function describeMetaErrors(errors) {
  if (!errors?.length) return 'WhatsApp reported the message as failed';
  return errors.map((e) => `${e.title ?? e.code ?? 'error'}: ${e.message ?? e.details ?? ''}`.trim()).join('; ');
}

// ---- Telegram -------------------------------------------------------

/**
 * Process a Telegram Bot API update.
 *
 * A caveat worth being explicit about: the Bot API has no delivery receipts.
 * There is no event for "your message reached the user" — Telegram simply
 * doesn't expose it. So there are only two things this can honestly do:
 *
 *   1. A message from the chat proves the user opened it. We treat that as a
 *      read receipt for the most recent unconfirmed delivery to that chat.
 *      It's an inference, but a sound one, and it's the only read signal the
 *      platform gives.
 *
 *   2. `my_chat_member` transitioning to kicked/left means the user blocked the
 *      bot. We log it and leave existing statuses alone — sends before the
 *      block may well have been delivered, and rewriting them as failed would
 *      be inventing information. Subsequent sends fail at the API and get
 *      recorded through the normal delivery path.
 */
export async function handleTelegramEvent(update) {
  const message = update?.message ?? update?.edited_message;

  if (message?.chat?.id) {
    const chatId = String(message.chat.id);

    // This is the ONLY moment Telegram ever reveals a private chat's id, so
    // the binding is attempted before anything else — including for a bare
    // "/start", which carries no engagement meaning of its own.
    const linked = await linkTelegramChat(chatId, message);

    const engagement = await handleTelegramEngagement(chatId, message.date);

    // A link is real work even when there was no delivery to mark as read.
    if (linked) {
      return { ...engagement, processed: engagement.processed + 1, unmatched: 0 };
    }
    return engagement;
  }

  const membership = update?.my_chat_member;
  if (membership) {
    const state = membership.new_chat_member?.status;
    if (state === 'kicked' || state === 'left') {
      console.warn(
        `[webhook:telegram] chat ${membership.chat?.id} blocked the bot — future sends to it will fail`
      );
    }
    return { processed: 0, ignored: 1, unmatched: 0 };
  }

  // callback_query, poll updates, channel posts, ... nothing actionable.
  return { processed: 0, ignored: 1, unmatched: 0 };
}

/**
 * Bind an incoming chat id to the contact it belongs to.
 *
 * Telegram gives no way to resolve an @username to a chat_id, so this is the
 * only opportunity to learn one — see `utils/telegramLink.js`. Two routes in,
 * with deliberately different trust levels:
 *
 *   1. `/start c73_9f2ab41c0d` — a signed deep link the account owner sent to
 *      this contact. The HMAC proves the binding was intended, so it may
 *      REPLACE an existing id (the contact moved to a new Telegram account).
 *
 *   2. `from.username` matching a handle the owner typed — convenient, but
 *      only as trustworthy as a username being unique, so it may only FILL an
 *      empty id, never overwrite one. Otherwise anyone who set their username
 *      to match could redirect somebody else's messages to themselves.
 *
 * @returns {Promise<boolean>} whether a row was actually linked
 */
async function linkTelegramChat(chatId, message) {
  const telegram = await lookupByCode('platform', PLATFORM.TELEGRAM);

  // Already known — the overwhelmingly common case, one indexed lookup.
  const existing = await prisma.contactPlatformHandle.findFirst({
    where: { platformId: telegram.id, chatId },
    select: { id: true },
  });
  if (existing) return false;

  // ---- 1. signed deep link ----
  const payload = extractStartPayload(message?.text);
  const contactId = payload ? parseStartPayload(payload) : null;

  if (contactId) {
    // upsert: the contact may have no Telegram handle row yet if the owner
    // sent the invite before typing a username.
    const linkedRow = await prisma.contactPlatformHandle.upsert({
      where: { contactId_platformId: { contactId, platformId: telegram.id } },
      update: { chatId, linkedAt: new Date() },
      create: {
        contactId,
        platformId: telegram.id,
        // Fall back to the @username as the display handle; the owner can
        // rename it afterwards.
        handle: message?.from?.username ? `@${message.from.username}` : chatId,
        chatId,
        linkedAt: new Date(),
      },
      select: { contactId: true },
    // A forged-looking payload naming a contact that no longer exists is not
    // an error worth retrying — the FK just fails.
    }).catch((err) => {
      console.warn(`[webhook:telegram] could not link contact ${contactId}: ${err.message}`);
      return null;
    });

    if (linkedRow) {
      console.log(`[webhook:telegram] linked chat ${chatId} to contact ${contactId} via invite`);
      return true;
    }
  }

  // ---- 2. username fallback ----
  const username = message?.from?.username;
  if (!username) return false;

  const { count } = await prisma.contactPlatformHandle.updateMany({
    where: {
      platformId: telegram.id,
      // Fill only. Never take an id away from a contact already linked.
      chatId: null,
      handle: { in: [`@${username}`, username], mode: 'insensitive' },
    },
    data: { chatId, linkedAt: new Date() },
  });

  if (count > 0) {
    console.log(
      `[webhook:telegram] linked chat ${chatId} to ${count} contact(s) via @${username}`
    );
  }
  return count > 0;
}

async function handleTelegramEngagement(chatId, timestamp) {
  const telegram = await lookupByCode('platform', PLATFORM.TELEGRAM);

  // chat_id -> contact. Matched on `chatId`, not `handle`: `handle` is the
  // readable @username the owner typed, which Telegram never sends back.
  // More than one contact can legitimately carry the same chat across
  // different users' address books, so this is a findMany.
  const handles = await prisma.contactPlatformHandle.findMany({
    where: { platformId: telegram.id, chatId },
    select: { contactId: true },
  });

  if (handles.length === 0) {
    // Someone messaged the bot who isn't in anyone's address book, or whose
    // invite payload didn't resolve. Nothing to attribute the message to.
    console.warn(`[webhook:telegram] no contact is linked to chat ${chatId}`);
    return { processed: 0, ignored: 0, unmatched: 1 };
  }

  await prisma.contactReply.createMany({
    data: handles.map(({ contactId }) => ({
      contactId,
      platformId: telegram.id,
      repliedAt: parseUnixSeconds(timestamp),
    })),
  });

  // Most recent send only. An older message being read is unknowable, and
  // marking every past delivery as read on one reply would be plainly wrong.
  const delivery = await prisma.messageDelivery.findFirst({
    where: {
      platformId: telegram.id,
      contactId: { in: handles.map((h) => h.contactId) },
      sentAt: { not: null },
    },
    orderBy: { sentAt: 'desc' },
  });

  if (!delivery) return { processed: 0, ignored: 0, unmatched: 1 };

  const result = await transitionStatus({
    deliveryId: delivery.id,
    toCode: MESSAGE_STATUS.READ,
    changedBy: CHANGED_BY.WEBHOOK,
  });

  return { processed: result.changed ? 1 : 0, ignored: result.changed ? 0 : 1, unmatched: 0 };
}

// ---- shared ---------------------------------------------------------

async function findDeliveryByPlatformMessageId(platformCode, platformMessageId) {
  if (!platformMessageId) return null;

  const platform = await lookupByCode('platform', platformCode);
  return prisma.messageDelivery.findFirst({
    where: { platformId: platform.id, platformMessageId },
    orderBy: { id: 'desc' }, // newest wins if a platform id was somehow reused
  });
}

/** Meta sends unix seconds as a string. Bad values fall back to "now". */
function parseUnixSeconds(timestamp) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();
  return new Date(seconds * 1000);
}
