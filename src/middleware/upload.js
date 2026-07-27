// ============================================================
// File upload middleware (multer, in-memory).
//
// Uploads are small, single-use CSVs that are parsed immediately and
// never persisted, so memory storage is the right trade — no temp files
// to clean up. The size cap comes from CSV_MAX_UPLOAD_MB.
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
