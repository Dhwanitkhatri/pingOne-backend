// ============================================================
// Message attachments — upload, list, delete.
//
// Files go to disk via utils/fileStorage; this module owns the
// MessageAttachment rows and the mapping from a MIME type to a seeded
// file_types row.
//
// Attachments are immutable once a message has been sent: they're part of the
// delivery record, and rewriting them would make delivery_status_logs describe
// something that no longer exists. Deletes are therefore refused for messages
// with deliveries.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { saveAttachment, deleteAttachment, readAttachmentBytes } from '../../utils/fileStorage.js';

const publicAttachmentSelect = {
  id: true,
  messageId: true,
  fileName: true,
  fileUrl: true,
  fileSizeBytes: true,
  createdAt: true,
  fileType: { select: { code: true, mimePrefix: true } },
};

/** file_types is a 5-row reference table — cache it after the first read. */
let fileTypeCache = null;

/**
 * Attach one or more uploaded files to a message.
 * @param {number} userId
 * @param {number} messageId
 * @param {Array<{buffer: Buffer, originalname: string, mimetype: string}>} files
 */
export async function addAttachments(userId, messageId, files) {
  await assertMessageOwnership(userId, messageId);

  const written = [];
  try {
    for (const file of files) {
      const fileTypeId = await resolveFileTypeId(file.mimetype);
      const stored = await saveAttachment(file);
      written.push({ ...stored, fileTypeId });
    }

    return prisma.$transaction(
      written.map((row) =>
        prisma.messageAttachment.create({
          data: { messageId, ...row },
          select: publicAttachmentSelect,
        })
      )
    );
  } catch (err) {
    // A file on disk with no row pointing at it is invisible and unreclaimable,
    // so undo the writes if the insert fails partway through.
    await Promise.all(written.map((row) => deleteAttachment(row.fileUrl)));
    throw err;
  }
}

export async function listAttachments(userId, messageId) {
  await assertMessageOwnership(userId, messageId);

  return prisma.messageAttachment.findMany({
    where: { messageId },
    select: publicAttachmentSelect,
    orderBy: { id: 'asc' },
  });
}

export async function removeAttachment(userId, messageId, attachmentId) {
  await assertMessageOwnership(userId, messageId);

  const attachment = await prisma.messageAttachment.findFirst({
    where: { id: attachmentId, messageId },
  });
  if (!attachment) throw AppError.notFound('Attachment not found');

  const sentCount = await prisma.messageDelivery.count({
    where: { job: { messageId } },
  });
  if (sentCount > 0) {
    throw AppError.badRequest(
      "This message has already been sent — its attachments are part of the delivery record and can't be removed",
      { code: 'MESSAGE_ALREADY_SENT' }
    );
  }

  await prisma.messageAttachment.delete({ where: { id: attachmentId } });
  await deleteAttachment(attachment.fileUrl);

  return { message: 'Attachment deleted successfully' };
}

/**
 * Load a message's attachments with their bytes, ready to hand to an adapter.
 * Called once per delivery by the worker.
 *
 * Reading every file into memory is fine at the sizes this accepts
 * (ATTACHMENT_MAX_UPLOAD_MB × ATTACHMENT_MAX_FILES); revisit if those caps grow.
 */
export async function loadAttachmentsForSend(messageId) {
  const attachments = await prisma.messageAttachment.findMany({
    where: { messageId },
    select: publicAttachmentSelect,
    orderBy: { id: 'asc' },
  });

  return Promise.all(
    attachments.map(async (attachment) => ({
      fileName: attachment.fileName,
      fileUrl: attachment.fileUrl,
      fileSizeBytes: attachment.fileSizeBytes,
      typeCode: attachment.fileType.code,
      mimeType: mimeTypeFor(attachment),
      buffer: await readAttachmentBytes(attachment),
    }))
  );
}

// ---- internal helpers ----------------------------------------------

async function assertMessageOwnership(userId, messageId) {
  const message = await prisma.message.findFirst({
    where: { id: messageId, userId },
    select: { id: true },
  });
  if (!message) throw AppError.notFound('Message not found', { code: 'MESSAGE_NOT_FOUND' });
}

/**
 * Map a MIME type onto a file_types row using its mimePrefix, longest match
 * first — so `application/pdf` picks the `pdf` row rather than the generic
 * `application/` one that `document` registers.
 */
async function resolveFileTypeId(mimeType) {
  if (!fileTypeCache) {
    fileTypeCache = await prisma.fileType.findMany();
    fileTypeCache.sort((a, b) => b.mimePrefix.length - a.mimePrefix.length);
  }

  const match = fileTypeCache.find((type) => mimeType.startsWith(type.mimePrefix));
  if (!match) {
    throw AppError.badRequest(`No file type is configured for "${mimeType}"`, {
      code: 'UNSUPPORTED_FILE_TYPE',
    });
  }
  return match.id;
}

/**
 * Best-effort MIME type for an outbound send. We store the file_types prefix
 * rather than the exact type the client sent, so reconstruct from the extension
 * where it matters and fall back to the prefix (already a full type for pdf) or
 * octet-stream.
 */
function mimeTypeFor(attachment) {
  const ext = attachment.fileName.split('.').pop()?.toLowerCase() ?? '';
  const byExtension = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    txt: 'text/plain',
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  }[ext];

  if (byExtension) return byExtension;
  return attachment.fileType.mimePrefix.endsWith('/')
    ? `${attachment.fileType.mimePrefix}octet-stream`
    : attachment.fileType.mimePrefix;
}

/** Test hook — clears the memoised file_types table. */
export function clearFileTypeCache() {
  fileTypeCache = null;
}
