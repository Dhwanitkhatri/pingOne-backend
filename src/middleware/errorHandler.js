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
import multer from 'multer';
import { AppError } from '../utils/AppError.js';
import { env, isProd } from '../config/env.js';

// `next` is unused but MUST be declared: Express identifies error middleware
// by arity, and a 3-arg version would silently never be called.
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

  // 4) File-upload errors (multer) — always the client's doing.
  if (err instanceof multer.MulterError) {
    // The two upload routes have different caps, so report the one that applies
    // to the request that actually failed rather than a single hardcoded limit.
    const limitMb = req.path.includes('/attachments')
      ? env.ATTACHMENT_MAX_UPLOAD_MB
      : env.CSV_MAX_UPLOAD_MB;

    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `That file is too large — the limit is ${limitMb} MB`
        : err.code === 'LIMIT_FILE_COUNT'
          ? `Too many files — you can attach up to ${env.ATTACHMENT_MAX_FILES} files at once, ${env.ATTACHMENT_MAX_UPLOAD_MB} MB each`
          : err.code === 'LIMIT_UNEXPECTED_FILE'
            ? `Unexpected file field "${err.field}"`
            : `Upload failed: ${err.message}`;

    return res.status(400).json({ error: { message, code: err.code } });
  }

  // 5) Malformed JSON body — express.json() throws a SyntaxError with a
  // status, which would otherwise be reported as an internal error.
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: { message: 'Request body is not valid JSON', code: 'INVALID_JSON' },
    });
  }

  // 6) Anything else — unexpected. Log and return a generic 500.
  console.error('Unhandled error:', err);
  return res.status(500).json({
    error: {
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
      ...(isProd ? {} : { details: err.message }),
    },
  });
}
