// ============================================================
// Health check. `/health` is a cheap liveness probe; it also pings
// the database so a green response means "app is up AND can reach PG".
// ============================================================

import { Router } from 'express';
import { prisma } from '../../config/prisma.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    let database = 'up';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }

    const healthy = database === 'up';
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      service: 'pingone-backend',
      database,
      uptime: process.uptime(),
    });
  })
);

export default router;
