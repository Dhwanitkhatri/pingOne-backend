// ============================================================
// Thin helpers over the raw BullMQ queues — everything else in the
// app enqueues work through these functions, never through
// deliveryQueue/retryQueue directly. Keeps job-shape in one place.
// ============================================================

import { deliveryQueue, retryQueue, connection, redisLabel } from './bull.queue.js';
import { RETRY_BACKOFF_MS, MAX_RETRY_ATTEMPTS, JOB_PRIORITY } from '../constants/codes.js';
import { AppError } from '../utils/AppError.js';

const PING_TIMEOUT_MS = 2_000;

/**
 * Fail fast when Redis is down, BEFORE anything is written.
 *
 * An immediate send creates MessageDelivery rows and then queues one job per
 * row. If the queue is unreachable we'd be left with rows nobody will ever
 * pick up on a job already marked dispatched — so the caller checks here
 * first and nothing is created at all.
 *
 * ioredis queues commands while offline rather than rejecting, hence the
 * race: a hung ping means "not reachable" just as much as a failed one.
 */
export async function assertQueueReachable() {
  if (connection.status === 'ready') return;

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('ping timed out')), PING_TIMEOUT_MS).unref?.();
  });

  try {
    await Promise.race([connection.ping(), timeout]);
  } catch {
    throw new AppError(
      503,
      `Can't reach the delivery queue at ${redisLabel}. Start Redis (e.g. ` +
        '`docker run -p 6379:6379 redis`) — or schedule the message for later ' +
        'instead, which only needs the database.',
      { code: 'QUEUE_UNAVAILABLE' }
    );
  }
}

/**
 * Enqueue a single delivery attempt for one MessageDelivery row.
 *
 * @param {number} deliveryId - The MessageDelivery ID
 * @param {string} [priority='normal'] - Job priority: 'high', 'normal', or 'low'
 *        High-priority jobs are processed first (e.g., urgent or time-sensitive messages)
 *        Normal is default for regular scheduled messages
 *        Low is for background/batch operations
 */
export async function enqueueDelivery(deliveryId, priority = 'normal', { viaTwilio = false } = {}) {
  const priorityValue = getPriorityValue(priority);

  await deliveryQueue.add(
    'send',
    // viaTwilio: a WhatsApp re-send after Meta's webhook reported a failure.
    viaTwilio ? { deliveryId, viaTwilio } : { deliveryId },
    {
      priority: priorityValue,
      // Meta redelivers webhooks, so the same failure can arrive twice; a fixed
      // id makes BullMQ drop the duplicate instead of messaging twice.
      ...(viaTwilio ? { jobId: `whatsapp-twilio-${deliveryId}` } : {}),
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
