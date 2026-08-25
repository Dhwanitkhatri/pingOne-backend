// ============================================================
// Worker Health Controller — exposes worker status endpoints.
// These endpoints are protected by authentication and provide
// detailed worker health and queue status information.
// ============================================================

import { workerManager } from '../../utils/worker-manager.js';

/**
 * GET /worker-health
 * Comprehensive worker health status including queue metrics and stats.
 */
export async function getWorkerHealth(req, res, next) {
  try {
    const health = await workerManager.getHealth();
    res.json(health);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /worker-health/:workerName
 * Single worker status including queue metrics.
 */
export async function getWorkerStatus(req, res, next) {
  try {
    const { workerName } = req.params;
    const status = await workerManager.getWorkerStatus(workerName);

    if (!status) {
      return res.status(404).json({
        error: {
          message: `Worker "${workerName}" not found`,
          code: 'WORKER_NOT_FOUND',
        },
      });
    }

    res.json(status);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /worker-health/live
 * Lightweight liveness probe for Kubernetes/Docker health checks.
 * Returns 200 if at least one worker is active, 503 if all are down.
 */
export async function getLiveness(req, res, next) {
  try {
    const health = await workerManager.getHealth();
    const isAlive = health.summary.activeWorkers > 0 && !health.isShuttingDown;

    res.status(isAlive ? 200 : 503).json({
      status: isAlive ? 'alive' : 'dead',
      timestamp: health.timestamp,
      activeWorkers: health.summary.activeWorkers,
    });
  } catch (err) {
    // If we can't even query the health status, something is very wrong
    res.status(503).json({ status: 'error', error: err.message });
  }
}

/**
 * GET /worker-health/ready
 * Readiness probe — returns 200 only if all workers are operational.
 * Use this to drain traffic before shutdown.
 */
export async function getReadiness(req, res, next) {
  try {
    const health = await workerManager.getHealth();
    const isReady =
      health.isHealthy &&
      !health.isShuttingDown &&
      health.summary.activeWorkers === health.summary.totalWorkers;

    res.status(isReady ? 200 : 503).json({
      status: isReady ? 'ready' : 'not_ready',
      timestamp: health.timestamp,
      reason: !isReady ? health.isShuttingDown ? 'shutting_down' : 'some_workers_inactive' : undefined,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
}

/**
 * GET /worker-health/dlq
 * Dead-letter queue status. Shows jobs that have permanently failed.
 */
export async function getDeadLetterQueues(req, res, next) {
  try {
    const health = await workerManager.getHealth();

    if (!health.deadLetterQueues || health.deadLetterQueues.length === 0) {
      return res.json({
        hasPermanentFailures: false,
        timestamp: health.timestamp,
        deadLetterQueues: [],
      });
    }

    res.json({
      hasPermanentFailures: health.deadLetterQueues.length > 0,
      timestamp: health.timestamp,
      deadLetterQueues: health.deadLetterQueues,
      warning: 'Jobs in DLQ require manual intervention. Review errorReason and consider retry or cleanup.',
    });
  } catch (err) {
    next(err);
  }
}
