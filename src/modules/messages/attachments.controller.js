// ============================================================
// Attachment controllers — thin HTTP <-> service translation, matching
// messages.controller.js.
// ============================================================

import * as attachmentService from './attachments.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/** POST /messages/:id/attachments — multipart upload, field name "files". */
export const addAttachments = asyncHandler(async (req, res) => {
  const attachments = await attachmentService.addAttachments(
    req.user.id,
    Number(req.params.id),
    req.files
  );

  res.status(201).json({
    message: `${attachments.length} attachment(s) uploaded successfully`,
    data: attachments,
  });
});

/** GET /messages/:id/attachments */
export const listAttachments = asyncHandler(async (req, res) => {
  const attachments = await attachmentService.listAttachments(
    req.user.id,
    Number(req.params.id)
  );

  res.status(200).json({ data: attachments });
});

/** DELETE /messages/:id/attachments/:attachmentId */
export const removeAttachment = asyncHandler(async (req, res) => {
  const result = await attachmentService.removeAttachment(
    req.user.id,
    Number(req.params.id),
    Number(req.params.attachmentId)
  );

  res.status(200).json(result);
});
