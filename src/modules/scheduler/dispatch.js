// ============================================================
// Firing a ScheduledJob — expanding its recipients into
// MessageDelivery rows and queueing one delivery per row.
//
// This used to live inside scheduler.worker.js. It moved here because
// there are now two callers: the worker's poll (a job whose time has
// come) and POST /messages/send (a job the user wants fired *now*,
// without waiting up to a minute for the next tick). Both must produce
// identical rows, so there is exactly one copy of the logic.
//
// Flow: ScheduledJob -> MessageDelivery rows -> Bull delivery queue
// ============================================================

import { prisma } from '../../config/prisma.js';
import { computeNextRunAfter } from './recurrence.js';

/**
 * Everything fireJob() needs loaded on the job it is handed. Both callers
 * use this so neither can pass a partially-loaded job.
 */
export const FIRE_JOB_INCLUDE = Object.freeze({
  recipients: { include: { group: { include: { members: true } } } },
  recurrenceRule: { include: { recurrenceType: true } },
});

/**
 * Expand, enqueue, and advance the job's schedule.
 *
 * @param {object} job  loaded with FIRE_JOB_INCLUDE
 * @param {number} pendingStatusId
 * @param {number} sentStatusId
 * @returns {Promise<{ deliveries: number, skippedRepliers: number,
 *                     occurrence: number, nextRunAt: Date | null }>}
 */
export async function fireJob(
  job,
  pendingStatusId,
  sentStatusId,
  { db = prisma, enqueueDelivery: enqueue = null, computeNext = computeNextRunAfter } = {}
) {
  const recipientPairs = await expandRecipients(job.recipients);
  const contactPlatformPairs = await excludeRepliedRecipients(job, recipientPairs, db);

  const deliveries = await db.$transaction(
    contactPlatformPairs.map(({ contactId, platformId }) =>
      db.messageDelivery.create({
        data: { jobId: job.id, contactId, platformId, statusId: pendingStatusId },
      })
    )
  );

  const enqueueDelivery = enqueue ?? (await import('../../queue/queue.service.js')).enqueueDelivery;
  for (const delivery of deliveries) {
    await enqueueDelivery(delivery.id);
  }

  // This firing counts toward RecurrenceRule.maxOccurrences.
  const occurrenceCount = job.occurrenceCount + 1;

  // computeNextRunAfter walks past any runs missed while the worker was down
  // instead of firing them all in a burst. Skipped runs still count against
  // maxOccurrences, so a "10 sends" rule never exceeds 10.
  const { nextRunAt, skipped } = computeNext(
    job.nextRunAt ?? job.scheduledAt,
    job.recurrenceRule,
    occurrenceCount
  );

  await db.scheduledJob.update({
    where: { id: job.id },
    data: {
      occurrenceCount: occurrenceCount + skipped,
      ...(nextRunAt
        ? { nextRunAt } // still recurring — leave status pending for the next tick
        : { nextRunAt: null, statusId: sentStatusId }), // one-time (or series ended) — mark dispatched
    },
  });

  const skippedRepliers = recipientPairs.length - contactPlatformPairs.length;

  console.log(
    `[dispatch] fired job ${job.id} -> ${deliveries.length} delivery(ies), ` +
      `occurrence ${occurrenceCount}, next run: ${nextRunAt?.toISOString() ?? 'none'}` +
      (skipped > 0 ? ` (skipped ${skipped} missed run(s))` : '') +
      (skippedRepliers > 0
        ? `; smart-send skipped ${skippedRepliers} replied recipient(s)`
        : '')
  );

  return {
    deliveries: deliveries.length,
    skippedRepliers,
    occurrence: occurrenceCount,
    nextRunAt: nextRunAt ?? null,
  };
}

/** A reply after schedule creation opts a contact out of later sends on that channel. */
async function excludeRepliedRecipients(job, pairs, db = prisma) {
  if (!job.skipIfReplied || pairs.length === 0) return pairs;

  const replies = await db.contactReply.findMany({
    where: {
      repliedAt: { gt: job.createdAt },
      OR: pairs.map(({ contactId, platformId }) => ({ contactId, platformId })),
    },
    select: { contactId: true, platformId: true },
    distinct: ['contactId', 'platformId'],
  });
  const replied = new Set(replies.map((reply) => `${reply.contactId}:${reply.platformId}`));
  return pairs.filter((pair) => !replied.has(`${pair.contactId}:${pair.platformId}`));
}

/** Individual JobRecipient rows -> flat list of unique (contactId, platformId) pairs. */
async function expandRecipients(recipients) {
  const pairs = new Map(); // `${contactId}:${platformId}` -> { contactId, platformId }

  for (const recipient of recipients) {
    if (recipient.contactId) {
      addPair(pairs, recipient.contactId, recipient.platformId);
    }
    if (recipient.groupId && recipient.group) {
      for (const member of recipient.group.members) {
        addPair(pairs, member.contactId, recipient.platformId);
      }
    }
  }
  return [...pairs.values()];
}

function addPair(map, contactId, platformId) {
  map.set(`${contactId}:${platformId}`, { contactId, platformId });
}
