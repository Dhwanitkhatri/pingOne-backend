// ============================================================
// Message controllers — translate HTTP <-> service calls.
// Controllers stay thin; business logic lives in the service.
// ============================================================

import * as messageService from "./messages.service.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

/**
 * POST /messages
 */
export const createMessage = asyncHandler(async (req, res) => {
  const message = await messageService.createMessage({
    userId: req.user.id,
    ...req.body,
  });

  res.status(201).json({
    message: "Message created successfully",
    data: message,
  });
});

/**
 * GET /messages
 */
export const getMessages = asyncHandler(async (req, res) => {
  const messages = await messageService.getMessages(req.user.id);

  res.status(200).json({
    data: messages,
  });
});

/**
 * GET /messages/:id
 */
export const getMessageById = asyncHandler(async (req, res) => {
  const message = await messageService.getMessageById(
    Number(req.params.id),
    req.user.id
  );

  res.status(200).json({
    data: message,
  });
});

/**
 * PATCH /messages/:id
 */
export const updateMessage = asyncHandler(async (req, res) => {
  const message = await messageService.updateMessage({
    messageId: Number(req.params.id),
    userId: req.user.id,
    ...req.body,
  });

  res.status(200).json({
    message: "Message updated successfully",
    data: message,
  });
});

/**
 * DELETE /messages/:id
 */
export const deleteMessage = asyncHandler(async (req, res) => {
  await messageService.deleteMessage(
    Number(req.params.id),
    req.user.id
  );

  res.status(200).json({
    message: "Message deleted successfully",
  });
});