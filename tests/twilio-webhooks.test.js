import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, test } from 'node:test';
import express from 'express';
import twilio from 'twilio';

// Give config imports deterministic, non-production values before loading the
// app modules. No test below connects to a database or sends a Twilio message.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/pingone_test';
process.env.JWT_ACCESS_SECRET = 'twilio-webhook-test-access-secret-32-chars';
process.env.JWT_REFRESH_SECRET = 'twilio-webhook-test-refresh-secret-32-chars';
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.API_PREFIX = '/api/v1';
process.env.PUBLIC_BASE_URL = 'https://pingone-test.example';
process.env.WHATSAPP_PROVIDER = 'meta';
process.env.TWILIO_ACCOUNT_SID = `AC${'1'.repeat(32)}`;
process.env.TWILIO_AUTH_TOKEN = 'twilio-webhook-test-auth-token';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';
process.env.TWILIO_WHATSAPP_CONTENT_SID = `HX${'2'.repeat(32)}`;
process.env.META_APP_SECRET = 'meta-webhook-test-secret';

const [
  { default: webhookRoutes },
  { errorHandler },
  { env },
  { twilioWhatsAppStatusCallbackUrl },
  { handleTwilioWhatsAppStatus },
  { transitionStatus },
  { getAdapter, getDeliveryAdapter },
  { WhatsAppAdapter },
] = await Promise.all([
  import('../src/modules/webhooks/webhooks.routes.js'),
  import('../src/middleware/errorHandler.js'),
  import('../src/config/env.js'),
  import('../src/utils/webhook-urls.js'),
  import('../src/modules/webhooks/webhooks.service.js'),
  import('../src/modules/deliveries/delivery-status.service.js'),
  import('../src/platforms/adapter.registry.js'),
  import('../src/platforms/whatsapp.adapter.js'),
]);

const app = express();
app.use(express.json({
  verify(req, _res, buffer) {
    if (req.originalUrl.includes('/webhooks/')) req.rawBody = buffer;
  },
}));
app.use(express.urlencoded({ extended: true }));
app.use('/api/v1/webhooks', webhookRoutes);
app.use(errorHandler);

let server;
let origin;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

function twilioSignature(params) {
  return twilio.getExpectedTwilioSignature(
    env.TWILIO_AUTH_TOKEN,
    twilioWhatsAppStatusCallbackUrl(),
    params
  );
}

async function postTwilioStatus(params, signature = twilioSignature(params)) {
  const form = new URLSearchParams(params);
  return fetch(`${origin}/api/v1/webhooks/twilio/whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
    },
    body: form,
  });
}

async function postMetaEvent(rawBody, signature) {
  return fetch(`${origin}/api/v1/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signature,
    },
    body: rawBody,
  });
}

const STATUS_IDS = {
  pending: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  read: 5,
  failed: 6,
  cancelled: 7,
};

function fakeDatabase() {
  const delivery = {
    id: 42,
    statusId: STATUS_IDS.pending,
    status: { code: 'pending' },
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    errorReason: null,
  };
  const logs = [];
  const tx = {
    messageDelivery: {
      findUnique: async () => delivery,
      update: async ({ data }) => {
        Object.assign(delivery, data);
        delivery.status = {
          code: Object.keys(STATUS_IDS).find((code) => STATUS_IDS[code] === data.statusId),
        };
        return delivery;
      },
    },
    deliveryStatusLog: {
      create: async ({ data }) => logs.push(data),
    },
  };
  return {
    delivery,
    logs,
    db: { $transaction: (callback) => callback(tx) },
    lookup: async (_table, code) => ({ id: STATUS_IDS[code] }),
  };
}

function fakeTransition(database) {
  return (params) => transitionStatus(params, {
    db: database.db,
    lookup: database.lookup,
  });
}

test('Twilio route accepts a valid SDK signature and acknowledges queued status', async () => {
  const params = { MessageSid: 'SMtest-valid-signature', MessageStatus: 'queued' };
  const response = await postTwilioStatus(params);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { received: true, processed: 0, ignored: 1, unmatched: 0 });
});

test('Twilio route rejects an invalid signature', async () => {
  const response = await postTwilioStatus(
    { MessageSid: 'SMtest-invalid-signature', MessageStatus: 'sent' },
    'not-a-valid-signature'
  );
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'WEBHOOK_SIGNATURE_INVALID');
});

test('Twilio status mappings update delivery state through the shared transition service', async (t) => {
  const cases = [
    ['sent', 'sent'],
    ['delivered', 'delivered'],
    ['read', 'read'],
    ['failed', 'failed'],
    ['undelivered', 'failed'],
  ];

  for (const [providerStatus, expected] of cases) {
    await t.test(`${providerStatus} maps to ${expected}`, async () => {
      const database = fakeDatabase();
      const result = await handleTwilioWhatsAppStatus(
        { MessageSid: 'SMtest-mapping', MessageStatus: providerStatus },
        {
          findDelivery: async () => database.delivery,
          applyTransition: fakeTransition(database),
        }
      );

      assert.equal(database.delivery.status.code, expected);
      assert.equal(result.processed, 1);
      assert.equal(database.logs.length, 1);
      assert.equal(database.logs[0].changedBy, 'webhook');
      if (expected === 'read') {
        assert.ok(database.delivery.sentAt instanceof Date);
        assert.ok(database.delivery.deliveredAt instanceof Date);
        assert.ok(database.delivery.readAt instanceof Date);
      }
    });
  }
});

