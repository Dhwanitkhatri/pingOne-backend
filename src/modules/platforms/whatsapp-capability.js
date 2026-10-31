/**
 * Public WhatsApp sending capability for the authenticated platform list.
 * Twilio is server-configured; Meta remains available only with an active
 * WhatsApp credential owned by this user.
 */
export function getWhatsAppCapability(credentials, configuredProvider) {
  const provider = configuredProvider === 'twilio' ? 'twilio' : 'meta';
  const available = provider === 'twilio' || credentials.some(
    (credential) => credential.platform?.code === 'whatsapp' && credential.isActive
  );

  return { available, provider };
}
