import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';

// Isolated, non-production config; all database, queue, and Twilio calls below
// are replaced with in-memory fakes.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/pingone_test';
process.env.JWT_ACCESS_SECRET = 'twilio-send-test-access-secret-32-characters';
process.env.JWT_REFRESH_SECRET = 'twilio-send-test-refresh-secret-32-characters';
process.env.TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
process.env.API_PREFIX = '/api/v1';
process.env.PUBLIC_BASE_URL = 'https://pingone-test.example';
process.env.WHATSAPP_PROVIDER = 'meta';
process.env.TWILIO_ACCOUNT_SID = `AC${'3'.repeat(32)}`;
process.env.TWILIO_AUTH_TOKEN = 'twilio-send-test-auth-token';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';
process.env.TWILIO_WHATSAPP_CONTENT_SID = `HX${'4'.repeat(32)}`;

const [
  { sendMessageSchema },
  { authenticate },
  { validate },
  { issueTokens },
  { errorHandler },
  { fireJob },
  { processDeliveryJob },
  { transitionStatus },
  { TwilioWhatsAppAdapter },
  { twilioWhatsAppStatusCallbackUrl },
  { shouldRetryDelivery },
] = await Promise.all([
  import('../src/modules/scheduler/scheduler.schema.js'),
  import('../src/middleware/authenticate.js'),
  import('../src/middleware/validate.js'),
  import('../src/utils/token.js'),
  import('../src/middleware/errorHandler.js'),
  import('../src/modules/scheduler/dispatch.js'),
  import('../src/workers/delivery.processor.js'),
  import('../src/modules/deliveries/delivery-status.service.js'),
  import('../src/platforms/twilio-whatsapp.adapter.js'),
  import('../src/utils/webhook-urls.js'),
  import('../src/workers/retry-policy.js'),
]);

const app = express();
app.use(express.json());
const fakeUser = {
  id: 71,
  email: 'preflight@example.test',
  firstName: 'Preflight',
  lastName: 'User',
  isVerified: true,
  role: 'user',
};
app.post(
  '/api/v1/messages/send',
  (req, res, next) => authenticate(req, res, next, { findActiveUser: async () => fakeUser }),
  validate({ body: sendMessageSchema }),
  (req, res) => res.status(202).json({ userId: req.user.id, data: req.body })
);
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

const statusIds = { pending: 1, sending: 2, sent: 3, delivered: 4, read: 5, failed: 6, cancelled: 7 };

function fakeStatusDatabase(delivery) {
  const logs = [];
  const tx = {
    messageDelivery: {
      findUnique: async () => delivery,
      update: async ({ data }) => {
        Object.assign(delivery, data);
        delivery.status = {
          code: Object.keys(statusIds).find((code) => statusIds[code] === data.statusId),
        };
        return delivery;
      },
    },
    deliveryStatusLog: { create: async ({ data }) => logs.push(data) },
  };
  return {
    logs,
    db: { $transaction: (callback) => callback(tx) },
    lookup: async (_table, code) => ({ id: statusIds[code] }),
  };
}

test('POST /api/v1/messages/send requires Bearer authentication', async () => {
  const response = await fetch(`${origin}/api/v1/messages/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Preflight only', recipients: [{ contactId: 10, platform: 'whatsapp' }] }),
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'NO_TOKEN');
});

test('send payload validates content and a WhatsApp recipient before dispatch', async () => {
  const accessToken = issueTokens(fakeUser).accessToken;
  const validPayload = {
    content: 'Non-live preflight message',
    recipients: [{ contactId: 10, platform: 'whatsapp' }],
  };
  const response = await fetch(`${origin}/api/v1/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(validPayload),
  });
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(body.userId, fakeUser.id);
  assert.deepEqual(body.data.recipients, validPayload.recipients);
  assert.equal(body.data.content, validPayload.content);
});

test('send payload rejects missing or invalid recipients', async () => {
  const missingContent = sendMessageSchema.safeParse({
    recipients: [{ contactId: 10, platform: 'whatsapp' }],
  });
  const invalidPlatform = sendMessageSchema.safeParse({
    content: 'Preflight only',
    recipients: [{ contactId: 10, platform: 'not-a-platform' }],
  });

  assert.equal(missingContent.success, false);
  assert.equal(invalidPlatform.success, false);
});

