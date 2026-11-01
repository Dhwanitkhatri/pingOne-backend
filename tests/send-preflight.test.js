import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';

// Isolated, non-production config; all database and queue calls below are
// replaced with in-memory fakes.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/pingone_test';
process.env.JWT_ACCESS_SECRET = 'send-preflight-test-access-secret-32-characters';
process.env.JWT_REFRESH_SECRET = 'send-preflight-test-refresh-secret-32-characters';
process.env.TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
process.env.API_PREFIX = '/api/v1';
process.env.PUBLIC_BASE_URL = 'https://pingone-test.example';

const [
  { sendMessageSchema },
  { authenticate },
  { validate },
  { issueTokens },
  { errorHandler },
  { fireJob },
] = await Promise.all([
  import('../src/modules/scheduler/scheduler.schema.js'),
  import('../src/middleware/authenticate.js'),
  import('../src/middleware/validate.js'),
  import('../src/utils/token.js'),
  import('../src/middleware/errorHandler.js'),
  import('../src/modules/scheduler/dispatch.js'),
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
