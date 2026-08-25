// ============================================================
// Thin helpers over the raw BullMQ queues — everything else in the
// app enqueues work through these functions, never through
// deliveryQueue/retryQueue directly. Keeps job-shape in one place.
// ============================================================

import { deliveryQueue, retryQueue } from './bull.queue.js';
import { RETRY_BACKOFF_MS, MAX_RETRY_ATTEMPTS, JOB_PRIORITY } from '../constants/codes.js';

/**
 * Enqueue a single delivery attempt for one MessageDelivery row.
 *
 * @param {number} deliveryId - The MessageDelivery ID
 * @param {string} [priority='normal'] - Job priority: 'high', 'normal', or 'low'
 *        High-priority jobs are processed first (e.g., urgent or time-sensitive messages)
 *        Normal is default for regular scheduled messages
 *        Low is for background/batch operations
 */
export async function enqueueDelivery(deliveryId, priority = 'normal') {
  const priorityValue = getPriorityValue(priority);

  await deliveryQueue.add(
    'send',
    { deliveryId },
    {
      priority: priorityValue,
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
 *
 * @param {number} deliveryId - The MessageDelivery ID
 * @param {number} attemptNumber - Current attempt number
 * @param {string} [priority='normal'] - Job priority (same as enqueueDelivery)
 * @returns {boolean} True if retry was scheduled, false if max attempts exceeded
 */
export async function enqueueRetry(deliveryId, attemptNumber, priority = 'normal') {
  if (attemptNumber > MAX_RETRY_ATTEMPTS) return false;

  const priorityValue = getPriorityValue(priority);
  const delay = RETRY_BACKOFF_MS[attemptNumber - 1];

  await retryQueue.add(
    'retry',
    { deliveryId, attemptNumber },
    {
      priority: priorityValue,
      delay,
      removeOnComplete: 500,
      removeOnFail: 1000,
    }
  );
  return true;
}

/**
 * Convert priority string to BullMQ numeric priority.
 * BullMQ uses numeric priorities where LOWER numbers = HIGHER priority.
 * @param {string} priority - 'high', 'normal', or 'low'
 * @returns {number} Priority value for BullMQ
 */
function getPriorityValue(priority) {
  switch (priority) {
    case 'high':
      return JOB_PRIORITY.HIGH;
    case 'low':
      return JOB_PRIORITY.LOW;
    case 'normal':
    default:
      return JOB_PRIORITY.NORMAL;
  }
}
