// ============================================================
// Scheduler API service. This is what the scheduler.worker.js polls
// against — it just creates the rows; the worker does the firing.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { lookupByCode } from '../../utils/lookupCache.js';
import { MESSAGE_STATUS } from '../../constants/codes.js';
import * as messagesService from '../messages/messages.service.js'; // reuse their create logic — includes template-ownership check

const include = {
  message: { include: { template: true } },
  recurrenceRule: { include: { recurrenceType: true } },
  recipients: true,
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

export async function createSchedule(userId, { messageId, message, scheduledAt, recurrence, recipients }) {
  const pendingStatus = await lookupByCode('messageStatus', MESSAGE_STATUS.PENDING);

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
        nextRunAt: scheduledAt, // scheduler worker fires it once this passes
        recipients: { create: recipients },
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
      await tx.jobRecipient.deleteMany({ where: { jobId } });
      await tx.jobRecipient.createMany({ data: patch.recipients.map((r) => ({ ...r, jobId })) });
    }

    return tx.scheduledJob.update({
      where: { id: jobId },
      data: {
        ...(patch.scheduledAt && { scheduledAt: patch.scheduledAt, nextRunAt: patch.scheduledAt }),
        ...(patch.recurrence && { recurrenceRuleId }),
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

// ---- internal helpers ----------------------------------------------

// NOTE: intentionally NOT run inside the outer $transaction — messagesService
// uses the shared `prisma` client, not the `tx` transaction client, so it
// commits independently. Fine here (an orphaned Message with no ScheduledJob
// is harmless), but don't assume this rolls back together with the job/rule
// creation below it.
async function createInlineMessage(userId, { content, templateId }) {
  const message = await messagesService.createMessage({ userId, content, templateId: templateId ?? null });
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