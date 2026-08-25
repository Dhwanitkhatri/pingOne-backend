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
//
// Supports graceful shutdown to stop polling cleanly.
// ============================================================

import { prisma } from '../config/prisma.js';
import { enqueueDelivery } from '../queue/queue.service.js';
import { computeNextRunAfter } from '../modules/scheduler/recurrence.js';
import { lookupByCode } from '../utils/lookupCache.js';
import { MESSAGE_STATUS } from '../constants/codes.js';
import { workerManager } from '../utils/worker-manager.js';

const TICK_INTERVAL_MS = 60_000; // check every minute — adjust if you need finer-grained scheduling

let schedulerIntervalId = null;
let isRunning = false;

export function startSchedulerWorker() {
  console.log(`[scheduler] polling every ${TICK_INTERVAL_MS / 1000}s`);
  isRunning = true;
  runTick(); // run once immediately on boot, then on the interval
  schedulerIntervalId = setInterval(runTick, TICK_INTERVAL_MS);

  // Register with worker manager (pseudo-worker, not a real BullMQ worker)
  const pseudoWorker = {
    close: () => Promise.resolve(),
  };
  const pseudoQueue = {
    close: () => Promise.resolve(),
    getCountsPerStatus: async () => ({ waiting: 0, active: 0 }),
  };
  workerManager.register('scheduler', pseudoWorker, pseudoQueue, true);
}

/**
 * Stop the scheduler worker gracefully. Allows the current tick to complete
 * before returning.
 */
export function stopSchedulerWorker() {
  isRunning = false;
  if (schedulerIntervalId !== null) {
    clearInterval(schedulerIntervalId);
    schedulerIntervalId = null;
    console.log('[scheduler] polling stopped');
  }
}

async function runTick() {
  if (!isRunning) return; // early exit if shutdown was requested

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

    if (dueJobs.length > 0) {
      console.log(`[scheduler] found ${dueJobs.length} due job(s)`);
      for (const job of dueJobs) {
        if (!isRunning) break; // stop processing if shutdown requested mid-tick
        await fireJob(job, pendingStatus.id, sentStatus.id);
        workerManager.recordJobCompleted('scheduler');
      }
    }
  } catch (err) {
    // A tick failing should never crash the worker process — log and retry next tick.
    console.error('[scheduler] tick failed:', err);
    workerManager.recordJobFailed('scheduler');
  }
}

async function fireJob(job, pendingStatusId, sentStatusId) {
  const recipientPairs = await expandRecipients(job.recipients);
  const contactPlatformPairs = await excludeRepliedRecipients(job, recipientPairs);

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
      (skipped > 0 ? ` (skipped ${skipped} missed run(s))` : '') +
      (recipientPairs.length !== contactPlatformPairs.length
        ? `; smart-send skipped ${recipientPairs.length - contactPlatformPairs.length} replied recipient(s)`
        : '')
  );
}

/** A reply after schedule creation opts a contact out of later sends on that channel. */
async function excludeRepliedRecipients(job, pairs) {
  if (!job.skipIfReplied || pairs.length === 0) return pairs;

  const replies = await prisma.contactReply.findMany({
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
