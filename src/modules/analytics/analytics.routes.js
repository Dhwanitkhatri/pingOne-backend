// ============================================================
// Analytics Routes
//
// GET /analytics/summary          headline counts + status breakdown
// GET /analytics/platform-stats   per-channel performance and top errors
// GET /analytics/delivery-rates   time series, bucketed by day|week|month
// GET /analytics/best-send-times  hour/weekday performance + recommendations
// GET /analytics/dashboard        original flat summary (kept for the frontend)
//
// Every endpoint accepts ?from=&to= (ISO dates, default: trailing 30 days) and
// ?platform=telegram|whatsapp|gmail|sms. All are read-only and scoped to the
// authenticated user — a user can never see another account's numbers.
//
// Aggregate counts only; no chart rendering, that's a frontend concern.
// ============================================================

import { Router } from 'express';

import * as analyticsController from './analytics.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import {
  dateRangeSchema,
  deliveryRatesSchema,
  bestSendTimesSchema,
} from './analytics.schema.js';

const router = Router();
router.use(authenticate);

router.get(
  '/summary',
  validate({ query: dateRangeSchema }),
  analyticsController.getSummary
);

router.get(
  '/platform-stats',
  validate({ query: dateRangeSchema }),
  analyticsController.getPlatformStats
);

router.get(
  '/delivery-rates',
  validate({ query: deliveryRatesSchema }),
  analyticsController.getDeliveryRates
);

router.get(
  '/best-send-times',
  validate({ query: bestSendTimesSchema }),
  analyticsController.getBestSendTimes
);

router.get(
  '/dashboard',
  validate({ query: dateRangeSchema }),
  analyticsController.getDashboard
);

export default router;
