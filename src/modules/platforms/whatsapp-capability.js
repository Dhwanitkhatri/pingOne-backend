/**
 * Public WhatsApp sending capability for the authenticated platform list.
 * WhatsApp always sends through Meta's Cloud API, so it is available only
 * with an active WhatsApp credential owned by this user.
 */
export function getWhatsAppCapability(credentials) {
  const available = credentials.some(
    (credential) => credential.platform?.code === 'whatsapp' && credential.isActive
  );

  return { available, provider: 'meta' };
}
