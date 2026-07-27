// ============================================================
// Retry worker — consumes the `retry` queue. Jobs here were added
// with a delay (30s / 2min / 10min per RETRY_BACKOFF_MS) by
// queue.service.enqueueRetry(). When the delay elapses, this worker
// simply re-enqueues the delivery for another real attempt.
//
// Attempt 1 fails -> wait 30s -> Attempt 2 -> wait 2min -> Attempt 3
// -> wait 10min -> Attempt 4 -> still failing -> permanently Failed
// (handled in delivery.worker.js's handleFailure once MAX_RETRY_ATTEMPTS
// is exceeded).
// ============================================================

import { Worker } from 'bullmq';
import { connection, QUEUE_NAMES } from '../queue/bull.queue.js';
import { enqueueDelivery } from '../queue/queue.service.js';

export function startRetryWorker() {
  const worker = new Worker(
    QUEUE_NAMES.RETRY,
    async (job) => {
      const { deliveryId, attemptNumber } = job.data;
      console.log(`[retry] re-attempting delivery ${deliveryId} (attempt ${attemptNumber + 1})`);
      await enqueueDelivery(deliveryId);
    },
    { connection, concurrency: 5 }
  );

  worker.on('failed', (job, err) => console.error(`[retry] job ${job?.id} failed:`, err.message));

  return worker;
}
