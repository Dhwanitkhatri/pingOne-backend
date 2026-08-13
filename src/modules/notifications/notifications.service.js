// Durable notification service. A Notification row is the in-app/push payload;
// email is additionally sent when the account opted into failure alerts.

import { prisma } from '../../config/prisma.js';
import { sendPermanentFailureEmail } from '../../utils/mailer.js';

export function listNotifications(userId) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function markRead(userId, notificationId) {
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { readAt: new Date() },
  });
  return result.count > 0;
}

export async function notifyPermanentFailure(delivery, { attempts, reason }) {
  const user = delivery.job.user;
  const contactName = [delivery.contact.firstName, delivery.contact.lastName].filter(Boolean).join(' ');
  const platform = delivery.platform.name;
  const recipient = contactName || `contact #${delivery.contactId}`;
  const body = `Message to ${recipient} on ${platform} failed permanently after ${attempts} attempt(s): ${reason}`;

  // deliveryId is unique, making this safe if a restarted worker sees the
  // final attempt again.
  const notification = await prisma.notification.upsert({
    where: { deliveryId: delivery.id },
    create: {
      userId: delivery.job.userId,
      deliveryId: delivery.id,
      type: 'permanent_delivery_failure',
      title: `Delivery failed on ${platform}`,
      body,
    },
    update: {},
  });

  const preferences = await prisma.notificationPreference.upsert({
    where: { userId: delivery.job.userId },
    create: { userId: delivery.job.userId },
    update: {},
    select: { notifyOnFailure: true },
  });

  if (preferences.notifyOnFailure && !notification.emailSentAt) {
    try {
      await sendPermanentFailureEmail(user.email, { contactName: recipient, platform, attempts, reason });
      await prisma.notification.update({ where: { id: notification.id }, data: { emailSentAt: new Date() } });
    } catch (error) {
      // A mail-provider outage must not turn an already-final delivery failure
      // into a failed worker job. The durable in-app alert remains available.
      console.error(`[notifications] could not email permanent failure ${delivery.id}:`, error.message);
    }
  }

  return notification;
}
