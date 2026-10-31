// ============================================================
// One-delivery send pipeline, separated from BullMQ worker startup so it can
// be exercised with a fake database and provider client.
// ============================================================

import { prisma } from '../config/prisma.js';
import { getDeliveryAdapter } from '../platforms/adapter.registry.js';
import { resolveRecipientHandle } from '../modules/scheduler/recipient-resolver.js';
import { transitionStatus } from '../modules/deliveries/delivery-status.service.js';
import { loadAttachmentsForSend } from '../modules/messages/attachments.service.js';
import { personalizeForContact } from '../modules/templates/templates.service.js';
import { CONTACT_VARIABLE_INCLUDE } from '../modules/templates/contact-fields.js';
import { MESSAGE_STATUS, CHANGED_BY } from '../constants/codes.js';
import * as platformsService from '../modules/platforms/platforms.service.js';

const ALREADY_CONFIRMED = new Set([MESSAGE_STATUS.DELIVERED, MESSAGE_STATUS.READ]);

export async function processDeliveryJob(
  job,
  {
    db = prisma,
    adapterResolver = getDeliveryAdapter,
    recipientResolver = resolveRecipientHandle,
    credentialResolver = platformsService.getDecryptedCredential,
    attachmentLoader = loadAttachmentsForSend,
    personalize = personalizeForContact,
    transition = transitionStatus,
    onFailure,
  } = {}
) {
  const { deliveryId } = job.data;
  const delivery = await db.messageDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      contact: { include: CONTACT_VARIABLE_INCLUDE },
      platform: true,
      status: true,
      job: {
        include: {
          message: { include: { template: { include: { variables: true } } } },
          user: true,
        },
      },
    },
  });

  if (!delivery) {
    console.warn(`[delivery] MessageDelivery ${deliveryId} no longer exists, skipping`);
    return;
  }

  if (ALREADY_CONFIRMED.has(delivery.status.code)) {
    console.warn(
      `[delivery] delivery ${deliveryId} is already ${delivery.status.code}, not re-sending`
    );
    return;
  }

  await transition({
    deliveryId,
    toCode: MESSAGE_STATUS.SENDING,
    changedBy: CHANGED_BY.SYSTEM,
    force: true,
  });

  try {
    const adapter = adapterResolver(delivery.platform.code);
    const credential = adapter.constructor.requiresUserCredential === false
      ? null
      : await credentialResolver(delivery.job.userId, delivery.platform.code);
    const handle = await recipientResolver(
      delivery.contactId,
      delivery.platformId,
      delivery.platform.code
    );
    const attachments = await attachmentLoader(delivery.job.messageId);
    const content = personalize(
      delivery.job.message.content,
      delivery.job.message.template?.variables,
      delivery.contact
    );
    const formatted = adapter.formatMessage(content, attachments);
    const result = await adapter.send(
      credential,
      { handle },
      formatted,
      delivery.job.message.subject ?? undefined
    );

    await transition({
      deliveryId,
      toCode: MESSAGE_STATUS.SENT,
      changedBy: CHANGED_BY.SYSTEM,
      errorReason: null,
      data: { platformMessageId: result.platformMessageId, retryCount: 0 },
    });
  } catch (err) {
    if (!onFailure) throw err;
    await onFailure(delivery, err);
  }
}
