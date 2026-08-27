// ============================================================
// Message Routes
//
// POST    /messages/send                            send now, or schedule
// POST    /messages
// GET     /messages
// GET     /messages/:id
// PATCH   /messages/:id
// DELETE  /messages/:id
//
// POST    /messages/:id/attachments                 multipart, field "files"
// GET     /messages/:id/attachments
// DELETE  /messages/:id/attachments/:attachmentId
//
// All routes require authentication.
// ============================================================

import { Router } from "express";

import * as messageController from "./messages.controlller.js";
import * as attachmentController from "./attachments.controller.js";

import { authenticate } from "../../middleware/authenticate.js";
import { validate } from "../../middleware/validate.js";
import { uploadAttachments } from "../../middleware/upload.js";

import {
  createMessageSchema,
  updateMessageSchema,
} from "./messages.schema.js";
// Sending is a scheduler concern (it creates a ScheduledJob), so its schema
// lives with the scheduler even though the route reads as a message action.
import { sendMessageSchema } from "../scheduler/scheduler.schema.js";

const router = Router();

// Protect every route
router.use(authenticate);

// Send or schedule — registered before "/" so the literal path wins.
router.post(
  "/send",
  validate({ body: sendMessageSchema }),
  messageController.sendMessage
);

// Create
router.post(
  "/",
  validate({ body: createMessageSchema }),
  messageController.createMessage
);

// Get all
router.get(
  "/",
  messageController.getMessages
);

// Get by id
router.get(
  "/:id",
  messageController.getMessageById
);

// Update
router.patch(
  "/:id",
  validate({ body: updateMessageSchema }),
  messageController.updateMessage
);

// Delete
router.delete(
  "/:id",
  messageController.deleteMessage
);

// ---- attachments ----------------------------------------------------

router.post(
  "/:id/attachments",
  uploadAttachments("files"),
  attachmentController.addAttachments
);

router.get(
  "/:id/attachments",
  attachmentController.listAttachments
);

router.delete(
  "/:id/attachments/:attachmentId",
  attachmentController.removeAttachment
);

export default router;