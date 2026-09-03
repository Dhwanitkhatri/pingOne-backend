// ============================================================
// Scheduler API service. This is what the scheduler.worker.js polls
// against — it just creates the rows; the worker does the firing.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { lookupByCode } from '../../utils/lookupCache.js';
import { getPlatformId } from '../../utils/platforms.js';
import { assertQueueReachable } from '../../queue/queue.service.js';
import { MESSAGE_STATUS } from '../../constants/codes.js';
import { fireJob, FIRE_JOB_INCLUDE } from './dispatch.js';
import * as messagesService from '../messages/messages.service.js'; // reuse their create logic — includes template-ownership check

/**
 * What a job returns to the client.
 *
 * Recipients and deliveries are resolved down to platform CODES and contact
 * names, never the raw numeric FKs: the ids are internal to the reference
 * tables and a client has no way to interpret them. `deliveries` is what
 * turns this endpoint into the message history — one row per (contact,
 * platform) with its own status and error, which is the granularity the UI
 * shows. It's empty until the job fires.
 */
const contactSelect = { select: { id: true, firstName: true, lastName: true } };
const platformSelect = { select: { code: true, name: true } };

const include = {
  message: { include: { template: true } },
  recurrenceRule: { include: { recurrenceType: true } },
  recipients: {
    include: {
      platform: platformSelect,
      contact: contactSelect,
      group: { select: { id: true, name: true } },
    },
  },
  deliveries: {
    include: {
      platform: platformSelect,
      contact: contactSelect,
      status: { select: { code: true } },
    },
    orderBy: { id: 'asc' },
  },
  status: true,
};

export async function listSchedules(userId) {
  return prisma.scheduledJob.findMany({ where: { userId }, include, orderBy: { scheduledAt: 'desc' } });
}

export async function getSchedule(userId, jobId) {
  const job = await prisma.scheduledJob.findFirst({ where: { id: jobId, userId }, include });
  if (!job) throw AppError.notFound('Scheduled job not found');
  return job;
}

export async function createSchedule(userId, { messageId, message, scheduledAt, recurrence, recipients, skipIfReplied }) {
  const pendingStatus = await lookupByCode('messageStatus', MESSAGE_STATUS.PENDING);
  const resolvedRecipients = await resolveRecipients(recipients);

  return prisma.$transaction(async (tx) => {
    const resolvedMessageId = messageId ?? (await createInlineMessage(userId, message));

    const recurrenceRuleId = recurrence ? await createRecurrenceRule(tx, recurrence) : null;

    const job = await tx.scheduledJob.create({
      data: {
        userId,
        messageId: resolvedMessageId,
        recurrenceRuleId,
        statusId: pendingStatus.id,
        scheduledAt,
        skipIfReplied,
        nextRunAt: scheduledAt, // scheduler worker fires it once this passes
        recipients: { create: resolvedRecipients },
      },
      include,
    });

    return job;
  });
}

export async function updateSchedule(userId, jobId, patch) {
  const existing = await prisma.scheduledJob.findFirst({ where: { id: jobId, userId } });
  if (!existing) throw AppError.notFound('Scheduled job not found');

  return prisma.$transaction(async (tx) => {
    let recurrenceRuleId = existing.recurrenceRuleId;
    if (patch.recurrence) {
      recurrenceRuleId = await createRecurrenceRule(tx, patch.recurrence);
    }

    if (patch.recipients) {
      const resolved = await resolveRecipients(patch.recipients);
      await tx.jobRecipient.deleteMany({ where: { jobId } });
      await tx.jobRecipient.createMany({ data: resolved.map((r) => ({ ...r, jobId })) });
    }

    return tx.scheduledJob.update({
      where: { id: jobId },
      data: {
        ...(patch.scheduledAt && { scheduledAt: patch.scheduledAt, nextRunAt: patch.scheduledAt }),
        // A new recurrence rule starts a new series, so the occurrence counter
        // resets — otherwise past sends would eat into the new maxOccurrences.
        ...(patch.recurrence && { recurrenceRuleId, occurrenceCount: 0 }),
        ...(patch.skipIfReplied !== undefined && { skipIfReplied: patch.skipIfReplied }),
      },
      include,
    });
  });
}

