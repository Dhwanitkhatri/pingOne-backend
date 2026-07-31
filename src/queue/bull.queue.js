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

// ioredis retries forever by default, which is what we want — a brief Redis blip
// shouldn't kill the worker. This just makes the first failure actionable.
let bootErrorLogged = false;
connection.on('error', (err) => {
  if (bootErrorLogged) return;
  bootErrorLogged = true;
  console.error(
    `[queue] cannot reach Redis at ${env.REDIS_URL} (${err.code ?? err.message}).\n` +
      '        Start Redis (e.g. `docker run -p 6379:6379 redis`) or set REDIS_URL.\n' +
      '        Scheduling and delivery stay paused until it connects; retrying in the background.'
  );
});
connection.on('ready', () => {
  bootErrorLogged = false;
  console.log(`[queue] connected to Redis at ${env.REDIS_URL}`);
});

export const QUEUE_NAMES = Object.freeze({
  DELIVERY: 'delivery',
  RETRY: 'retry',
});

// Queues need the listener as much as Workers do — each holds its own
// RedisConnection, and BullMQ's QueueBase console.errors the raw error object
// when nothing is listening.
export const deliveryQueue = attachErrorLogging(
  new Queue(QUEUE_NAMES.DELIVERY, { connection }),
  'queue:delivery'
);
export const retryQueue = attachErrorLogging(
  new Queue(QUEUE_NAMES.RETRY, { connection }),
  'queue:retry'
);
