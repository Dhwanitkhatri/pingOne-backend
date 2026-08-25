// ============================================================
// Worker Manager — centralized graceful shutdown, health status,
// and worker registry. Orchestrates clean shutdown of all workers
// and provides health check endpoints.
// ============================================================

/**
 * Registry of active workers. Used for:
 * - Health checks (query status of each worker)
 * - Graceful shutdown (close all cleanly)
 * - Metrics (concurrency, queue sizes, etc.)
 */
class WorkerManager {
  constructor() {
    this.workers = new Map();
    this.isShuttingDown = false;
    this.shutdownTimeout = 30_000; // 30 seconds to gracefully close all jobs
  }

  /**
   * Register a worker and its associated queue.
   * @param {string} name - Unique worker name (e.g. 'delivery', 'retry', 'scheduler')
   * @param {Worker} worker - BullMQ Worker instance
   * @param {Queue} queue - BullMQ Queue instance
   * @param {boolean} [isDurable] - Whether this worker is long-running (default: true)
   */
  register(name, worker, queue, isDurable = true) {
    if (this.workers.has(name)) {
      throw new Error(`Worker "${name}" already registered`);
    }

    this.workers.set(name, {
      name,
      worker,
      queue,
      isDurable,
      startedAt: new Date(),
      jobsCompleted: 0,
      jobsFailed: 0,
      isActive: true,
    });

    console.log(`[worker-manager] registered worker: ${name}`);
  }

  /**
   * Safely read queue counts from BullMQ queue objects or fall back to zeros.
   * Some scheduler entries are lightweight pseudo-queues that may not expose the
   * same API surface as a full BullMQ queue.
   * @param {object} entry - Worker registry entry
   * @returns {Promise<object>} Queue counts object
   */
  async getQueueCounts(entry) {
    if (!entry || !entry.queue) {
      return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    }

    if (typeof entry.queue.getCountsPerStatus === 'function') {
      const counts = await entry.queue.getCountsPerStatus();
      return {
        waiting: counts?.waiting || 0,
        active: counts?.active || 0,
        completed: counts?.completed || 0,
        failed: counts?.failed || 0,
        delayed: counts?.delayed || 0,
      };
    }

    if (typeof entry.worker?.getMetrics === 'function') {
      const metrics = await entry.worker.getMetrics();
      return {
        waiting: metrics?.waiting || 0,
        active: metrics?.active || 0,
        completed: metrics?.completed || 0,
        failed: metrics?.failed || 0,
        delayed: metrics?.delayed || 0,
      };
    }

    return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  }

  /**
   * Get status snapshot of a single worker.
   * @param {string} name - Worker name
   * @returns {object} Status object with queue stats
   */
  async getWorkerStatus(name) {
    const entry = this.workers.get(name);
    if (!entry) return null;

    try {
      const counts = await this.getQueueCounts(entry);
      const waitingCount = counts.waiting || 0;
      const activeCount = counts.active || 0;
      const completedCount = counts.completed || 0;
      const failedCount = counts.failed || 0;
      const delayedCount = counts.delayed || 0;

      return {
        name: entry.name,
        status: entry.isActive ? 'active' : 'inactive',
        uptime: Date.now() - entry.startedAt.getTime(),
        queue: {
          waiting: waitingCount,
          active: activeCount,
          completed: completedCount,
          failed: failedCount,
          delayed: delayedCount,
          total: waitingCount + activeCount + completedCount + failedCount + delayedCount,
        },
        stats: {
          jobsCompleted: entry.jobsCompleted,
          jobsFailed: entry.jobsFailed,
        },
      };
    } catch (err) {
      return {
        name: entry.name,
        status: 'error',
        error: err.message,
      };
    }
  }

