// ============================================================
// Analytics controllers. Thin by design — all the aggregation lives in the
// service, and chart rendering is the frontend's job.
// ============================================================

import * as analyticsService from './analytics.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/** GET /analytics/summary */
export const getSummary = asyncHandler(async (req, res) => {
  const data = await analyticsService.getSummary(req.user.id, req.query);
  res.status(200).json({ data });
});

/** GET /analytics/platform-stats */
export const getPlatformStats = asyncHandler(async (req, res) => {
  const data = await analyticsService.getPlatformStats(req.user.id, req.query);
  res.status(200).json({ data });
});

/** GET /analytics/delivery-rates */
export const getDeliveryRates = asyncHandler(async (req, res) => {
  const data = await analyticsService.getDeliveryRates(req.user.id, req.query);
  res.status(200).json({ data });
});

/** GET /analytics/best-send-times */
export const getBestSendTimes = asyncHandler(async (req, res) => {
  const data = await analyticsService.getBestSendTimes(req.user.id, req.query);
  res.status(200).json({ data });
});

/**
 * GET /analytics/dashboard
 * Pre-existing endpoint, unchanged response shape — it returns the flat object
 * the frontend already consumes, not the { data } envelope the others use.
 */
export const getDashboard = asyncHandler(async (req, res) => {
  const data = await analyticsService.getDashboard(req.user.id, req.query);
  res.status(200).json(data);
});
