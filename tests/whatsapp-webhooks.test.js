import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, test } from 'node:test';
import express from 'express';

// Give config imports deterministic, non-production values before loading the
// app modules. No test below connects to a database or calls Meta.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/pingone_test';
process.env.JWT_ACCESS_SECRET = 'whatsapp-webhook-test-access-secret-32-chars';
process.env.JWT_REFRESH_SECRET = 'whatsapp-webhook-test-refresh-secret-32-chars';
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.API_PREFIX = '/api/v1';
process.env.PUBLIC_BASE_URL = 'https://pingone-test.example';
process.env.META_APP_SECRET = 'meta-webhook-test-secret';

const [
  { default: webhookRoutes },
  { errorHandler },
  { env },
  { getAdapter },
  { WhatsAppAdapter },
] = await Promise.all([
  import('../src/modules/webhooks/webhooks.routes.js'),
  import('../src/middleware/errorHandler.js'),
  import('../src/config/env.js'),
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

test('Meta webhook route and raw-body signature validation work', async () => {
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

test('the removed Twilio WhatsApp status route is gone', async () => {
  const response = await fetch(`${origin}/api/v1/webhooks/twilio/whatsapp`, { method: 'POST' });
  assert.equal(response.status, 404);
});

test('WhatsApp always resolves to the Meta adapter', () => {
  assert.ok(getAdapter('whatsapp') instanceof WhatsAppAdapter);
});
