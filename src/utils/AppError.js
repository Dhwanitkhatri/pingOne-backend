// ============================================================
// AppError — operational error with an HTTP status code.
// Thrown anywhere in the request lifecycle and translated into a
// clean JSON response by the central error handler. `isOperational`
// distinguishes expected errors (bad input, not found) from bugs.
// ============================================================

export class AppError extends Error {
  /**
   * @param {number} statusCode  HTTP status (e.g. 400, 401, 404, 409)
   * @param {string} message     Human-readable message safe to return to clients
   * @param {object} [options]
   * @param {string} [options.code]     Stable machine-readable error code
   * @param {unknown} [options.details] Extra context (e.g. validation issues)
   */
  constructor(statusCode, message, { code, details } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, opts) {
    return new AppError(400, message, opts);
  }

  static unauthorized(message = 'Authentication required', opts) {
    return new AppError(401, message, opts);
  }

  static forbidden(message = 'You do not have permission to do that', opts) {
    return new AppError(403, message, opts);
  }

  static notFound(message = 'Resource not found', opts) {
    return new AppError(404, message, opts);
  }

  static conflict(message, opts) {
    return new AppError(409, message, opts);
  }
}
