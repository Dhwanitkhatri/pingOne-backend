// ============================================================
// Worker process entrypoint. Run this SEPARATELY from your Express
// API server:
//
//   node src/worker.js         (or: npm run worker)
//
// Your API server (app.js) handles HTTP requests. This process handles
// background work (scheduling, sending, retrying). In production
// they'd typically be two separate deployments/containers; for the
// capstone demo, two terminal tabs is fine.
// ============================================================

import { startSchedulerWorker } from './workers/scheduler.worker.js';
import { startDeliveryWorker } from './workers/delivery.worker.js';
import { startRetryWorker } from './workers/retry.worker.js';

console.log('🚀 PingOne worker process starting...');

startSchedulerWorker();
startDeliveryWorker();
startRetryWorker();

console.log('✅ Scheduler, delivery, and retry workers are running.');

process.on('SIGTERM', () => {
  console.log('Worker process shutting down...');
  process.exit(0);
});
