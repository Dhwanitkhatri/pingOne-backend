// ============================================================
// Adapter registry — this is the whole point of the pattern. Nobody
// outside this file writes `if (platform === 'telegram')` ever again.
// ============================================================

import { TelegramAdapter } from './telegram.adapter.js';
import { WhatsAppAdapter } from './whatsapp.adapter.js';
import { GmailAdapter } from './gmail.adapter.js';
import { SmsAdapter } from './sms.adapter.js';
import { TwilioWhatsAppAdapter } from './twilio-whatsapp.adapter.js';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';

const registry = new Map([
  [TelegramAdapter.code, new TelegramAdapter()],
  [WhatsAppAdapter.code, new WhatsAppAdapter()],
  [GmailAdapter.code, new GmailAdapter()],
  [SmsAdapter.code, new SmsAdapter()],
]);

const deliveryProviders = new Map([
  ['whatsapp:twilio', new TwilioWhatsAppAdapter()],
]);

/** @returns {import('./base.adapter.js').BaseAdapter} */
export function getAdapter(platformCode) {
  const adapter = registry.get(platformCode);
  if (!adapter) {
    throw new AppError(500, `No adapter registered for platform "${platformCode}"`, {
      code: 'ADAPTER_NOT_FOUND',
    });
  }
  return adapter;
}

/** Resolve an outbound adapter while keeping platform-connection validation unchanged. */
export function getDeliveryAdapter(platformCode) {
  if (platformCode === 'whatsapp' && env.WHATSAPP_PROVIDER === 'twilio') {
    return deliveryProviders.get('whatsapp:twilio');
  }
  return getAdapter(platformCode);
}
