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
//
// This process:
// 1. Starts all worker instances (scheduler, delivery, retry)
// 2. Exposes health check endpoints on a health port
// 3. Handles graceful shutdown on SIGTERM
// 4. Tracks queue metrics and job statistics
// ============================================================

import express from 'express';
import { startSchedulerWorker, stopSchedulerWorker } from './workers/scheduler.worker.js';
import { startDeliveryWorker } from './workers/delivery.worker.js';
import { startRetryWorker } from './workers/retry.worker.js';
import { connection } from './queue/bull.queue.js';
import { workerManager } from './utils/worker-manager.js';
import { authenticate } from './middleware/authenticate.js';
import { errorHandler } from './middleware/errorHandler.js';
import { env } from './config/env.js';
import { verifyMailer } from './utils/mailer.js';
import workerHealthRoutes from './modules/worker-health/worker-health.routes.js';

const WORKER_HEALTH_PORT = process.env.WORKER_HEALTH_PORT || 4001;

console.log('🚀 PingOne worker process starting...');

let isShuttingDown = false;

/**
 * Start all worker processes and health check server.
 */
async function startWorkers() {
  // This process sends the permanent-failure alerts, so it needs a working
  // transport too — surface a bad SMTP config here rather than at 3am.
  void verifyMailer();

  // Start the actual workers
  startSchedulerWorker();
  startDeliveryWorker();
  startRetryWorker();

  console.log('✅ Scheduler, delivery, and retry workers are running.');

  // Start health check server
  const app = express();
  app.use(express.json());

  // Mount health check routes (with auth)
  app.use('/worker-health', authenticate, workerHealthRoutes);

  // Unauthenticated liveness/readiness for container orchestration
  app.get('/health/live', async (req, res) => {
    const health = await workerManager.getHealth();
    const isAlive = health.summary.activeWorkers > 0 && !health.isShuttingDown;
    res.status(isAlive ? 200 : 503).json({ status: isAlive ? 'alive' : 'dead' });
  });

  app.get('/health/ready', async (req, res) => {
    const health = await workerManager.getHealth();
    const isReady = health.isHealthy && !health.isShuttingDown;
    res.status(isReady ? 200 : 503).json({ status: isReady ? 'ready' : 'not_ready' });
  });

  // Error handler
  app.use(errorHandler);

  // Try to start health check server, but don't fail if port is unavailable
  let server = null;
  try {
    server = await new Promise((resolve, reject) => {
      const srv = app.listen(WORKER_HEALTH_PORT, () => {
        console.log(`📊 Worker health checks available at http://localhost:${WORKER_HEALTH_PORT}/health`);
        console.log(`   Authenticated health: http://localhost:${WORKER_HEALTH_PORT}/worker-health`);
        resolve(srv);
      });

      // Timeout after 2 seconds if can't bind
      const timeout = setTimeout(() => {
        srv.close();
        reject(new Error(`Could not bind health server to port ${WORKER_HEALTH_PORT} within 2 seconds`));
      }, 2000);

      srv.on('listening', () => clearTimeout(timeout));
      srv.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  } catch (err) {
    // Health server failed to start, but that's OK - workers can still run
    console.warn(`⚠️  Health check server unavailable (${err.message}). Workers will continue running without health checks.`);
    server = null;
  }

  // Return server and cleanup function for shutdown
  return { server, app };
}

/**
 * Graceful shutdown handler. Ensures all in-flight jobs complete before exit.
 */
async function gracefulShutdown(server) {
  if (isShuttingDown) {
    console.warn('⚠️  Shutdown already in progress, ignoring signal');
    return;
  }

  isShuttingDown = true;

  console.log('\n📋 Graceful shutdown initiated...');

  try {
    // Step 1: Close the health check server (stop accepting new requests)
    if (server && server.listening) {
      console.log('🔌 Closing health check server...');
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    // Step 2: Stop scheduler worker (prevents new jobs from being enqueued)
    console.log('⏸️  Stopping scheduler worker...');
    stopSchedulerWorker();

    // Step 3: Let delivery and retry workers finish their in-flight jobs
    console.log('⏳ Waiting for delivery and retry workers to complete in-flight jobs...');
    await workerManager.gracefulShutdown(connection);

    console.log('✅ Worker process shut down gracefully');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during graceful shutdown:', err);
    process.exit(1);
  }
}

/**
 * Main entry point.
 */
async function main() {
  // Register error handlers FIRST before starting workers
  const handleShutdown = (server) => {
    if (isShuttingDown) {
      console.warn('⚠️  Shutdown already in progress, ignoring signal');
      return;
    }
    console.log(`\n📨 Received signal, initiating graceful shutdown...`);
    gracefulShutdown(server);
  };

  // Handle graceful shutdown on signals
  const shutdownSignals = ['SIGTERM', 'SIGINT'];

  // Will be assigned once server starts
  let server = null;

  // Prevent uncaught exceptions from crashing the entire process
  process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err);
    // Don't exit immediately; let graceful shutdown handle cleanup
    handleShutdown(server);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled rejection at promise:', promise, 'reason:', reason);
    handleShutdown(server);
  });

  // Now start workers
  try {
    const result = await startWorkers();
    server = result.server;

    // Register signal handlers AFTER server is ready
    shutdownSignals.forEach((signal) => {
      process.on(signal, () => {
        handleShutdown(server);
      });
    });
  } catch (err) {
    console.error('❌ Fatal error during startup:', err);
    process.exit(1);
  }
}

main();