test('dispatch creates one pending delivery per unique recipient and queues each delivery', async () => {
  const created = [];
  const queued = [];
  let scheduleUpdate;
  const db = {
    messageDelivery: {
      create: async ({ data }) => {
        const delivery = { id: 300 + created.length, ...data };
        created.push(delivery);
        return delivery;
      },
    },
    $transaction: async (operations) => Promise.all(operations),
    scheduledJob: {
      update: async (args) => { scheduleUpdate = args; return args; },
    },
  };
  const job = {
    id: 55,
    occurrenceCount: 0,
    scheduledAt: new Date('2026-10-29T00:00:00Z'),
    nextRunAt: null,
    recurrenceRule: null,
    skipIfReplied: false,
    recipients: [
      { contactId: 10, platformId: 2 },
      { groupId: 20, platformId: 2, group: { members: [{ contactId: 10 }, { contactId: 11 }] } },
    ],
  };

  const result = await fireJob(job, statusIds.pending, statusIds.sent, {
    db,
    enqueueDelivery: async (id) => queued.push(id),
    computeNext: () => ({ nextRunAt: null, skipped: 0 }),
  });

  assert.equal(result.deliveries, 2);
  assert.deepEqual(created.map(({ contactId, platformId, statusId }) => ({ contactId, platformId, statusId })), [
    { contactId: 10, platformId: 2, statusId: statusIds.pending },
    { contactId: 11, platformId: 2, statusId: statusIds.pending },
  ]);
  assert.deepEqual(queued, [300, 301]);
  assert.equal(scheduleUpdate.where.id, job.id);
  assert.equal(scheduleUpdate.data.statusId, statusIds.sent);
});

test('worker submits through a mocked Twilio client and persists Message SID as sent', async () => {
  const delivery = {
    id: 88,
    jobId: 55,
    contactId: 10,
    platformId: 2,
    statusId: statusIds.pending,
    status: { code: 'pending' },
    retryCount: 0,
    platformMessageId: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    errorReason: null,
    contact: { id: 10 },
    platform: { code: 'whatsapp' },
    job: {
      userId: fakeUser.id,
      messageId: 404,
      message: { content: 'Preflight template text', subject: null, template: null },
    },
  };
  const database = fakeStatusDatabase(delivery);
  const sends = [];
  let credentialLookups = 0;
  const config = {
    TWILIO_ACCOUNT_SID: `AC${'3'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: 'twilio-send-test-auth-token',
    TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
    TWILIO_WHATSAPP_CONTENT_SID: `HX${'4'.repeat(32)}`,
    PUBLIC_BASE_URL: 'https://pingone-test.example',
    API_PREFIX: '/api/v1',
  };
  const adapter = new TwilioWhatsAppAdapter({
    config,
    clientFactory: () => ({
      messages: {
        create: async (params) => {
          sends.push(params);
          return { sid: 'SM-preflight-mocked', status: 'queued' };
        },
      },
    }),
  });

  await processDeliveryJob(
    { data: { deliveryId: delivery.id } },
    {
      db: { messageDelivery: { findUnique: async () => delivery } },
      adapterResolver: () => adapter,
      recipientResolver: async () => '+919876543210',
      credentialResolver: async () => { credentialLookups += 1; throw new Error('should not need user credentials'); },
      attachmentLoader: async () => [],
      personalize: (content) => content,
      transition: (params) => transitionStatus(params, {
        db: database.db,
        lookup: database.lookup,
      }),
      onFailure: (message, err) => { throw err; },
    }
  );

  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, 'whatsapp:+919876543210');
  assert.equal(sends[0].from, config.TWILIO_WHATSAPP_FROM);
  assert.equal(sends[0].contentSid, config.TWILIO_WHATSAPP_CONTENT_SID);
  assert.deepEqual(JSON.parse(sends[0].contentVariables), { '1': 'Preflight template text' });
  assert.equal(sends[0].statusCallback, twilioWhatsAppStatusCallbackUrl(config));
  assert.equal(credentialLookups, 0);
  assert.equal(delivery.status.code, 'sent');
  assert.equal(delivery.platformMessageId, 'SM-preflight-mocked');
  assert.equal(delivery.retryCount, 0);
  assert.ok(delivery.sentAt instanceof Date);
  assert.deepEqual(database.logs.map((entry) => entry.newStatusId), [statusIds.sending, statusIds.sent]);
});

test('worker skips a delivery already confirmed by a callback', async () => {
  let adapterLookups = 0;
  const delivery = {
    id: 89,
    status: { code: 'delivered' },
  };

  await processDeliveryJob(
    { data: { deliveryId: delivery.id } },
    {
      db: { messageDelivery: { findUnique: async () => delivery } },
      adapterResolver: () => { adapterLookups += 1; throw new Error('must not send again'); },
    }
  );

  assert.equal(adapterLookups, 0);
});

test('one-shot worker mode disables retries only for Twilio WhatsApp', () => {
  const oneShot = {
    WHATSAPP_PROVIDER: 'twilio',
    TWILIO_WHATSAPP_RETRY_ENABLED: 'false',
  };

  assert.equal(shouldRetryDelivery('whatsapp', oneShot), false);
  assert.equal(shouldRetryDelivery('telegram', oneShot), true);
  assert.equal(shouldRetryDelivery('whatsapp', { ...oneShot, TWILIO_WHATSAPP_RETRY_ENABLED: 'true' }), true);
  assert.equal(shouldRetryDelivery('whatsapp', { ...oneShot, WHATSAPP_PROVIDER: 'meta' }), true);
});