  /**
   * Get health status of all workers.
   * @returns {object} Aggregated health status
   */
  async getHealth() {
    const workerStatuses = [];
    const deadLetterQueues = [];

    for (const [name] of this.workers) {
      const status = await this.getWorkerStatus(name);
      workerStatuses.push(status);

      // Check for dead-letter queue
      const dlqEntry = this.workers.get(`${name}:dlq`);
      if (dlqEntry) {
        const dlqStatus = await this.getWorkerStatus(`${name}:dlq`);
        deadLetterQueues.push(dlqStatus);
      }
    }

    const allOk = workerStatuses.every((s) => s.status === 'active' || s.status === 'inactive');

    return {
      timestamp: new Date().toISOString(),
      isHealthy: allOk && !this.isShuttingDown,
      isShuttingDown: this.isShuttingDown,
      workers: workerStatuses,
      deadLetterQueues: deadLetterQueues.length > 0 ? deadLetterQueues : undefined,
      summary: {
        totalWorkers: workerStatuses.length,
        activeWorkers: workerStatuses.filter((s) => s.status === 'active').length,
        totalWaiting: workerStatuses.reduce((sum, s) => sum + (s.queue?.waiting || 0), 0),
        totalActive: workerStatuses.reduce((sum, s) => sum + (s.queue?.active || 0), 0),
        totalCompleted: workerStatuses.reduce((sum, s) => sum + (s.stats?.jobsCompleted || 0), 0),
        totalFailed: workerStatuses.reduce((sum, s) => sum + (s.stats?.jobsFailed || 0), 0),
      },
    };
  }

  /**
   * Record job completion in the registry.
   * @param {string} workerName - Worker name
   */
  recordJobCompleted(workerName) {
    const entry = this.workers.get(workerName);
    if (entry) entry.jobsCompleted += 1;
  }

  /**
   * Record job failure in the registry.
   * @param {string} workerName - Worker name
   */
  recordJobFailed(workerName) {
    const entry = this.workers.get(workerName);
    if (entry) entry.jobsFailed += 1;
  }

  /**
   * Mark a worker as inactive (e.g., if it crashes).
   * @param {string} name - Worker name
   */
  markInactive(name) {
    const entry = this.workers.get(name);
    if (entry) {
      entry.isActive = false;
      console.warn(`[worker-manager] marked worker "${name}" as inactive`);
    }
  }

  /**
   * Gracefully shut down all workers. Waits up to `shutdownTimeout` for
   * in-flight jobs to complete, then closes connections.
   *
   * Flow:
   * 1. Mark as shutting down (reject new job accepts)
   * 2. Close all workers (in-flight jobs continue to completion)
   * 3. Wait for all jobs to finish (with timeout)
   * 4. Close all queues
   * 5. Close Redis connection
   */
  async gracefulShutdown(connection) {
    if (this.isShuttingDown) {
      console.warn('[worker-manager] shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    console.log('[worker-manager] initiating graceful shutdown...');

    try {
      // Step 1: Close all workers (stops accepting new jobs, allows in-flight to finish)
      const closePromises = [];
      for (const [, entry] of this.workers) {
        console.log(`[worker-manager] closing worker: ${entry.name}`);
        closePromises.push(entry.worker.close());
      }
      await Promise.all(closePromises);

      // Step 2: Wait for all in-flight jobs to complete (with timeout)
      console.log(`[worker-manager] waiting up to ${this.shutdownTimeout / 1000}s for jobs to finish...`);
      const startTime = Date.now();
      let allDone = false;

      while (Date.now() - startTime < this.shutdownTimeout && !allDone) {
        allDone = true;
        for (const [, entry] of this.workers) {
          const counts = await this.getQueueCounts(entry);
          if (counts.active > 0) {
            allDone = false;
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.log(`[worker-manager] ${elapsed}s: ${entry.name} has ${counts.active} active job(s)`);
            break;
          }
        }
        if (!allDone) {
          await new Promise((r) => setTimeout(r, 1000)); // check every 1s
        }
      }

      if (!allDone) {
        console.warn('[worker-manager] shutdown timeout: some jobs did not complete');
      } else {
        console.log('[worker-manager] all jobs completed successfully');
      }

      // Step 3: Close all queues
      const queueClosePromises = [];
      for (const [, entry] of this.workers) {
        console.log(`[worker-manager] closing queue: ${entry.name}`);
        queueClosePromises.push(entry.queue.close());
      }
      await Promise.all(queueClosePromises);

      // Step 4: Close Redis connection
      if (connection) {
        console.log('[worker-manager] closing Redis connection');
        await connection.quit();
      }

      console.log('[worker-manager] graceful shutdown complete');
    } catch (err) {
      console.error('[worker-manager] error during shutdown:', err);
      process.exit(1);
    }
  }
}

// Singleton instance
export const workerManager = new WorkerManager();
