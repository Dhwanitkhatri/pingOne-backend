import { env } from '../config/env.js';

/** Build the exact public URL configured as Twilio's status callback. */
export function twilioWhatsAppStatusCallbackUrl(config = env) {
  const origin = `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/`;
  return new URL(`${config.API_PREFIX}/webhooks/twilio/whatsapp`, origin).toString();
}
