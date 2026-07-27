// ============================================================
// Turns (contact, platformCode) into the actual address an adapter
// needs to send to. Checks the platform-specific handle first (this
// is where a Telegram chat_id or a WhatsApp-specific number would
// live if it differs from the contact's primary phone), and falls
// back to the contact's primary phone/email for SMS/WhatsApp/Gmail.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { PLATFORM } from '../../constants/codes.js';

export async function resolveRecipientHandle(contactId, platformId, platformCode) {
  const explicit = await prisma.contactPlatformHandle.findUnique({
    where: { contactId_platformId: { contactId, platformId } },
  });
  if (explicit) return explicit.handle;

  if (platformCode === PLATFORM.GMAIL) {
    const email = await prisma.contactEmail.findFirst({
      where: { contactId },
      orderBy: { isPrimary: 'desc' },
    });
    if (email) return email.email;
  }

  if (platformCode === PLATFORM.WHATSAPP || platformCode === PLATFORM.SMS) {
    const phone = await prisma.contactPhone.findFirst({
      where: { contactId },
      orderBy: { isPrimary: 'desc' },
    });
    if (phone) return phone.phone;
  }

  throw AppError.badRequest(
    `Contact ${contactId} has no address on file for platform "${platformCode}"`,
    { code: 'NO_RECIPIENT_HANDLE' }
  );
}
