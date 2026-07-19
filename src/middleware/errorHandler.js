// ============================================================
// Central error handler. Every thrown/rejected error in the request
// lifecycle lands here and is converted into a consistent JSON shape:
//   { error: { message, code?, details? } }
//
// Handles our own AppError, Zod validation errors, and known Prisma
// errors (e.g. unique-constraint violations) — everything else is
// treated as an unexpected 500 and logged.
// ============================================================

import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/AppError.js';
import { isProd } from '../config/env.js';

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
export function errorHandler(err, req, res, next) {
  // 1) Our own operational errors
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: { message: err.message, code: err.code, details: err.details },
    });
  }

  // 2) Zod validation errors (defensive — validate middleware catches most)
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        message: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  // 3) Known Prisma request errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : 'field';
      return res.status(409).json({
        error: { message: `A record with that ${target} already exists`, code: 'UNIQUE_VIOLATION' },
      });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({
        error: { message: 'Record not found', code: 'NOT_FOUND' },
      });
    }
  }

  // 4) Anything else — unexpected. Log and return a generic 500.
  console.error('Unhandled error:', err);
  return res.status(500).json({
    error: {
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
      ...(isProd ? {} : { details: err.message }),
    },
  });
}
