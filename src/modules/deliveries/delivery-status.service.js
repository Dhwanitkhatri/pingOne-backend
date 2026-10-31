// ============================================================
// The single place a MessageDelivery's status changes.
//
// Every transition does two things atomically: update the delivery row and
// append a DeliveryStatusLog entry describing the move. Both the delivery
// worker (outbound sends) and the webhook handlers (platform callbacks) go
// through here, so the audit trail in delivery_status_logs is complete no
// matter what caused the change.
//
// Two rules that matter, and why:
//
//   Monotonic. Platform callbacks arrive out of order — Meta will hand you
//   `read` before `delivered` often enough that it can't be treated as an
//   edge case. Transitions compare STATUS_RANK and no-op on anything that
//   would move backwards, so a late `delivered` can't un-read a message.
//
//   Idempotent. Webhooks are retried aggressively (Meta retries for days on
//   a non-2xx). Re-delivering the same event is a no-op, not a duplicate log
//   row, because the same-rank case is rejected too.
//
// `force` exists for the one case that legitimately moves backwards: a retry
// re-attempting a delivery that already failed.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { lookupByCode } from '../../utils/lookupCache.js';
import { MESSAGE_STATUS, STATUS_RANK, CHANGED_BY } from '../../constants/codes.js';

/**
 * @param {object} params
 * @param {number} params.deliveryId
 * @param {string} params.toCode        a MESSAGE_STATUS value
 * @param {string} [params.changedBy]   a CHANGED_BY value — ends up in the log
 * @param {string|null} [params.errorReason]
 * @param {Date} [params.occurredAt]    when the platform says it happened;
 *                                      defaults to now. Used for sent/delivered/read timestamps.
 * @param {boolean} [params.force]      allow a backwards transition (retries)
 * @param {object} [params.data]        extra MessageDelivery fields to write in the same update
 * @returns {Promise<{changed: boolean, reason?: string, delivery?: object}>}
 */
export async function transitionStatus({
  deliveryId,
  toCode,
  changedBy = CHANGED_BY.SYSTEM,
  errorReason,
  occurredAt,
  force = false,
  data = {},
}, { db = prisma, lookup = lookupByCode } = {}) {
  const target = await lookup('messageStatus', toCode);
  const when = occurredAt ?? new Date();

  return db.$transaction(async (tx) => {
    const current = await tx.messageDelivery.findUnique({
      where: { id: deliveryId },
      include: { status: true },
    });

    if (!current) return { changed: false, reason: 'DELIVERY_NOT_FOUND' };

    if (!force && !isForwardTransition(current.status.code, toCode)) {
      return { changed: false, reason: 'NOT_A_FORWARD_TRANSITION', delivery: current };
    }

    const delivery = await tx.messageDelivery.update({
      where: { id: deliveryId },
      data: {
        statusId: target.id,
        ...timestampsFor(toCode, when, current),
        ...(errorReason !== undefined && { errorReason }),
        ...data,
      },
    });

    await tx.deliveryStatusLog.create({
      data: {
        deliveryId,
        oldStatusId: current.statusId,
        newStatusId: target.id,
        changedBy,
      },
    });

    return { changed: true, delivery };
  });
}

/** True if `toCode` is strictly further along the lifecycle than `fromCode`. */
export function isForwardTransition(fromCode, toCode) {
  const from = STATUS_RANK[fromCode];
  const to = STATUS_RANK[toCode];

  // Unknown code (someone seeded an extra status) — allow it rather than
  // silently dropping a real platform event.
  if (from === undefined || to === undefined) return true;

  return to > from;
}

/**
 * Fills in the lifecycle timestamp columns that correspond to a status.
 *
 * A `read` event backfills deliveredAt when it's still null: a message that was
 * read was necessarily delivered, and Telegram/Meta don't always send both.
 * Without this, delivery-rate analytics would undercount.
 */
function timestampsFor(toCode, when, current) {
  switch (toCode) {
    case MESSAGE_STATUS.SENT:
      return current.sentAt ? {} : { sentAt: when };

    case MESSAGE_STATUS.DELIVERED:
      return { deliveredAt: when, ...(current.sentAt ? {} : { sentAt: when }) };

    case MESSAGE_STATUS.READ:
      return {
        readAt: when,
        ...(current.deliveredAt ? {} : { deliveredAt: when }),
        ...(current.sentAt ? {} : { sentAt: when }),
      };

    default:
      return {};
  }
}
