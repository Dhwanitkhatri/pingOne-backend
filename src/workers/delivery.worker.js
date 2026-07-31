// ============================================================
// Delivery worker — consumes the `delivery` queue. One job = one
// MessageDelivery row = one send attempt to one contact on one platform.
//
// Flow: Bull Queue -> [this worker] -> Platform Adapter -> Platform API
//                                    -> Delivery Log -> Status Update
//
// Status writes all go through deliveries/delivery-status.service so the
// audit trail in delivery_status_logs is identical whether a change came from
// here or from an inbound platform webhook.
// ============================================================

import { Worker } from 'bullmq';
import { connection, QUEUE_NAMES, attachErrorLogging } from '../queue/bull.queue.js';
import { prisma } from '../config/prisma.js';
import { getAdapter } from '../platforms/adapter.registry.js';
import { resolveRecipientHandle } from '../modules/scheduler/recipient-resolver.js';
import { enqueueRetry } from '../queue/queue.service.js';
import { transitionStatus } from '../modules/deliveries/delivery-status.service.js';
import { loadAttachmentsForSend } from '../modules/messages/attachments.service.js';
import { MESSAGE_STATUS, CHANGED_BY } from '../constants/codes.js';
import * as platformsService from '../modules/platforms/platforms.service.js'; // teammate's module — owns credential storage/decryption

/** A webhook already confirmed these — re-sending would duplicate the message. */
const ALREADY_CONFIRMED = new Set([MESSAGE_STATUS.DELIVERED, MESSAGE_STATUS.READ]);

export function startDeliveryWorker() {
  const worker = new Worker(QUEUE_NAMES.DELIVERY, processDeliveryJob, { connection, concurrency: 5 });

  worker.on('completed', (job) => console.log(`[delivery] job ${job.id} completed`));
  worker.on('failed', (job, err) => console.error(`[delivery] job ${job?.id} failed:`, err.message));

  return attachErrorLogging(worker, 'worker:delivery');
}

async function processDeliveryJob(job) {
  const { deliveryId } = job.data;

  const delivery = await prisma.messageDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      contact: true,
      platform: true,
      status: true,
      job: { include: { message: { include: { template: true } }, user: true } },
    },
  });
  if (!delivery) {
    console.warn(`[delivery] MessageDelivery ${deliveryId} no longer exists, skipping`);
    return;
  }

  // Guard against a duplicate queue entry re-sending something a platform has
  // already confirmed. Cheap check, and the alternative is a message the
  // recipient receives twice.
  if (ALREADY_CONFIRMED.has(delivery.status.code)) {
    console.warn(
      `[delivery] delivery ${deliveryId} is already ${delivery.status.code}, not re-sending`
    );
    return;
  }

  // force: a retry legitimately moves failed -> sending, which the monotonic
  // guard would otherwise reject.
  await transitionStatus({
    deliveryId,
    toCode: MESSAGE_STATUS.SENDING,
    changedBy: CHANGED_BY.SYSTEM,
    force: true,
  });

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

    // Read per delivery rather than per job. One job fanned out to N recipients
    // therefore reads the same files N times — acceptable at the sizes
    // ATTACHMENT_MAX_UPLOAD_MB permits, and each delivery is an independent queue
    // job so there's no shared cache to read them into. The real optimisation is
    // platform-specific (WhatsApp media ids are reusable across sends); worth
    // doing only if large broadcasts with attachments become common.
    const attachments = await loadAttachmentsForSend(delivery.job.messageId);

    const adapter = getAdapter(delivery.platform.code);
    const formatted = adapter.formatMessage(delivery.job.message.content, attachments);
    const result = await adapter.send(credential, { handle }, formatted);

    await transitionStatus({
      deliveryId,
      toCode: MESSAGE_STATUS.SENT,
      changedBy: CHANGED_BY.SYSTEM,
      errorReason: null,
      // retryCount resets so a delivery that eventually succeeded doesn't look
      // like it's still mid-retry.
      data: { platformMessageId: result.platformMessageId, retryCount: 0 },
    });
  } catch (err) {
    await handleFailure(delivery, err);
  }
}

async function handleFailure(delivery, err) {
  const nextAttempt = delivery.retryCount + 1;

  // Record the failure before queueing the retry. If Redis is down, enqueueRetry
  // throws — and doing it in the other order would lose errorReason entirely,
  // leaving a delivery that's stuck in `sending` with no explanation.
  await transitionStatus({
    deliveryId: delivery.id,
    toCode: MESSAGE_STATUS.FAILED,
    changedBy: CHANGED_BY.SYSTEM,
    errorReason: err.message,
    force: true, // failed ranks above sending, but be explicit — this must always land
    data: { retryCount: nextAttempt },
  });

  const willRetry = await enqueueRetry(delivery.id, nextAttempt);

  if (!willRetry) {
    console.error(
      `[delivery] delivery ${delivery.id} permanently failed after ${nextAttempt} attempt(s): ${err.message}`
    );
    // TODO (Notification Service, item 10): insert a Notification row here
    // and trigger push/email per the user's NotificationPreference.notifyOnFailure.
  }
}
