// ============================================================
//   GET /analytics/dashboard
// Returns aggregate counts only — no chart rendering, that's a
// frontend concern.
// ============================================================

import { Router } from 'express';
import { prisma } from '../../config/prisma.js';
import { authenticate } from '../../middleware/authenticate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { MESSAGE_STATUS } from '../../constants/codes.js';

const router = Router();
router.use(authenticate);

router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    // Scope to this user's jobs only.
    const deliveries = await prisma.messageDelivery.findMany({
      where: { job: { userId } },
      select: { status: { select: { code: true } }, platform: { select: { code: true } } },
    });

    const total = deliveries.length;
    const countByStatus = {};
    const countByPlatform = {};

    for (const d of deliveries) {
      countByStatus[d.status.code] = (countByStatus[d.status.code] ?? 0) + 1;
      countByPlatform[d.platform.code] = (countByPlatform[d.platform.code] ?? 0) + 1;
    }

    const delivered = (countByStatus[MESSAGE_STATUS.DELIVERED] ?? 0) + (countByStatus[MESSAGE_STATUS.SENT] ?? 0);
    const successRate = total > 0 ? Number(((delivered / total) * 100).toFixed(1)) : 0;

    res.status(200).json({
      totalMessages: total,
      pending: countByStatus[MESSAGE_STATUS.PENDING] ?? 0,
      failed: countByStatus[MESSAGE_STATUS.FAILED] ?? 0,
      successRate,
      ...countByPlatform, // { telegram: 620, gmail: 410, sms: 150, whatsapp: 70 }
    });
  })
);

export default router;