test('queued and unknown Twilio statuses are ignored without changing delivery state', async () => {
  const database = fakeDatabase();
  let transitionCalls = 0;
  const deps = {
    findDelivery: async () => database.delivery,
    applyTransition: async () => { transitionCalls += 1; return { changed: true }; },
  };

  for (const status of ['queued', 'processing-new-status']) {
    const result = await handleTwilioWhatsAppStatus(
      { MessageSid: 'SMtest-ignored', MessageStatus: status },
      deps
    );
    assert.equal(result.ignored, 1);
  }

  assert.equal(database.delivery.status.code, 'pending');
  assert.equal(database.logs.length, 0);
  assert.equal(transitionCalls, 0);
});

test('duplicate callbacks are idempotent and a late sent event cannot move delivery backwards', async () => {
  const database = fakeDatabase();
  const deps = {
    findDelivery: async () => database.delivery,
    applyTransition: fakeTransition(database),
  };

  await handleTwilioWhatsAppStatus(
    { MessageSid: 'SMtest-idempotent', MessageStatus: 'delivered' },
    deps
  );
  const duplicate = await handleTwilioWhatsAppStatus(
    { MessageSid: 'SMtest-idempotent', MessageStatus: 'delivered' },
    deps
  );
  const late = await handleTwilioWhatsAppStatus(
    { MessageSid: 'SMtest-idempotent', MessageStatus: 'sent' },
    deps
  );

  assert.equal(database.delivery.status.code, 'delivered');
  assert.equal(database.logs.length, 1);
  assert.equal(duplicate.ignored, 1);
  assert.equal(late.ignored, 1);
});

test('a late delivered callback cannot downgrade a read delivery', async () => {
  const database = fakeDatabase();
  const deps = {
    findDelivery: async () => database.delivery,
    applyTransition: fakeTransition(database),
  };

  await handleTwilioWhatsAppStatus(
    { MessageSid: 'SMtest-read-is-final', MessageStatus: 'read' },
    deps
  );
  const late = await handleTwilioWhatsAppStatus(
    { MessageSid: 'SMtest-read-is-final', MessageStatus: 'delivered' },
    deps
  );

  assert.equal(database.delivery.status.code, 'read');
  assert.ok(database.delivery.readAt instanceof Date);
  assert.equal(database.logs.length, 1);
  assert.equal(late.ignored, 1);
  assert.equal(late.processed, 0);
});

test('Twilio failure callbacks preserve the provider error code and message', async () => {
  const database = fakeDatabase();
  await handleTwilioWhatsAppStatus(
    {
      MessageSid: 'SMtest-error-details',
      MessageStatus: 'failed',
      ErrorCode: '63015',
      ErrorMessage: 'Sandbox recipient is not joined',
    },
    {
      findDelivery: async () => database.delivery,
      applyTransition: fakeTransition(database),
    }
  );

  assert.equal(database.delivery.errorReason, 'Twilio 63015: Sandbox recipient is not joined');
});

test('Twilio undelivered callbacks persist failed status and provider error details', async () => {
  const database = fakeDatabase();
  const result = await handleTwilioWhatsAppStatus(
    {
      MessageSid: 'SMtest-undelivered-error-details',
      MessageStatus: 'undelivered',
      ErrorCode: '63015',
      ErrorMessage: 'Sandbox recipient is not joined',
    },
    {
      findDelivery: async () => database.delivery,
      applyTransition: fakeTransition(database),
    }
  );

  assert.equal(database.delivery.status.code, 'failed');
  assert.equal(database.delivery.errorReason, 'Twilio 63015: Sandbox recipient is not joined');
  assert.equal(database.logs.length, 1);
  assert.equal(database.logs[0].changedBy, 'webhook');
  assert.equal(result.processed, 1);
});

test('unknown Twilio Message SID is acknowledged as unmatched without a status write', async () => {
  let transitionCalls = 0;
  const result = await handleTwilioWhatsAppStatus(
    { MessageSid: 'SMunknown', MessageStatus: 'delivered' },
    {
      findDelivery: async () => null,
      applyTransition: async () => { transitionCalls += 1; },
    }
  );

  assert.deepEqual(result, { processed: 0, ignored: 0, unmatched: 1 });
  assert.equal(transitionCalls, 0);
});

test('Meta webhook route and raw-body signature validation still work', async () => {
  const rawBody = JSON.stringify({ entry: [] });
  const signature = createHmac('sha256', env.META_APP_SECRET).update(rawBody).digest('hex');
  const accepted = await postMetaEvent(rawBody, `sha256=${signature}`);
  const acceptedBody = await accepted.json();

  assert.equal(accepted.status, 200);
  assert.equal(acceptedBody.received, true);

  const rejected = await postMetaEvent(rawBody, 'sha256=invalid');
  const rejectedBody = await rejected.json();
  assert.equal(rejected.status, 403);
  assert.equal(rejectedBody.error.code, 'WEBHOOK_SIGNATURE_INVALID');
});

test('WhatsApp connection and default delivery adapter remain the Meta adapter', () => {
  assert.equal(env.WHATSAPP_PROVIDER, 'meta');
  assert.ok(getAdapter('whatsapp') instanceof WhatsAppAdapter);
  assert.equal(getDeliveryAdapter('whatsapp'), getAdapter('whatsapp'));
});
