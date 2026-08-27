// ============================================================
// Scheduler worker — the thing that turns "this should send at time X"
// into actual queued delivery jobs.
//
// Runs as a plain setInterval poll (not a BullMQ repeatable job) —
// simpler to reason about and debug for a capstone project. Every
// TICK_INTERVAL_MS it:
//   1. finds ScheduledJobs that are due (nextRunAt <= now, status = pending)
//   2. hands each one to fireJob() in ../modules/scheduler/dispatch.js
//
// Steps 2-4 of the old flow (expand recipients, enqueue deliveries, advance
// nextRunAt) live in dispatch.js now, because POST /messages/send fires a
// job the same way without waiting for the next tick.
//
// Flow: ScheduledJob -> [this worker] -> MessageDelivery rows -> Bull Queue
//
// Supports graceful shutdown to stop polling cleanly.
// ============================================================

import { prisma } from '../config/prisma.js';
import { fireJob, FIRE_JOB_INCLUDE } from '../modules/scheduler/dispatch.js';
import { lookupByCode } from '../utils/lookupCache.js';
import { MESSAGE_STATUS } from '../constants/codes.js';
import { workerManager } from '../utils/worker-manager.js';

const TICK_INTERVAL_MS = 60_000; // check every minute — adjust if you need finer-grained scheduling

let schedulerIntervalId = null;
let isRunning = false;

export function startSchedulerWorker() {
  console.log(`[scheduler] polling every ${TICK_INTERVAL_MS / 1000}s`);
  isRunning = true;
  runTick(); // run once immediately on boot, then on the interval
  schedulerIntervalId = setInterval(runTick, TICK_INTERVAL_MS);

  // Register with worker manager (pseudo-worker, not a real BullMQ worker)
  const pseudoWorker = {
    close: () => Promise.resolve(),
  };
  const pseudoQueue = {
    close: () => Promise.resolve(),
    getCountsPerStatus: async () => ({ waiting: 0, active: 0 }),
  };
  workerManager.register('scheduler', pseudoWorker, pseudoQueue, true);
}

/**
 * Stop the scheduler worker gracefully. Allows the current tick to complete
 * before returning.
 */
export function stopSchedulerWorker() {
  isRunning = false;
  if (schedulerIntervalId !== null) {
    clearInterval(schedulerIntervalId);
    schedulerIntervalId = null;
    console.log('[scheduler] polling stopped');
  }
}

async function runTick() {
  if (!isRunning) return; // early exit if shutdown was requested

  try {
    const pendingStatus = await lookupByCode('messageStatus', MESSAGE_STATUS.PENDING);
    const sentStatus = await lookupByCode('messageStatus', MESSAGE_STATUS.SENT);

    const dueJobs = await prisma.scheduledJob.findMany({
      where: {
        statusId: pendingStatus.id,
        nextRunAt: { lte: new Date() },
      },
      include: FIRE_JOB_INCLUDE,
    });

    if (dueJobs.length > 0) {
      console.log(`[scheduler] found ${dueJobs.length} due job(s)`);
      for (const job of dueJobs) {
        if (!isRunning) break; // stop processing if shutdown requested mid-tick
        await fireJob(job, pendingStatus.id, sentStatus.id);
        workerManager.recordJobCompleted('scheduler');
      }
    }
  } catch (err) {
    // A tick failing should never crash the worker process — log and retry next tick.
    console.error('[scheduler] tick failed:', err);
    workerManager.recordJobFailed('scheduler');
  }
}
