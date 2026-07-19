// ============================================================
// validate — request validation middleware backed by Zod.
// Pass a schema keyed by the request parts you want to check:
//
//   router.post('/', validate({ body: registerSchema }), handler)
//
// Parsed (and coerced) values replace req.body / req.query / req.params
// so downstream handlers get clean, typed data. Invalid input becomes a
// 400 with per-field details.
// ============================================================

import { AppError } from '../utils/AppError.js';

export const validate = (schemas) => (req, res, next) => {
  try {
    for (const key of ['body', 'query', 'params']) {
      if (schemas[key]) {
        req[key] = schemas[key].parse(req[key]);
      }
    }
    next();
  } catch (err) {
    if (err.issues) {
      return next(
        AppError.badRequest('Validation failed', {
          code: 'VALIDATION_ERROR',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      );
    }
    next(err);
  }
};
