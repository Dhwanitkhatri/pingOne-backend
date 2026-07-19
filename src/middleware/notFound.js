// ============================================================
// 404 handler for unmatched routes. Placed after all routers so any
// request that reaches it hit no endpoint. Forwards to the error
// handler for a consistent JSON response.
// ============================================================

import { AppError } from '../utils/AppError.js';

export function notFound(req, res, next) {
  next(AppError.notFound(`Cannot ${req.method} ${req.originalUrl}`, { code: 'ROUTE_NOT_FOUND' }));
}
