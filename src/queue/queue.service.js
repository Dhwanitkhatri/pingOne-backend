// ============================================================
// Thin helpers over the raw BullMQ queues — everything else in the
// app enqueues work through these functions, never through
// deliveryQueue/retryQueue directly. Keeps job-shape in one place.
// ============================================================

import { deliveryQueue, retryQueue } from './bull.queue.js';
import { RETRY_BACKOFF_MS, MAX_RETRY_ATTEMPTS } from '../constants/codes.js';

/** Enqueue a single delivery attempt for one MessageDelivery row. */
export async function enqueueDelivery(deliveryId) {
  await deliveryQueue.add(
    'send',
    { deliveryId },
    {
      attempts: 1, // retries are handled explicitly via retryQueue, not BullMQ's built-in attempts
      removeOnComplete: 500,
      removeOnFail: 1000,
    }
  );
}

/**
 * Schedule a retry for a failed delivery, using the fixed backoff table
 * (30s, 2min, 10min). Returns false once MAX_RETRY_ATTEMPTS is exceeded
 * so the caller can mark it permanently failed instead.
 */
export async function enqueueRetry(deliveryId, attemptNumber) {
  if (attemptNumber > MAX_RETRY_ATTEMPTS) return false;

  const delay = RETRY_BACKOFF_MS[attemptNumber - 1];
  await retryQueue.add(
    'retry',
    { deliveryId, attemptNumber },
    { delay, removeOnComplete: 500, removeOnFail: 1000 }
  );
  return true;
}