/** Cancels a job that hasn't fired yet. Jobs with existing deliveries can't be deleted (FK is NoAction). */
export async function cancelSchedule(userId, jobId) {
  const existing = await prisma.scheduledJob.findFirst({
    where: { id: jobId, userId },
    include: { deliveries: { select: { id: true }, take: 1 } },
  });
  if (!existing) throw AppError.notFound('Scheduled job not found');

  if (existing.deliveries.length > 0) {
    throw AppError.badRequest('This job has already started sending and cannot be cancelled', {
      code: 'JOB_ALREADY_STARTED',
    });
  }

  await prisma.scheduledJob.delete({ where: { id: jobId } });
}

/**
 * POST /messages/send — the composer's one entry point.
 *
 * `scheduledAt` decides the behaviour: absent or already past means send
 * now, a future time means leave a pending job for the scheduler worker.
 *
 * "Send now" is the same code path as a scheduled send, just fired
 * immediately instead of on the next poll — same expansion, same rows, same
 * queue — so an immediate send and a scheduled one can never drift apart.
 *
 * @returns {Promise<{ mode: 'sent'|'scheduled', job: object, deliveries: number,
 *                     skippedRepliers: number }>}
 */
export async function sendOrSchedule(
  userId,
  { messageId, subject, content, templateId, scheduledAt, recipients, skipIfReplied }
) {
  const when = scheduledAt ?? new Date();
  const immediate = when.getTime() <= Date.now();

  // Check the queue BEFORE writing anything: a send we can't dispatch should
  // leave no job and no deliveries behind. Scheduled sends skip this — the
  // worker needs Redis when it fires, not when the row is created.
  if (immediate) await assertQueueReachable();

  const job = await createSchedule(userId, {
    messageId,
    message: messageId ? undefined : { subject, content, templateId },
    scheduledAt: when,
    recurrence: undefined, // the composer only creates one-time sends
    recipients,
    skipIfReplied: skipIfReplied ?? false,
  });

  if (!immediate) {
    return { mode: 'scheduled', job, deliveries: 0, skippedRepliers: 0 };
  }

  const [pendingStatus, sentStatus, loaded] = await Promise.all([
    lookupByCode('messageStatus', MESSAGE_STATUS.PENDING),
    lookupByCode('messageStatus', MESSAGE_STATUS.SENT),
    prisma.scheduledJob.findUnique({ where: { id: job.id }, include: FIRE_JOB_INCLUDE }),
  ]);

  const result = await fireJob(loaded, pendingStatus.id, sentStatus.id);

  return {
    mode: 'sent',
    job: await getSchedule(userId, job.id),
    deliveries: result.deliveries,
    skippedRepliers: result.skippedRepliers,
  };
}

// ---- internal helpers ----------------------------------------------

/**
 * Turn `{ platform: "sms" }` into `{ platformId: 4 }`, leaving recipients
 * that already carry a numeric id untouched. An unknown code fails here with
 * a clear message rather than as a foreign-key violation three layers down.
 */
async function resolveRecipients(recipients) {
  return Promise.all(
    recipients.map(async ({ platform, platformId, ...rest }) => ({
      ...rest,
      platformId: platformId ?? (await getPlatformId(platform)),
    }))
  );
}

// NOTE: intentionally NOT run inside the outer $transaction — messagesService
// uses the shared `prisma` client, not the `tx` transaction client, so it
// commits independently. Fine here (an orphaned Message with no ScheduledJob
// is harmless), but don't assume this rolls back together with the job/rule
// creation below it.
async function createInlineMessage(userId, { subject, content, templateId }) {
  const message = await messagesService.createMessage({
    userId,
    subject: subject ?? null,
    content,
    templateId: templateId ?? null,
  });
  return message.id;
}

async function createRecurrenceRule(tx, recurrence) {
  const type = await lookupByCode('recurrenceType', recurrence.typeCode);
  const rule = await tx.recurrenceRule.create({
    data: {
      recurrenceTypeId: type.id,
      intervalValue: recurrence.intervalValue,
      daysOfWeek: recurrence.daysOfWeek,
      dayOfMonth: recurrence.dayOfMonth,
      monthOfYear: recurrence.monthOfYear,
      endDate: recurrence.endDate,
      maxOccurrences: recurrence.maxOccurrences,
    },
  });
  return rule.id;
}
