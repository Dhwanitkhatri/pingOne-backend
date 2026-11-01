// ============================================================
// Retry worker — consumes the `retry` queue. Jobs here were added
// with a delay (30s / 2min / 10min per RETRY_BACKOFF_MS) by
// queue.service.enqueueRetry(). When the delay elapses, this worker
// simply re-enqueues the delivery for another real attempt.
//
// Attempt 1 fails -> wait 30s -> Attempt 2 -> wait 2min -> Attempt 3
// -> wait 10min -> Attempt 4 -> still failing -> moved to DLQ
// (handled in delivery.worker.js's handleFailure once MAX_RETRY_ATTEMPTS
// is exceeded).
//
// Supports graceful shutdown to ensure in-flight retries complete before exit.
// ============================================================

import { Worker } from 'bullmq';
import { connection, prefix, QUEUE_NAMES, attachErrorLogging, retryQueue } from '../queue/bull.queue.js';
import { enqueueDelivery } from '../queue/queue.service.js';
import { workerManager } from '../utils/worker-manager.js';

export function startRetryWorker() {
  const worker = new Worker(
    QUEUE_NAMES.RETRY,
    async (job) => {
      const { deliveryId, attemptNumber, viaTwilio } = job.data;
      console.log(`[retry] re-attempting delivery ${deliveryId} (attempt ${attemptNumber + 1})`);
      await enqueueDelivery(deliveryId, 'normal', { viaTwilio });
    },
    {
      connection,
      prefix,
      concurrency: 5,
      settings: {
        lockDuration: 30_000,
        lockRenewTime: 15_000,
        maxStalledCount: 2,
      },
    }
  );

  worker.on('completed', (job) => {
    console.log(`[retry] job ${job.id} completed (delivery_id: ${job.data.deliveryId}, attempt: ${job.data.attemptNumber + 1})`);
    workerManager.recordJobCompleted('retry');
  });

  worker.on('failed', (job, err) => {
    console.error(`[retry] job ${job?.id} failed (delivery_id: ${job?.data?.deliveryId}):`, err.message);
    workerManager.recordJobFailed('retry');
  });

  worker.on('stalled', (jobId) => {
    console.warn(`[retry] job ${jobId} stalled (will retry)`);
  });

  // Register with worker manager for health checks and graceful shutdown
  workerManager.register('retry', worker, retryQueue, true);

  return attachErrorLogging(worker, 'worker:retry');
}
