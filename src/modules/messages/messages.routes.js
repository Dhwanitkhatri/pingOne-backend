// ============================================================
// Message Routes
//
// POST    /messages
// GET     /messages
// GET     /messages/:id
// PATCH   /messages/:id
// DELETE  /messages/:id
//
// All routes require authentication.
// ============================================================

import { Router } from "express";

import * as messageController from "./messages.controlller.js";

import { authenticate } from "../../middleware/authenticate.js";
import { validate } from "../../middleware/validate.js";

import {
  createMessageSchema,
  updateMessageSchema,
} from "./messages.schema.js";

const router = Router();

// Protect every route
router.use(authenticate);

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

export default router;