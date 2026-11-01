// ============================================================
// Read receipts for messages sent from a Telegram USER account (MTProto).
//
// A bot never learns whether its message was read, but a real account does —
// it's the double tick in the app. Telegram keeps, per private chat, the id of
// the newest outgoing message the other side has read (`read_outbox_max_id`).
// Message ids in a private chat only ever increase, so every message we sent
// with an id at or below that number has been read.
//
// The user adapter connects only for the moment of a send (see
// telegram-user.adapter.js), so nothing is listening when the tick turns blue.
// Instead this polls: every few minutes, for each account with recent
// unconfirmed sends, one connection asks Telegram how far each chat has been
// read and marks those deliveries Read.
//
// Called from the scheduler worker's tick (see scheduler.worker.js).
// ============================================================

import { Api } from 'teleproto';
import { prisma } from '../../config/prisma.js';
import { isTelegramUserConfigured } from '../../config/env.js';
import { lookupByCode } from '../../utils/lookupCache.js';
import { MESSAGE_STATUS, CHANGED_BY, PLATFORM } from '../../constants/codes.js';
import { transitionStatus } from './delivery-status.service.js';
import { resolveRecipientHandle } from '../scheduler/recipient-resolver.js';
import { getDecryptedCredential } from '../platforms/platforms.service.js';
import { createClient } from '../platforms/providers/telegram-user.provider.js';
import { telegramModeOf, TELEGRAM_MODES } from '../../platforms/telegram.adapter.js';

/** Older than this and a message is assumed read or never going to be. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounds one run: each chat is a lookup, and Telegram rate-limits those. */
const MAX_DELIVERIES = 500;
const MAX_CHATS_PER_ACCOUNT = 30;

/**
 * Mark Telegram user-account deliveries Read where the recipient has read them.
 * @returns {Promise<{ checked: number, read: number }>}
 */
export async function syncTelegramReadReceipts(now = new Date()) {
  const summary = { checked: 0, read: 0 };
  if (!isTelegramUserConfigured) return summary;

  const telegram = await lookupByCode('platform', PLATFORM.TELEGRAM);
  const unconfirmed = await Promise.all(
    [MESSAGE_STATUS.SENT, MESSAGE_STATUS.DELIVERED].map((code) => lookupByCode('messageStatus', code))
  );

  const deliveries = await prisma.messageDelivery.findMany({
    where: {
      platformId: telegram.id,
      statusId: { in: unconfirmed.map((status) => status.id) },
      platformMessageId: { not: null },
      sentAt: { gte: new Date(now - LOOKBACK_MS) },
    },
    select: { id: true, contactId: true, platformMessageId: true, job: { select: { userId: true } } },
    orderBy: { sentAt: 'desc' },
    take: MAX_DELIVERIES,
  });
  if (!deliveries.length) return summary;

  // account -> contact -> that contact's unconfirmed deliveries
  const byUser = new Map();
  for (const delivery of deliveries) {
    const contacts = byUser.get(delivery.job.userId) ?? new Map();
    contacts.set(delivery.contactId, [...(contacts.get(delivery.contactId) ?? []), delivery]);
    byUser.set(delivery.job.userId, contacts);
  }

  for (const [userId, contacts] of byUser) {
    const result = await syncAccount(userId, telegram.id, contacts).catch((err) => {
      // One account's dead session or flood wait mustn't stop the others.
      console.warn(`[telegram-read] skipped user ${userId}: ${err.errorMessage ?? err.message}`);
      return { checked: 0, read: 0 };
    });
    summary.checked += result.checked;
    summary.read += result.read;
  }

  if (summary.read) console.log(`[telegram-read] marked ${summary.read} of ${summary.checked} delivery(ies) read`);
  return summary;
}

async function syncAccount(userId, platformId, contacts) {
  const summary = { checked: 0, read: 0 };

  const credential = await getDecryptedCredential(userId, PLATFORM.TELEGRAM).catch(() => null);
  // Bot-mode sends have no read state to ask for — replies are their only signal.
  if (!credential || telegramModeOf(credential) !== TELEGRAM_MODES.USER) return summary;

  const client = createClient(credential.secret);
  try {
    await client.connect();

    for (const [contactId, contactDeliveries] of [...contacts].slice(0, MAX_CHATS_PER_ACCOUNT)) {
      const readUpTo = await readOutboxMaxId(client, contactId, platformId);
      if (readUpTo === null) continue;

      for (const delivery of contactDeliveries) {
        summary.checked += 1;
        if (Number(delivery.platformMessageId) > readUpTo) continue;

        const { changed } = await transitionStatus({
          deliveryId: delivery.id,
          toCode: MESSAGE_STATUS.READ,
          changedBy: CHANGED_BY.SYSTEM,
        });
        if (changed) summary.read += 1;
      }
    }
  } finally {
    await client.disconnect().catch(() => {});
  }
  return summary;
}

/** How far the contact has read our side of the chat, or null if we can't tell. */
async function readOutboxMaxId(client, contactId, platformId) {
  let handle;
  try {
    handle = await resolveRecipientHandle(contactId, platformId, PLATFORM.TELEGRAM);
  } catch {
    return null; // the contact lost its Telegram handle since the send
  }

  try {
    const peer = await client.getInputEntity(handle);
    const result = await client.invoke(
      new Api.messages.GetPeerDialogs({ peers: [new Api.InputDialogPeer({ peer })] })
    );
    const readUpTo = result.dialogs?.[0]?.readOutboxMaxId;
    return typeof readUpTo === 'number' ? readUpTo : null;
  } catch (err) {
    // A flood wait means stop asking this account for now, not skip one chat.
    if (/FLOOD/i.test(err.errorMessage ?? err.message ?? '')) throw err;
    return null;
  }
}
