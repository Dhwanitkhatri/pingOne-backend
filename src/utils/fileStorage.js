// ============================================================
// Disk-backed storage for message attachments.
//
// Files land in UPLOAD_DIR/attachments/<uuid><ext> and are served back over
// HTTP as PUBLIC_BASE_URL/uploads/attachments/<uuid><ext>. Swapping this for
// S3/R2 later means reimplementing the three exported functions and nothing
// else — no caller touches the filesystem directly.
//
// IN PRODUCTION UPLOAD_DIR MUST POINT AT A RENDER PERSISTENT DISK
// (e.g. /var/data/uploads). Render's default filesystem is ephemeral: it is
// rebuilt on every deploy, restart and crash, so an attachment written there
// is gone by the time a scheduled job fires hours later. See render.yaml.
//
// Only the API service mounts that disk — a Render disk can be attached to
// exactly ONE service, and the delivery worker is a second one. So the worker
// cannot read these files from its own filesystem and reaches them over HTTP
// instead; readAttachmentBytes below handles both processes transparently.
//
// Security note: the stored filename is always a fresh UUID plus a whitelisted
// extension. The client's original filename is kept in the DB for display only
// and never reaches the filesystem, so `../../etc/passwd` and friends have
// nothing to traverse.
// ============================================================

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { env } from '../config/env.js';
import { AppError } from './AppError.js';

const ATTACHMENT_SUBDIR = 'attachments';
const PUBLIC_MOUNT = '/uploads'; // must match the express.static mount in app.js

const attachmentDir = path.resolve(process.cwd(), env.UPLOAD_DIR, ATTACHMENT_SUBDIR);

/** Absolute path of the attachment directory — app.js serves this statically. */
export const uploadRoot = path.resolve(process.cwd(), env.UPLOAD_DIR);

/**
 * Only these extensions are ever written to disk. Anything else gets a generic
 * `.bin`, so an upload can't land as .js/.php/.html and be served back as
 * something executable or script-injectable.
 */
// .svg is deliberately absent: an SVG is a script-carrying document, and one
// served from our own origin is a stored-XSS vector. SVG uploads still work,
// they just land as .bin (which changes nothing about how they're sent —
// adapters carry the MIME type separately).
const SAFE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.rtf',
  '.mp3', '.wav', '.ogg', '.m4a', '.aac',
  '.mp4', '.mov', '.webm', '.avi', '.mkv',
  '.zip',
]);

/**
 * Write one uploaded buffer to disk.
 * @param {{buffer: Buffer, originalname: string}} file a multer memory-storage file
 * @returns {Promise<{fileName: string, fileUrl: string, fileSizeBytes: number}>}
 */
export async function saveAttachment(file) {
  await fs.mkdir(attachmentDir, { recursive: true });

  const ext = safeExtension(file.originalname);
  const storedName = `${randomUUID()}${ext}`;

  await fs.writeFile(path.join(attachmentDir, storedName), file.buffer);

  return {
    fileName: file.originalname, // shown to users; never used as a path
    fileUrl: `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}${PUBLIC_MOUNT}/${ATTACHMENT_SUBDIR}/${storedName}`,
    fileSizeBytes: file.buffer.length,
  };
}

/**
 * Load an attachment's bytes. Adapters that upload media directly (Gmail MIME,
 * Telegram multipart, WhatsApp /media) need the actual content, not a link.
 *
 * Tries the local disk first — that's the fast path in the API process and in
 * local dev, where PUBLIC_BASE_URL isn't reachable from outside anyway. When
 * the file isn't on THIS process's filesystem it falls back to an HTTP fetch,
 * which is what makes the delivery worker work: the disk belongs to the API
 * service, so from the worker every attachment is simply a remote URL. The
 * same fallback covers already-stored remote URLs after a future move to
 * object storage.
 */
export async function readAttachmentBytes(attachment) {
  const localName = toLocalStoredName(attachment.fileUrl);

  if (localName) {
    try {
      return await fs.readFile(path.join(attachmentDir, localName));
    } catch (err) {
      // ENOENT here is expected in the worker and only there. Anything else
      // (EACCES, EIO — a disk that failed to mount) is a real fault worth
      // reporting rather than papering over with a network round-trip.
      if (err.code !== 'ENOENT') {
        throw new AppError(500, `Attachment "${attachment.fileName}" could not be read from storage`, {
          code: 'ATTACHMENT_FILE_UNREADABLE',
          details: err.message,
        });
      }
    }
  }

  return fetchAttachmentBytes(attachment);
}

/**
 * Remove an attachment's file. Never throws on a missing file — the DB row is
 * the source of truth, and a delete that already happened isn't an error.
 */
export async function deleteAttachment(fileUrl) {
  const localName = toLocalStoredName(fileUrl);
  if (!localName) return false;

  try {
    await fs.unlink(path.join(attachmentDir, localName));
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[storage] failed to unlink attachment:', err.message);
    return false;
  }
}

// ---- internal helpers ----------------------------------------------

/** How long a single attachment download may take before a delivery gives up. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Download an attachment over HTTP. The worker's normal read path.
 *
 * A 404 on one of our OWN urls is the signature of an ephemeral filesystem
 * eating the upload, so it gets its own message — that's a deployment problem
 * (UPLOAD_DIR not on the persistent disk), not a bad attachment.
 */
async function fetchAttachmentBytes(attachment) {
  const isOurs = toLocalStoredName(attachment.fileUrl) !== null;

  let res;
  try {
    res = await fetch(attachment.fileUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new AppError(500, `Could not download attachment "${attachment.fileName}"`, {
      code: 'ATTACHMENT_FETCH_FAILED',
      details: err.name === 'TimeoutError' ? `timed out after ${FETCH_TIMEOUT_MS}ms` : err.message,
    });
  }

  if (!res.ok) {
    if (isOurs && res.status === 404) {
      throw new AppError(500, `Attachment "${attachment.fileName}" is missing from storage`, {
        code: 'ATTACHMENT_FILE_MISSING',
        details:
          'The file is not on the API service any more. Check that UPLOAD_DIR points at the mounted persistent disk.',
      });
    }
    throw new AppError(500, `Could not download attachment "${attachment.fileName}"`, {
      code: 'ATTACHMENT_FETCH_FAILED',
      details: `${res.status} ${res.statusText}`,
    });
  }

  return Buffer.from(await res.arrayBuffer());
}

function safeExtension(originalName = '') {
  const ext = path.extname(originalName).toLowerCase();
  return SAFE_EXTENSIONS.has(ext) ? ext : '.bin';
}

/**
 * Extract the stored filename if this URL points at our own attachment mount.
 * Returns null for anything else. basename() strips any traversal attempt in a
 * URL that came from the database.
 */
function toLocalStoredName(fileUrl) {
  const marker = `${PUBLIC_MOUNT}/${ATTACHMENT_SUBDIR}/`;
  const index = fileUrl?.indexOf(marker) ?? -1;
  if (index === -1) return null;

  const name = path.basename(fileUrl.slice(index + marker.length).split(/[?#]/)[0]);
  return name || null;
}
