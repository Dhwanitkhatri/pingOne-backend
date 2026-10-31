import { env } from '../config/env.js';
import { PLATFORM } from '../constants/codes.js';

/** Disable retries only for Twilio WhatsApp when a one-shot test is requested. */
export function shouldRetryDelivery(platformCode, config = env) {
  if (platformCode !== PLATFORM.WHATSAPP || config.WHATSAPP_PROVIDER !== 'twilio') return true;
  return config.TWILIO_WHATSAPP_RETRY_ENABLED !== 'false';
}
