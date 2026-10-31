import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getWhatsAppCapability } from '../src/modules/platforms/whatsapp-capability.js';

test('server-configured Twilio enables WhatsApp without a user credential', () => {
  assert.deepEqual(getWhatsAppCapability([], 'twilio'), {
    available: true,
    provider: 'twilio',
  });
});

test('Meta WhatsApp is available only with an active user credential', () => {
  assert.deepEqual(getWhatsAppCapability([
    { platform: { code: 'whatsapp' }, isActive: false },
  ], 'meta'), {
    available: false,
    provider: 'meta',
  });

  assert.deepEqual(getWhatsAppCapability([
    { platform: { code: 'whatsapp' }, isActive: true },
  ], 'meta'), {
    available: true,
    provider: 'meta',
  });
});

test('a different platform credential does not enable Meta WhatsApp', () => {
  assert.deepEqual(getWhatsAppCapability([
    { platform: { code: 'sms' }, isActive: true },
  ], 'meta'), {
    available: false,
    provider: 'meta',
  });
});
