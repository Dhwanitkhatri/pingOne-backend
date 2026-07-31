// ============================================================
// Local-disk storage for message attachments.
//
// Files land in UPLOAD_DIR/attachments/<uuid><ext> and are served back over
// HTTP as PUBLIC_BASE_URL/uploads/attachments/<uuid><ext>. Swapping this for
// S3/R2 later means reimplementing the three exported functions and nothing
// else — no caller touches the filesystem directly.
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
 * Reads from disk when the URL is one of ours — which also means attachments
 * work in local dev where PUBLIC_BASE_URL isn't reachable from outside. Falls
 * back to an HTTP fetch so already-stored remote URLs keep working after a
 * migration to object storage.
 */
export async function readAttachmentBytes(attachment) {
  const localName = toLocalStoredName(attachment.fileUrl);

  if (localName) {
    try {
      return await fs.readFile(path.join(attachmentDir, localName));
    } catch (err) {
      throw new AppError(500, `Attachment "${attachment.fileName}" is missing from storage`, {
        code: 'ATTACHMENT_FILE_MISSING',
        details: err.message,
      });
    }
  }

  const res = await fetch(attachment.fileUrl);
  if (!res.ok) {
    throw new AppError(500, `Could not download attachment "${attachment.fileName}"`, {
      code: 'ATTACHMENT_FETCH_FAILED',
      details: `${res.status} ${res.statusText}`,
    });
  }
  return Buffer.from(await res.arrayBuffer());
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
