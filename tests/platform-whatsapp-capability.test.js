import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getWhatsAppCapability } from '../src/modules/platforms/whatsapp-capability.js';

test('WhatsApp is unavailable without any user credential', () => {
  assert.deepEqual(getWhatsAppCapability([]), {
    available: false,
    provider: 'meta',
  });
});

test('Meta WhatsApp is available only with an active user credential', () => {
  assert.deepEqual(getWhatsAppCapability([
    { platform: { code: 'whatsapp' }, isActive: false },
  ]), {
    available: false,
    provider: 'meta',
  });

  assert.deepEqual(getWhatsAppCapability([
    { platform: { code: 'whatsapp' }, isActive: true },
  ]), {
    available: true,
    provider: 'meta',
  });
});

test('a different platform credential does not enable Meta WhatsApp', () => {
  assert.deepEqual(getWhatsAppCapability([
    { platform: { code: 'sms' }, isActive: true },
  ]), {
    available: false,
    provider: 'meta',
  });
});
