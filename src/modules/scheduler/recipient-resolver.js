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

  if (explicit) {
    /**
     * `chatId` is the platform's own address, captured when the contact first
     * messaged us; `handle` is what the user typed. Prefer the captured one —
     * it always works — but fall back to the handle rather than failing here.
     *
     * Whether a bare "@aarav" is usable depends on the sender's TELEGRAM MODE,
     * which this function can't see: the Bot API rejects it, a connected user
     * account resolves it. The adapter holds the credential and therefore the
     * mode, so it makes that call — see telegram.adapter.js.
     */
    return explicit.chatId ?? explicit.handle;
  }

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
