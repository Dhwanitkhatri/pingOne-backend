// ============================================================
// Redis connection + BullMQ Queue instances.
//
// Add to your env.js schema (not edited here since I don't have your
// full file, but add this line to envSchema):
//
//   REDIS_URL: z.string().url().default('redis://localhost:6379'),
//
// and to .env:  REDIS_URL=redis://localhost:6379
// ============================================================

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// BullMQ requires maxRetriesPerRequest: null on the shared connection.
export const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

export const QUEUE_NAMES = Object.freeze({
  DELIVERY: 'delivery',
  RETRY: 'retry',
});

export const deliveryQueue = new Queue(QUEUE_NAMES.DELIVERY, { connection });
export const retryQueue = new Queue(QUEUE_NAMES.RETRY, { connection });
