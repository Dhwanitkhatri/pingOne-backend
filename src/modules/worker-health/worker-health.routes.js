// ============================================================
// Worker Health Routes (mounted at /api/v1/worker-health when
// running the worker process).
//
// These endpoints are only available when the worker process is running.
// They provide detailed health checks and queue status for monitoring
// and debugging.
//
// GET  /worker-health              comprehensive status of all workers
// GET  /worker-health/:workerName  single worker status
// GET  /worker-health/live         kubernetes liveness probe
// GET  /worker-health/ready        kubernetes readiness probe
// GET  /worker-health/dlq          dead-letter queue status
// ============================================================

import { Router } from 'express';
import * as controller from './worker-health.controller.js';
import { authenticate } from '../../middleware/authenticate.js';

const router = Router();

// All health check endpoints require authentication (optional: can be made public)
router.use(authenticate);

// Main health endpoint
router.get('/', controller.getWorkerHealth);

// Kubernetes-style probes (lightweight, no auth variant could be added)
router.get('/live', controller.getLiveness);
router.get('/ready', controller.getReadiness);

// Dead-letter queue status
router.get('/dlq', controller.getDeadLetterQueues);

// Single worker status (must come after /live, /ready, /dlq to avoid route conflicts)
router.get('/:workerName', controller.getWorkerStatus);

export default router;
