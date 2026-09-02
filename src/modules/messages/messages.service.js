// ============================================================
// Message service — business logic for Message CRUD.
// Only authenticated users can manage their own messages.
// ============================================================

import { prisma } from "../../config/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { deleteAttachment } from "../../utils/fileStorage.js";

// Fields safe to return to the client.
const publicMessageSelect = {
  id: true,
  userId: true,
  templateId: true,
  subject: true,
  content: true,
  createdAt: true,
  updatedAt: true,
  attachments: {
    select: {
      id: true,
      fileName: true,
      fileUrl: true,
      fileSizeBytes: true,
      createdAt: true,
      fileType: { select: { code: true } },
    },
    orderBy: { id: "asc" },
  },
};

/**
 * Create a new message.
 */
export async function createMessage({ userId, subject = null, content, templateId = null }) {
  // Verify template ownership (if provided)
  if (templateId) {
    const template = await prisma.template.findFirst({
      where: {
        id: templateId,
        userId,
      },
      select: {
        id: true,
      },
    });

    if (!template) {
      throw AppError.notFound("Template not found", {
        code: "TEMPLATE_NOT_FOUND",
      });
    }
  }

  const message = await prisma.message.create({
    data: {
      userId,
      subject,
      content,
      templateId,
    },
    select: publicMessageSelect,
  });

  return message;
}

/**
 * Get all messages of the logged-in user.
 */
export async function getMessages(userId) {
  return prisma.message.findMany({
    where: {
      userId,
    },
    select: publicMessageSelect,
    orderBy: {
      createdAt: "desc",
    },
  });
}

/**
 * Get a single message.
 */
export async function getMessageById(messageId, userId) {
  const message = await prisma.message.findFirst({
    where: {
      id: Number(messageId),
      userId,
    },
    select: publicMessageSelect,
  });

  if (!message) {
    throw AppError.notFound("Message not found", {
      code: "MESSAGE_NOT_FOUND",
    });
  }

  return message;
}

/**
 * Update an existing message.
 */
export async function updateMessage({
  messageId,
  userId,
  subject,
  content,
  templateId,
}) {
  const existingMessage = await prisma.message.findFirst({
    where: {
      id: Number(messageId),
      userId,
    },
  });

  if (!existingMessage) {
    throw AppError.notFound("Message not found", {
      code: "MESSAGE_NOT_FOUND",
    });
  }

  // Verify template ownership (if changing template)
  if (templateId) {
    const template = await prisma.template.findFirst({
      where: {
        id: templateId,
        userId,
      },
      select: {
        id: true,
      },
    });

    if (!template) {
      throw AppError.notFound("Template not found", {
        code: "TEMPLATE_NOT_FOUND",
      });
    }
  }

  const updatedMessage = await prisma.message.update({
    where: {
      id: Number(messageId),
    },
    data: {
      ...(content !== undefined && { content }),
      ...(subject !== undefined && { subject }),
      ...(templateId !== undefined && { templateId }),
    },
    select: publicMessageSelect,
  });

  return updatedMessage;
}

export async function deleteMessage(messageId, userId) {
  const existingMessage = await prisma.message.findFirst({
    where: {
      id: Number(messageId),
      userId,
    },
    include: {
      scheduledJobs: { select: { id: true }, take: 1 },
      attachments: { select: { fileUrl: true } },
    },
  });

  if (!existingMessage) {
    throw AppError.notFound("Message not found", {
      code: "MESSAGE_NOT_FOUND",
    });
  }

  if (existingMessage.scheduledJobs.length > 0) {
    throw AppError.badRequest(
      "This message is attached to a scheduled job and can't be deleted. Cancel the schedule first.",
      { code: "MESSAGE_IN_USE" }
    );
  }

  // Attachment rows cascade with the message; their files on disk don't, so
  // clean those up explicitly or they leak. Done after the delete commits —
  // unlinking first would lose the files if the delete then failed.
  await prisma.message.delete({
    where: {
      id: Number(messageId),
    },
  });

  await Promise.all(
    existingMessage.attachments.map((a) => deleteAttachment(a.fileUrl))
  );

  return {
    message: "Message deleted successfully",
  };
}