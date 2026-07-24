// ============================================================
// Message service — business logic for Message CRUD.
// Only authenticated users can manage their own messages.
// ============================================================

import { prisma } from "../../config/prisma.js";
import { AppError } from "../../utils/AppError.js";

// Fields safe to return to the client.
const publicMessageSelect = {
  id: true,
  userId: true,
  templateId: true,
  content: true,
  createdAt: true,
  updatedAt: true,
};

/**
 * Create a new message.
 */
export async function createMessage({ userId, content, templateId = null }) {
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

  await prisma.message.delete({
    where: {
      id: Number(messageId),
    },
  });

  return {
    message: "Message deleted successfully",
  };
}