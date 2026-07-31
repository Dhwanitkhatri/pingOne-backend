// ============================================================
// File upload middleware (multer, in-memory).
//
// Two flavours:
//   uploadCsv         — contact imports. Parsed immediately, never persisted.
//   uploadAttachments — message attachments. Persisted via utils/fileStorage.
//
// Both use memory storage. For CSVs that's clearly right (nothing to clean
// up). For attachments it's a deliberate trade: capped at
// ATTACHMENT_MAX_UPLOAD_MB × ATTACHMENT_MAX_FILES per request, it avoids
// orphaned temp files when validation rejects an upload midway. If you raise
// those caps significantly, switch to multer.diskStorage.
//
// Browsers and spreadsheet tools disagree wildly about the MIME type of
// a .csv, so the extension is accepted as evidence too.
// ============================================================

import multer from 'multer';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

const CSV_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'text/plain',
  'text/comma-separated-values',
  'application/vnd.ms-excel',
  'application/octet-stream', // what several browsers send for .csv
]);

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.CSV_MAX_UPLOAD_MB * 1024 * 1024,
    files: 1,
  },
  fileFilter(req, file, cb) {
    const looksLikeCsv =
      CSV_MIME_TYPES.has(file.mimetype) || /\.csv$/i.test(file.originalname ?? '');

    if (!looksLikeCsv) {
      return cb(
        AppError.badRequest('Only .csv files can be imported', {
          code: 'UNSUPPORTED_FILE_TYPE',
          details: { received: file.mimetype },
        })
      );
    }
    cb(null, true);
  },
});

/**
 * Accept one CSV under the `file` field, and require it to be there.
 * Named field so the error message can be specific about what's missing.
 */
export function uploadCsv(fieldName = 'file') {
  const handler = csvUpload.single(fieldName);

  return (req, res, next) =>
    handler(req, res, (err) => {
      if (err) return next(err);
      if (!req.file) {
        return next(
          AppError.badRequest(`No file uploaded — send the CSV as multipart/form-data "${fieldName}"`, {
            code: 'FILE_REQUIRED',
          })
        );
      }
      next();
    });
}

// ---- message attachments -------------------------------------------

/**
 * MIME types accepted as attachments. This is an allowlist, not a blocklist:
 * anything not named here is refused, so a new dangerous type can't slip
 * through by default. Each entry maps to one of the seeded file_types rows
 * via its mime prefix (see attachments.service resolveFileType).
 */
const ATTACHMENT_MIME_PATTERNS = [
  /^image\//,
  /^video\//,
  /^audio\//,
  /^text\/(plain|csv)$/,
  /^application\/pdf$/,
  /^application\/(msword|vnd\.openxmlformats-officedocument\..+|vnd\.ms-.+|rtf)$/,
  /^application\/zip$/,
];

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.ATTACHMENT_MAX_UPLOAD_MB * 1024 * 1024,
    files: env.ATTACHMENT_MAX_FILES,
  },
  fileFilter(req, file, cb) {
    if (!ATTACHMENT_MIME_PATTERNS.some((pattern) => pattern.test(file.mimetype))) {
      return cb(
        AppError.badRequest(`"${file.mimetype}" files can't be attached to a message`, {
          code: 'UNSUPPORTED_FILE_TYPE',
          details: { received: file.mimetype, fileName: file.originalname },
        })
      );
    }
    cb(null, true);
  },
});

/**
 * Accept up to ATTACHMENT_MAX_FILES files under the `files` field, requiring
 * at least one. Multiple attachments per request keeps the client from having
 * to fire N sequential uploads for one message.
 */
export function uploadAttachments(fieldName = 'files') {
  const handler = attachmentUpload.array(fieldName, env.ATTACHMENT_MAX_FILES);

  return (req, res, next) =>
    handler(req, res, (err) => {
      if (err) return next(err);
      if (!req.files?.length) {
        return next(
          AppError.badRequest(
            `No files uploaded — send them as multipart/form-data "${fieldName}"`,
            { code: 'FILE_REQUIRED' }
          )
        );
      }
      next();
    });
}
