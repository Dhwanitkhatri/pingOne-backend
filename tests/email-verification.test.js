import assert from 'node:assert/strict';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/pingone_test';
process.env.JWT_ACCESS_SECRET = 'email-verify-test-access-secret-32-characters';
process.env.JWT_REFRESH_SECRET = 'email-verify-test-refresh-secret-32-characters';
process.env.TOKEN_ENCRYPTION_KEY = 'd'.repeat(64);
process.env.API_PREFIX = '/api/v1';

const [
  { isBlockedUntilVerified },
  { authenticate },
  { issueEmailVerificationToken, verifyEmailVerificationToken, verifyAccessToken, issueTokens },
] = await Promise.all([
  import('../src/middleware/emailVerification.js'),
  import('../src/middleware/authenticate.js'),
  import('../src/utils/token.js'),
]);

const req = (method, url) => ({ method, originalUrl: `/api/v1${url}` });

test('unverified users can read anything except starting a platform connection', () => {
  for (const url of ['/contacts', '/messages/history?page=2', '/platforms', '/auth/me', '/templates/']) {
    assert.equal(isBlockedUntilVerified(req('GET', url)), false, url);
  }
  for (const url of ['/auth/google', '/auth/meta?x=1', '/auth/twilio/']) {
    assert.equal(isBlockedUntilVerified(req('GET', url)), true, url);
  }
});

test('unverified users cannot write to feature modules', () => {
  for (const [method, url] of [
    ['POST', '/messages/send'],
    ['POST', '/contacts'],
    ['DELETE', '/contacts/4'],
    ['POST', '/platforms/whatsapp'],
    ['PUT', '/templates/9'],
    ['POST', '/scheduler'],
    ['POST', '/ai/generate'],
    ['POST', '/some-future-module'],
  ]) {
    assert.equal(isBlockedUntilVerified(req(method, url)), true, `${method} ${url}`);
  }
});

test('unverified users keep account, auth, notification and admin writes', () => {
  for (const [method, url] of [
    ['POST', '/auth/resend-verification'],
    ['POST', '/auth/logout'],
    ['PATCH', '/users/profile'],
    ['PUT', '/users/password'],
    ['DELETE', '/users/me'],
    ['PATCH', '/notifications/7/read'],
    ['POST', '/admin/users/3/suspend'],
  ]) {
    assert.equal(isBlockedUntilVerified(req(method, url)), false, `${method} ${url}`);
  }
});

test('authenticate refuses a blocked write with EMAIL_NOT_VERIFIED, then allows it once verified', async () => {
  const { accessToken } = issueTokens({ id: 5, email: 'u@example.test' });
  const request = {
    ...req('POST', '/messages/send'),
    headers: { authorization: `Bearer ${accessToken}` },
  };
  const run = (isVerified) => new Promise((resolve) => {
    authenticate(request, {}, resolve, {
      findActiveUser: async () => ({ id: 5, email: 'u@example.test', isVerified, role: 'USER' }),
    });
  });

  const refused = await run(false);
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.code, 'EMAIL_NOT_VERIFIED');

  assert.equal(await run(true), undefined);
});

test('a verification token round-trips and carries the email it was issued for', () => {
  const token = issueEmailVerificationToken({ userId: 12, email: 'a@example.test' });
  assert.deepEqual(verifyEmailVerificationToken(token), { userId: 12, email: 'a@example.test' });
});

test('a verification link can never be used as an access token, nor the reverse', () => {
  const link = issueEmailVerificationToken({ userId: 12, email: 'a@example.test' });
  assert.throws(() => verifyAccessToken(link), { code: 'INVALID_ACCESS_TOKEN' });

  const { accessToken } = issueTokens({ id: 12, email: 'a@example.test' });
  assert.throws(() => verifyEmailVerificationToken(accessToken), { code: 'INVALID_VERIFICATION_TOKEN' });
});

test('expired or tampered verification tokens are rejected', () => {
  const expired = jwt.sign({ sub: 1, email: 'x@example.test', typ: 'email_verify', exp: 1 }, 'whatever');
  assert.throws(() => verifyEmailVerificationToken(expired), { code: 'INVALID_VERIFICATION_TOKEN' });
  assert.throws(() => verifyEmailVerificationToken('not-a-jwt'), { code: 'INVALID_VERIFICATION_TOKEN' });
});
