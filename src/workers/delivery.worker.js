// ============================================================
// Delivery worker — consumes the `delivery` queue. One job = one
// MessageDelivery row = one send attempt to one contact on one platform.
//
// Flow: Bull Queue -> [this worker] -> Platform Adapter -> Platform API
//                                    -> Delivery Log -> Status Update
// ============================================================

import { Worker } from 'bullmq';
import { connection, QUEUE_NAMES } from '../queue/bull.queue.js';
import { prisma } from '../config/prisma.js';
import { getAdapter } from '../platforms/adapter.registry.js';
import { resolveRecipientHandle } from '../modules/scheduler/recipient-resolver.js';
import { enqueueRetry } from '../queue/queue.service.js';
import { lookupByCode } from '../utils/lookupCache.js';
import { MESSAGE_STATUS } from '../constants/codes.js';
import * as platformsService from '../modules/platforms/platforms.service.js'; // teammate's module — owns credential storage/decryption

export function startDeliveryWorker() {
  const worker = new Worker(QUEUE_NAMES.DELIVERY, processDeliveryJob, { connection, concurrency: 5 });

  worker.on('completed', (job) => console.log(`[delivery] job ${job.id} completed`));
  worker.on('failed', (job, err) => console.error(`[delivery] job ${job?.id} failed:`, err.message));

  return worker;
}

async function processDeliveryJob(job) {
  const { deliveryId } = job.data;

  const delivery = await prisma.messageDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      contact: true,
      platform: true,
      job: { include: { message: { include: { template: true } }, user: true } },
    },
  });
  if (!delivery) {
    console.warn(`[delivery] MessageDelivery ${deliveryId} no longer exists, skipping`);
    return;
  }

  await updateStatus(delivery, MESSAGE_STATUS.SENDING);

  try {
    const credential = await platformsService.getDecryptedCredential(
      delivery.job.userId,
      delivery.platform.code
    );
    // credential = { secret, extraInfo, expiresAt } — already decrypted, matches
    // the { secret, extraInfo } shape every adapter's send()/validate() expects.

    const handle = await resolveRecipientHandle(
      delivery.contactId,
      delivery.platformId,
      delivery.platform.code
    );

    const adapter = getAdapter(delivery.platform.code);
    const formatted = adapter.formatMessage(delivery.job.message.content);
    const result = await adapter.send(credential, { handle }, formatted);

    await prisma.messageDelivery.update({
      where: { id: delivery.id },
      data: { platformMessageId: result.platformMessageId, sentAt: new Date(), retryCount: 0, errorReason: null },
    });
    await updateStatus(delivery, MESSAGE_STATUS.SENT);
  } catch (err) {
    await handleFailure(delivery, err);
  }
}

async function handleFailure(delivery, err) {
  const nextAttempt = delivery.retryCount + 1;

  await prisma.messageDelivery.update({
    where: { id: delivery.id },
    data: { retryCount: nextAttempt, errorReason: err.message },
  });

  const willRetry = await enqueueRetry(delivery.id, nextAttempt);

  await updateStatus(delivery, MESSAGE_STATUS.FAILED);

  if (!willRetry) {
    console.error(
      `[delivery] delivery ${delivery.id} permanently failed after ${nextAttempt} attempt(s): ${err.message}`
    );
    // TODO (Notification Service, item 10): insert a Notification row here
    // and trigger push/email per the user's NotificationPreference.notifyOnFailure.
  }
}

/** Writes MessageDelivery.statusId AND a DeliveryStatusLog row for the transition. */
async function updateStatus(delivery, newCode) {
  const newStatus = await lookupByCode('messageStatus', newCode);
  const oldStatusId = delivery.statusId;

  await prisma.$transaction([
    prisma.messageDelivery.update({ where: { id: delivery.id }, data: { statusId: newStatus.id } }),
    prisma.deliveryStatusLog.create({
      data: {
        deliveryId: delivery.id,
        oldStatusId: oldStatusId ?? null,
        newStatusId: newStatus.id,
        changedBy: 'system',
      },
    }),
  ]);

  delivery.statusId = newStatus.id; // keep in-memory object consistent for subsequent calls in this job
}