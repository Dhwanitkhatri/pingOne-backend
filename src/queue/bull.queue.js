// ============================================================
// Redis connection + BullMQ Queue instances.
//
// Configure with REDIS_URL (validated in config/env.js — defaults to
// redis://localhost:6379). Only the worker process actually needs Redis to be
// up; the API server boots and serves every non-queue endpoint without it.
// ============================================================

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env.js';

/** Transient connection problems, as opposed to real bugs. */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN',
]);

/**
 * Attach concise error logging to a BullMQ Queue/Worker or an ioredis client.
 *
 * Every one of these objects needs its own 'error' listener, and the default
 * behaviour when one is missing is genuinely bad: ioredis prints
 * "[ioredis] Unhandled error event" and BullMQ's QueueBase falls through to a
 * bare `console.error(err)`. With Redis down that's a full AggregateError stack
 * per object per reconnect attempt — pages of noise that bury the one line
 * saying what's actually wrong.
 *
 * Connection errors are collapsed to a single line until the connection
 * recovers. Anything else is a real bug and is logged every time.
 */
export function attachErrorLogging(emitter, label) {
  let connectionErrorLogged = false;

  emitter.on('error', (err) => {
    if (CONNECTION_CODES.has(err?.code)) {
      if (connectionErrorLogged) return;
      connectionErrorLogged = true;
      console.error(`[${label}] Redis unreachable (${err.code}) — retrying in the background`);
      return;
    }
    console.error(`[${label}] error:`, err?.message ?? err);
  });

  // 'ready' re-arms the one-shot log so a later outage is reported again.
  emitter.on('ready', () => {
    connectionErrorLogged = false;
  });

  return emitter;
}

// BullMQ requires maxRetriesPerRequest: null on the shared connection.
export const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

// Key namespace for every Queue AND Worker — both sides must agree, or a
// worker listens on keys nothing is written to. See QUEUE_PREFIX in env.js.
export const prefix = env.QUEUE_PREFIX;

// REDIS_URL carries the password for hosted Redis (rediss://default:<pw>@host).
// Logs end up in places a secret must not (hosting dashboards, shared
// terminals), so only host and port are ever printed.
export const redisLabel = (() => {
  try {
    const url = new URL(env.REDIS_URL);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'the configured REDIS_URL';
  }
})();

// ioredis retries forever by default, which is what we want — a brief Redis blip
// shouldn't kill the worker. This just makes the first failure actionable.
let bootErrorLogged = false;
connection.on('error', (err) => {
  if (bootErrorLogged) return;
  bootErrorLogged = true;
  console.error(
    `[queue] cannot reach Redis at ${redisLabel} (${err.code ?? err.message}).\n` +
      '        Start Redis (e.g. `docker run -p 6379:6379 redis`) or set REDIS_URL.\n' +
      '        Scheduling and delivery stay paused until it connects; retrying in the background.'
  );
});
connection.on('ready', () => {
  bootErrorLogged = false;
  console.log(`[queue] connected to Redis at ${redisLabel} (prefix "${prefix}")`);
});

export const QUEUE_NAMES = Object.freeze({
  DELIVERY: 'delivery',
  RETRY: 'retry',
  DELIVERY_DLQ: 'delivery_dlq',
  RETRY_DLQ: 'retry_dlq',
});

// ============================================================
// Queue configuration for priority and dead-letter handling
// ============================================================
const QUEUE_CONFIG = Object.freeze({
  [QUEUE_NAMES.DELIVERY]: {
    settings: {
      defaultJobOptions: {
        removeOnComplete: 500, // keep last 500 successful jobs for audit
        removeOnFail: 1000, // keep last 1000 failed jobs for debugging
        attempts: 1, // no automatic retries; we handle retries via retryQueue
      },
    },
  },
  [QUEUE_NAMES.RETRY]: {
    settings: {
      defaultJobOptions: {
        removeOnComplete: 500,
        removeOnFail: 1000,
        attempts: 1,
      },
    },
  },
});

// Queues need the listener as much as Workers do — each holds its own
// RedisConnection, and BullMQ's QueueBase console.errors the raw error object
// when nothing is listening.
export const deliveryQueue = attachErrorLogging(
  new Queue(QUEUE_NAMES.DELIVERY, { connection, prefix, ...QUEUE_CONFIG[QUEUE_NAMES.DELIVERY] }),
  'queue:delivery'
);
export const retryQueue = attachErrorLogging(
  new Queue(QUEUE_NAMES.RETRY, { connection, prefix, ...QUEUE_CONFIG[QUEUE_NAMES.RETRY] }),
  'queue:retry'
);

// Dead-letter queues for permanent failures. Jobs moved here have exhausted
// all retries and will not be retried further. These are read-only from the
// worker perspective; they exist for audit and manual intervention.
export const deliveryDLQ = attachErrorLogging(
  new Queue(QUEUE_NAMES.DELIVERY_DLQ, { connection, prefix }),
  'queue:delivery:dlq'
);
export const retryDLQ = attachErrorLogging(
  new Queue(QUEUE_NAMES.RETRY_DLQ, { connection, prefix }),
  'queue:retry:dlq'
);

/**
 * Move a failed job to the dead-letter queue.
 * @param {Queue} queue - The source queue
 * @param {string} dlqName - The DLQ name
 * @param {Job} job - The failed job
 * @param {Error} reason - The failure reason
 */
export async function moveToDeadLetterQueue(queue, dlqName, job, reason) {
  const dlq = new Queue(dlqName, { connection, prefix });
  await dlq.add(job.name, job.data, {
    ...job.opts,
    data: {
      ...job.data,
      failureReason: reason.message,
      failureStack: reason.stack,
      movedFromQueue: queue.name,
      movedAt: new Date().toISOString(),
      originalJobId: job.id,
      retryCount: job.attemptsMade,
    },
  });
  await dlq.close();
}
