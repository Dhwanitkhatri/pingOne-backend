// ============================================================
// Scheduler worker — the thing that turns "this should send at time X"
// into actual queued delivery jobs.
//
// Runs as a plain setInterval poll (not a BullMQ repeatable job) —
// simpler to reason about and debug for a capstone project. Every
// TICK_INTERVAL_MS it:
//   1. finds ScheduledJobs that are due (nextRunAt <= now, status = pending)
//   2. expands JobRecipients (individual contacts + group members) into
//      one MessageDelivery row per (contact, platform)
//   3. enqueues a delivery job per MessageDelivery row
//   4. advances nextRunAt (recurring) or marks the job dispatched (one-time)
//
// Flow: ScheduledJob -> [this worker] -> MessageDelivery rows -> Bull Queue
// ============================================================

import { prisma } from '../config/prisma.js';
import { enqueueDelivery } from '../queue/queue.service.js';
import { computeNextRunAfter } from '../modules/scheduler/recurrence.js';
import { lookupByCode } from '../utils/lookupCache.js';
import { MESSAGE_STATUS } from '../constants/codes.js';

const TICK_INTERVAL_MS = 60_000; // check every minute — adjust if you need finer-grained scheduling

export function startSchedulerWorker() {
  console.log(`[scheduler] polling every ${TICK_INTERVAL_MS / 1000}s`);
  runTick(); // run once immediately on boot, then on the interval
  setInterval(runTick, TICK_INTERVAL_MS);
}

async function runTick() {
  try {
    const pendingStatus = await lookupByCode('messageStatus', MESSAGE_STATUS.PENDING);
    const sentStatus = await lookupByCode('messageStatus', MESSAGE_STATUS.SENT);

    const dueJobs = await prisma.scheduledJob.findMany({
      where: {
        statusId: pendingStatus.id,
        nextRunAt: { lte: new Date() },
      },
      include: {
        recipients: { include: { group: { include: { members: true } } } },
        recurrenceRule: { include: { recurrenceType: true } },
      },
    });

    for (const job of dueJobs) {
      await fireJob(job, pendingStatus.id, sentStatus.id);
    }
  } catch (err) {
    // A tick failing should never crash the worker process — log and retry next tick.
    console.error('[scheduler] tick failed:', err);
  }
}

async function fireJob(job, pendingStatusId, sentStatusId) {
  const contactPlatformPairs = await expandRecipients(job.recipients);

  const deliveries = await prisma.$transaction(
    contactPlatformPairs.map(({ contactId, platformId }) =>
      prisma.messageDelivery.create({
        data: { jobId: job.id, contactId, platformId, statusId: pendingStatusId },
      })
    )
  );

  for (const delivery of deliveries) {
    await enqueueDelivery(delivery.id);
  }

  // This firing counts toward RecurrenceRule.maxOccurrences.
  const occurrenceCount = job.occurrenceCount + 1;

  // computeNextRunAfter walks past any runs missed while the worker was down
  // instead of firing them all in a burst. Skipped runs still count against
  // maxOccurrences, so a "10 sends" rule never exceeds 10.
  const { nextRunAt, skipped } = computeNextRunAfter(
    job.nextRunAt ?? job.scheduledAt,
    job.recurrenceRule,
    occurrenceCount
  );

  await prisma.scheduledJob.update({
    where: { id: job.id },
    data: {
      occurrenceCount: occurrenceCount + skipped,
      ...(nextRunAt
        ? { nextRunAt } // still recurring — leave status pending for the next tick
        : { nextRunAt: null, statusId: sentStatusId }), // one-time (or series ended) — mark dispatched
    },
  });

  console.log(
    `[scheduler] fired job ${job.id} -> ${deliveries.length} delivery(ies), ` +
      `occurrence ${occurrenceCount}, next run: ${nextRunAt?.toISOString() ?? 'none'}` +
      (skipped > 0 ? ` (skipped ${skipped} missed run(s))` : '')
  );
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
