// ============================================================
// UI end-to-end tests for the PingOne frontend.
//
// Drives the running frontend in headless Chrome (puppeteer-core uses the
// Chrome or Edge already installed — nothing is downloaded). Needs the API,
// the worker and the frontend running. Prisma is used only for test setup the
// UI can't do on its own: a Telegram bot credential with a deliberately fake
// token (so Send is enabled) and promoting a test account to ADMIN.
//
//   npm run test:ui                                 all 33 UI tests
//   npm run test:ui -- --only=TC-UI-07,TC-UI-22     just these
//
// Optional environment variables:
//   TEST_APP_ORIGIN   frontend URL        (default http://localhost:3000)
//   TEST_API_ORIGIN   API origin          (default http://localhost:<PORT>)
//   CHROME_PATH       browser executable  (default: Chrome, else Edge)
//   HEADLESS=false    watch the browser while the tests run
//
// Results go to tests/results/ui-results.json; `npm run test:report` turns
// them into ../TEST_CASES.md. Test accounts are pingone-qa-…@example.com and
// are removed by `npm run test:cleanup` (the API suite also removes them).
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { prisma } from '../src/config/prisma.js';
import { env } from '../src/config/env.js';
import { encryptToken } from '../src/utils/crypto.js';
import { getPlatformId } from '../src/utils/platforms.js';
import { cleanupTestData } from './cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.TEST_APP_ORIGIN || 'http://localhost:3000';
const API = `${process.env.TEST_API_ORIGIN || `http://localhost:${env.PORT}`}${env.API_PREFIX}`;
const CHROME =
  process.env.CHROME_PATH ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));
const RUN = Date.now().toString(36);
const PASSWORD = 'QaTest@12345';
const OUT = path.join(HERE, 'results', 'ui-results.json');

if (!CHROME) {
  console.error('No Chrome or Edge found. Set CHROME_PATH to your browser executable.');
  process.exit(2);
}

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Fail extends Error {}
const ok = (c, m) => { if (!c) throw new Fail(m); };

let ipSeq = 0;
const ipB = 1 + Math.floor(Math.random() * 250);
const freshIp = () => `10.${ipB}.${200 + (Math.floor(++ipSeq / 250) % 50)}.${(ipSeq % 250) + 1}`;

async function api(method, path, { token, body, ip } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip ?? freshIp(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

let userSeq = 0;
async function newUser(first = 'Ui', last = 'Tester') {
  userSeq += 1;
  const email = `pingone-qa-${RUN}-ui${userSeq}@example.com`;
  const r = await api('POST', '/auth/signup', { body: { firstName: first, lastName: last, email, password: PASSWORD } });
  ok(r.status === 201, `signup ${r.status}`);
  return { id: r.body.user.id, email, password: PASSWORD, first, tokens: r.body };
}

// --only=TC-UI-07,TC-UI-22 runs just those tests.
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;

async function tc(id, scenario, steps, expected, fn) {
  if (ONLY && !ONLY.has(id)) return;
  let status = 'PASS';
  let actual;
  try {
    actual = await fn();
  } catch (err) {
    status = 'FAIL';
    actual = err instanceof Fail ? err.message : `Error: ${err.message.split('\n')[0]}`;
  }
  results.push({ id, module: 'Frontend (UI)', scenario, steps, expected, actual: String(actual ?? ''), status });
  console.log(`${status === 'PASS' ? '✔' : '✘'} ${id} ${scenario}${status === 'FAIL' ? `\n    → ${actual}` : ''}`);
}

// ---- browser helpers
const browser = await puppeteer.launch({ executablePath: CHROME, headless: process.env.HEADLESS !== 'false', args: ['--no-first-run'] });

async function newPage({ width = 1366, height = 900 } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': freshIp() });
  await page.setViewport({ width, height });
  page.setDefaultTimeout(15000);
  return page;
}

async function signIn(page, user) {
  await page.goto(APP, { waitUntil: 'networkidle0' });
  await page.evaluate((t) => {
    localStorage.setItem('pingone.accessToken', t.accessToken);
    localStorage.setItem('pingone.refreshToken', t.refreshToken);
    localStorage.setItem('pingone.user', JSON.stringify(t.user));
  }, user.tokens);
}

/** Click the last visible, enabled element whose text (or aria-label) matches. */
async function click(page, text, { exact = true, tag = 'button,a,[role="button"]' } = {}) {
  const handle = await page.waitForFunction(
    (text, tag, exact) => {
      const norm = (s) => (s || '').trim().replace(/\s+/g, ' ');
      const els = [...document.querySelectorAll(tag)].filter((e) => (e.offsetWidth || e.offsetHeight) && !e.disabled);
      return els.reverse().find((e) => {
        const t = norm(e.innerText) || norm(e.getAttribute('aria-label'));
        return exact ? t === text || norm(e.getAttribute('aria-label')) === text : t.includes(text);
      }) ?? null;
    },
    {},
    text, tag, exact
  );
  await handle.asElement().click();
}

const waitText = (page, text, timeout = 15000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
const hasText = (page, text) => page.evaluate((t) => document.body.innerText.includes(t), text);
const waitPath = (page, path, timeout = 15000) =>
  page.waitForFunction((p) => location.pathname === p, { timeout }, path);

async function typeInto(page, selector, value) {
  await page.waitForSelector(selector, { visible: true });
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, value);
}

async function fakeTelegram(userId) {
  const { encryptedToken, iv } = encryptToken(`999999123:AAqaFakeUiToken${RUN}`);
  await prisma.userPlatformCredential.create({
    data: { userId, platformId: await getPlatformId('telegram'), encryptedToken, tokenIv: iv, extraInfo: { bot_username: '@pingone_qa_fake_bot', bot_id: 1, bot_name: 'PingOne QA (fake)', mode: 'bot' } },
  });
}

// ================================================================ tests
try {
  const front = await fetch(APP).catch(() => null);
  if (!front?.ok) throw new Error(`Frontend not reachable at ${APP}`);

  // ---- sign up
  await tc('TC-UI-01', 'Sign-up form validation', 'Open /signup, tick Terms, click "Create account" with empty fields', 'Inline errors for name, email and password; no request sent', async () => {
    const page = await newPage();
    let posted = false;
    page.on('request', (r) => { if (r.url().includes('/auth/signup')) posted = true; });
    await page.goto(`${APP}/signup`, { waitUntil: 'networkidle0' });
    await page.click('input[type="checkbox"]');
    await click(page, 'Create account');
    await waitText(page, 'Full name is required');
    ok(await hasText(page, 'Email is required') && await hasText(page, 'Password is required'), 'missing field errors');
    ok(!posted, 'request was sent');
    await page.browserContext().close();
    return '"Full name is required", "Email is required", "Password is required" shown; no API call';
  });

  await tc('TC-UI-02', 'Sign-up password mismatch', 'Enter different passwords in Password and Confirm Password', '"Passwords do not match"', async () => {
    const page = await newPage();
    await page.goto(`${APP}/signup`, { waitUntil: 'networkidle0' });
    await typeInto(page, 'input[placeholder="Enter your password"]', 'QaTest@12345');
    await typeInto(page, 'input[placeholder="Confirm your password"]', 'Different@123');
    await page.click('input[type="checkbox"]');
    await click(page, 'Create account');
    await waitText(page, 'Passwords do not match');
    await page.browserContext().close();
    return '"Passwords do not match" shown';
  });

  await tc('TC-UI-03', 'Sign up successfully', 'Fill name, email, password, confirm, tick Terms, submit', 'Account created; redirected to /connectplatforms', async () => {
    const page = await newPage();
    await page.goto(`${APP}/signup`, { waitUntil: 'networkidle0' });
    await typeInto(page, 'input[placeholder="Enter your full name"]', 'Riya Sharma');
    await typeInto(page, 'input[placeholder="Enter your email"]', `pingone-qa-${RUN}-uisignup@example.com`);
    await typeInto(page, 'input[placeholder="Enter your password"]', PASSWORD);
    await typeInto(page, 'input[placeholder="Confirm your password"]', PASSWORD);
    await page.click('input[type="checkbox"]');
    await click(page, 'Create account');
    await waitPath(page, '/connectplatforms');
    await page.browserContext().close();
    return 'Redirected to /connectplatforms';
  });

  // ---- login
  const U = await newUser('Kavya', 'Rao');

  await tc('TC-UI-04', 'Login form validation', 'Click "Log In" with empty fields', '"Email is required" and "Password is required"', async () => {
    const page = await newPage();
    await page.goto(APP, { waitUntil: 'networkidle0' });
    await click(page, 'Log In');
    await waitText(page, 'Email is required');
    ok(await hasText(page, 'Password is required'), 'no password error');
    await page.browserContext().close();
    return 'Both errors shown';
  });

  await tc('TC-UI-05', 'Login with a wrong password', 'Correct email, wrong password', 'Error message shown; stays on the login page', async () => {
    const page = await newPage();
    await page.goto(APP, { waitUntil: 'networkidle0' });
    await typeInto(page, 'input[type="email"]', U.email);
    await typeInto(page, 'input[placeholder="Enter your password"]', 'Wrong@12345');
    await click(page, 'Log In');
    const msg = await page.waitForSelector('[role="alert"]').then((h) => h.evaluate((e) => e.innerText));
    ok(new URL(page.url()).pathname === '/', page.url());
    await page.browserContext().close();
    return `Alert: "${msg}"`;
  });

  await tc('TC-UI-06', 'Login successfully', 'Enter valid email and password, click "Log In"', 'Redirected to /dashboard with a greeting', async () => {
    const page = await newPage();
    await page.goto(APP, { waitUntil: 'networkidle0' });
    await typeInto(page, 'input[type="email"]', U.email);
    await typeInto(page, 'input[placeholder="Enter your password"]', PASSWORD);
    await click(page, 'Log In');
    await waitPath(page, '/dashboard');
    await waitText(page, `, ${U.first}`);
    const h = await page.$eval('h1,h2', (e) => e.innerText);
    await page.browserContext().close();
    return `/dashboard — "${h}"`;
  });

  await tc('TC-UI-07', 'Protected page while logged out', 'Open /dashboard/contacts logged out, then log in', 'Sent to login; after login, returned to /dashboard/contacts', async () => {
    const page = await newPage();
    await page.goto(`${APP}/dashboard/contacts`, { waitUntil: 'networkidle0' });
    await waitPath(page, '/');
    await typeInto(page, 'input[type="email"]', U.email);
    await typeInto(page, 'input[placeholder="Enter your password"]', PASSWORD);
    await click(page, 'Log In');
    await page.waitForFunction(() => location.pathname.startsWith('/dashboard'));
    await sleep(500);
    const landed = new URL(page.url()).pathname;
    await page.browserContext().close();
    ok(landed === '/dashboard/contacts', `landed on ${landed} instead of /dashboard/contacts`);
    return 'Redirected to login, then back to /dashboard/contacts';
  });

  await tc('TC-UI-08', 'Expired access token is refreshed silently', 'Replace the stored access token with an invalid one, open /dashboard/contacts', 'Page loads normally; a new access token is stored', async () => {
    const page = await newPage();
    const fresh = await api('POST', '/auth/login', { body: { email: U.email, password: PASSWORD } });
    await signIn(page, { tokens: fresh.body });
    await page.evaluate(() => localStorage.setItem('pingone.accessToken', 'expired.invalid.token'));
    await page.goto(`${APP}/dashboard/contacts`, { waitUntil: 'networkidle0' });
    await waitText(page, 'Add Contact');
    const stored = await page.evaluate(() => localStorage.getItem('pingone.accessToken'));
    ok(stored && stored !== 'expired.invalid.token', 'token not refreshed');
    await page.browserContext().close();
    return 'Contacts page loaded; access token replaced by a refreshed one';
  });

  await tc('TC-UI-09', 'Revoked session returns to login', 'Log out all devices from another session, then use the app here', 'Redirected to the login page', async () => {
    const V = await newUser('Revoke', 'Me');
    const page = await newPage();
    await signIn(page, V);
    await api('POST', '/auth/logout', { token: V.tokens.accessToken, body: { allDevices: true } });
    await page.evaluate(() => localStorage.setItem('pingone.accessToken', 'expired.invalid.token'));
    await page.goto(`${APP}/dashboard`, { waitUntil: 'networkidle0' });
    await waitPath(page, '/');
    await page.browserContext().close();
    return 'Redirected to /';
  });

  // ---- dashboard
  await fakeTelegram(U.id);
  const page = await newPage();
  await signIn(page, U);

  await tc('TC-UI-10', 'Dashboard loads', 'Open /dashboard', 'Greeting, composer, Platforms and Recent Activity sections', async () => {
    await page.goto(`${APP}/dashboard`, { waitUntil: 'networkidle0' });
    await waitText(page, 'Recent Activity');
    ok(await hasText(page, 'Platforms') && (await page.$('textarea[name="body"]')), 'sections missing');
    return 'Greeting, composer, Platforms, Recent Activity rendered';
  });

  await tc('TC-UI-11', 'Theme toggle is remembered', 'Click "Switch to dark mode", reload, then switch back', 'Dark mode applied and still on after reload', async () => {
    await click(page, 'Switch to dark mode');
    ok(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'not dark');
    await page.reload({ waitUntil: 'networkidle0' });
    await waitText(page, 'Recent Activity');
    ok(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'lost after reload');
    await click(page, 'Switch to light mode');
    return 'Dark after click and after reload; switched back to light';
  });

  // ---- contacts
  await tc('TC-UI-12', 'Add-contact form validation', 'Contacts → "Add Contact" → submit empty', '"First name is required."; dialog stays open', async () => {
    await page.goto(`${APP}/dashboard/contacts`, { waitUntil: 'networkidle0' });
    await click(page, 'Add Contact');
    await page.waitForSelector('input[name="firstName"]', { visible: true });
    await click(page, 'Add contact');
    await waitText(page, 'First name is required.');
    await click(page, 'Cancel');
    return '"First name is required." shown';
  });

  await tc('TC-UI-13', 'Add a contact', 'Fill first/last name, email, phone, Telegram username → "Add contact"', 'Dialog closes; contact appears; count is 1', async () => {
    await click(page, 'Add Contact');
    await typeInto(page, 'input[name="firstName"]', 'Rahul');
    await typeInto(page, 'input[name="lastName"]', 'Verma');
    await typeInto(page, 'input[name="email"]', 'rahul.qa@example.com');
    await typeInto(page, 'input[name="phone"]', '+91 98765 43210');
    await typeInto(page, 'input[name="telegramHandle"]', '@rahul_qa');
    await click(page, 'Add contact');
    await waitText(page, 'Contacts (1)');
    ok(await hasText(page, 'Rahul Verma'), 'contact not listed');
    return '"Rahul Verma" listed; tab shows Contacts (1)';
  });

  await tc('TC-UI-14', 'Search contacts', 'Add a second contact, type "Rahul" in the search box', 'Only matching contacts shown', async () => {
    await click(page, 'Add Contact');
    await typeInto(page, 'input[name="firstName"]', 'Sneha');
    await typeInto(page, 'input[name="telegramHandle"]', '@sneha_qa');
    await click(page, 'Add contact');
    await waitText(page, 'Contacts (2)');
    await typeInto(page, 'input[type="search"]', 'Rahul');
    // The list empties while the debounced search loads, so wait for the
    // final state rather than the first moment Sneha disappears.
    await page.waitForFunction(() => document.body.innerText.includes('Rahul Verma') && !document.body.innerText.includes('Sneha'));
    await page.click('input[type="search"]', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await waitText(page, 'Sneha');
    return 'Only "Rahul Verma" shown while searching';
  });

  await tc('TC-UI-15', 'Delete a contact', 'Click delete on a contact, confirm in the dialog', 'Confirmation asked; contact removed', async () => {
    await click(page, 'Delete Sneha', { exact: false });
    await waitText(page, 'Delete contact');
    await click(page, 'Delete');
    await page.waitForFunction(() => !document.body.innerText.includes('Sneha'));
    await waitText(page, 'Contacts (1)');
    return 'Confirmation dialog shown; "Sneha" removed; Contacts (1)';
  });

  // ---- composer
  const MSG = `UI test message ${RUN}`;
  await tc('TC-UI-16', 'Compose and send a message', 'Type a message → "Send Message" → Telegram → pick Rahul → "Send to 1 recipient"', 'Success message shown; delivery queued', async () => {
    await page.goto(`${APP}/dashboard`, { waitUntil: 'networkidle0' });
    await typeInto(page, 'textarea[name="body"]', MSG);
    await click(page, 'Send Message');
    await waitText(page, 'Send via');
    await click(page, 'Telegram', { exact: false });
    await waitText(page, 'Rahul Verma');
    await click(page, 'Rahul Verma', { exact: false });
    await click(page, 'Send to 1 recipient');
    const banner = await page.waitForSelector('[role="status"]', { visible: true }).then((h) => h.evaluate((e) => e.innerText.trim()));
    const deliveries = await prisma.messageDelivery.count({ where: { job: { userId: U.id } } });
    ok(deliveries === 1, `${deliveries} deliveries`);
    return `Banner: "${banner}"; 1 delivery queued`;
  });

  await tc('TC-UI-17', 'Message history shows the sent message', 'Open Message History', 'The message is listed', async () => {
    await page.goto(`${APP}/dashboard/history`, { waitUntil: 'networkidle0' });
    await waitText(page, MSG);
    return 'Sent message listed';
  });

  await tc('TC-UI-18', 'History search filter', 'Type part of the message in the history search', 'Matching message stays; nonsense search shows none', async () => {
    await typeInto(page, 'input[type="search"]', 'zzzz-no-match');
    await page.waitForFunction((m) => !document.body.innerText.includes(m), {}, MSG);
    await typeInto(page, 'input[type="search"]', 'UI test message');
    await waitText(page, MSG);
    return 'Filter hides non-matching and shows matching messages';
  });

  await tc('TC-UI-19', 'Schedule a message', 'Type a message → "Schedule" → Telegram → pick Rahul → continue → pick a time 1 hour ahead → "Schedule"', 'Message saved as a pending scheduled job, not sent now', async () => {
    await page.goto(`${APP}/dashboard`, { waitUntil: 'networkidle0' });
    await typeInto(page, 'textarea[name="body"]', `Scheduled ${RUN}`);
    await click(page, 'Schedule');
    await waitText(page, 'Send via');
    await click(page, 'Telegram', { exact: false });
    await click(page, 'Rahul Verma', { exact: false });
    await click(page, 'to 1 recipient', { exact: false });
    const input = await page.waitForSelector('input[type="datetime-local"]', { visible: true });
    const when = new Date(Date.now() + 3600e3);
    const local = new Date(when.getTime() - when.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
    await input.evaluate((el, v) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, local);
    await click(page, 'Schedule');
    await page.waitForSelector('[role="status"]', { visible: true });
    const job = await prisma.scheduledJob.findFirst({ where: { userId: U.id, message: { content: `Scheduled ${RUN}` } }, include: { status: true, deliveries: true } });
    ok(job && job.status.code === 'pending' && job.deliveries.length === 0, JSON.stringify(job && { s: job.status.code, d: job.deliveries.length }));
    return `Job saved pending for ${local.replace('T', ' ')}; 0 deliveries yet`;
  });

  // ---- templates
  await tc('TC-UI-20', 'Create a template', 'Templates → "Create Template" → name + content → "Create Template"', 'Template card appears', async () => {
    await page.goto(`${APP}/dashboard/templates`, { waitUntil: 'networkidle0' });
    await click(page, 'Create Template');
    await typeInto(page, 'input[placeholder^="e.g. Welcome Message"]', 'Welcome QA');
    await typeInto(page, 'textarea[name="content"]', 'Hi there, welcome to PingOne!');
    await click(page, 'Create Template');
    await waitText(page, 'Welcome QA');
    return '"Welcome QA" card shown';
  });

  await tc('TC-UI-21', 'Use a template in the composer', 'Dashboard → "Template" → choose "Welcome QA"', 'Composer filled with the template text', async () => {
    await page.goto(`${APP}/dashboard`, { waitUntil: 'networkidle0' });
    await click(page, 'Template');
    await click(page, 'Welcome QA', { exact: false });
    await page.waitForFunction(() => document.querySelector('textarea[name="body"]').value.includes('welcome to PingOne'));
    return 'Composer text = template content';
  });

  await tc('TC-UI-22', 'AI assistant in the composer', '"Write with AI" → describe the message → "Generate"', 'Generated text placed in the composer (or a clear error if the AI provider is unavailable)', async () => {
    await page.goto(`${APP}/dashboard`, { waitUntil: 'networkidle0' });
    // Start from an empty composer so leftover text can't look like a result.
    await page.click('textarea[name="body"]', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    ok(await page.$eval('textarea[name="body"]', (e) => e.value === ''), 'composer not empty');
    await click(page, 'Write with AI');
    await typeInto(page, 'input[placeholder="Describe the message you want…"],textarea[placeholder="Describe the message you want…"]', 'Remind the team about tomorrow 10am standup');
    await click(page, 'Generate');
    const outcome = await page.waitForFunction(() => {
      const v = document.querySelector('textarea[name="body"]')?.value;
      if (v && v.length > 10) return { ok: true, text: v };
      const alert = [...document.querySelectorAll('[role="alert"]')].map((e) => e.innerText.trim()).find(Boolean);
      return alert ? { ok: false, text: alert } : null;
    }, { timeout: 60000 }).then((h) => h.jsonValue());
    ok(outcome.ok, `AI error shown: "${outcome.text}"`);
    return `Composer filled: "${outcome.text.slice(0, 60)}…"`;
  });

  // ---- platforms
  await tc('TC-UI-23', 'Connect Telegram with an invalid bot token', 'Platforms → Telegram "Connect" → "Connect a bot" → paste invalid token', 'Error message shown in the dialog; nothing connected', async () => {
    const W = await newUser('Plat', 'Form');
    const p2 = await newPage();
    await signIn(p2, W);
    await p2.goto(`${APP}/dashboard/platforms`, { waitUntil: 'networkidle0' });
    await p2.waitForFunction(() => [...document.querySelectorAll('h3,h2')].some((h) => h.innerText.trim() === 'Telegram'));
    const btn = await p2.evaluateHandle(() => {
      const h = [...document.querySelectorAll('h3,h2')].find((x) => x.innerText.trim() === 'Telegram');
      let el = h;
      while (el && !el.querySelector('button')) el = el.parentElement;
      return [...el.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Connect');
    });
    await btn.asElement().click();
    await click(p2, 'Connect a bot', { exact: false });
    await typeInto(p2, 'input[name="botToken"]', '123456789:AAinvalidTokenForUiTest');
    await click(p2, 'Connect');
    const err = await p2.waitForSelector('[role="alert"]', { visible: true }).then((h) => h.evaluate((e) => e.innerText.trim()));
    const list = await api('GET', '/platforms', { token: W.tokens.accessToken });
    ok(list.body.data.length === 0, 'got connected');
    await p2.browserContext().close();
    return `Dialog error: "${err}"`;
  });

  // ---- settings
  await tc('TC-UI-24', 'Password strength meter', 'Settings → "Change Password" → type "abc", then "Abcd@1234xyz"', 'Shows "Weak", then "Strong"', async () => {
    await page.goto(`${APP}/dashboard/settings`, { waitUntil: 'networkidle0' });
    await click(page, 'Change Password');
    await typeInto(page, 'input[name="newPassword"]', 'abc');
    await waitText(page, 'Password strength: Weak');
    await typeInto(page, 'input[name="newPassword"]', 'Abcd@1234xyz');
    await waitText(page, 'Password strength: Strong');
    return '"Weak" for abc; "Strong" for Abcd@1234xyz';
  });

  await tc('TC-UI-25', 'Change password', 'Enter current password, new password twice → "Update password"', 'Dialog closes; new password works for login', async () => {
    await typeInto(page, 'input[name="currentPassword"]', PASSWORD);
    await typeInto(page, 'input[name="confirmPassword"]', 'Abcd@1234xyz');
    await click(page, 'Update password');
    await page.waitForFunction(() => !document.querySelector('input[name="currentPassword"]'));
    const l = await api('POST', '/auth/login', { body: { email: U.email, password: 'Abcd@1234xyz' } });
    ok(l.status === 200, `login with new password → ${l.status}`);
    U.password = 'Abcd@1234xyz';
    return 'Dialog closed; login with the new password → 200';
  });

  await tc('TC-UI-26', 'Notification preference toggle', 'Settings → toggle "Email me when a message fails to deliver"', 'Preference saved on the server', async () => {
    const before = (await api('GET', '/users/preferences', { token: (await api('POST', '/auth/login', { body: { email: U.email, password: U.password } })).body.accessToken })).body.data.notifyOnFailure;
    await page.click('input[aria-label="Email me when a message fails to deliver"]');
    await sleep(1500);
    const tok = (await api('POST', '/auth/login', { body: { email: U.email, password: U.password } })).body.accessToken;
    const after = (await api('GET', '/users/preferences', { token: tok })).body.data.notifyOnFailure;
    ok(after === !before, `${before} → ${after}`);
    return `notifyOnFailure ${before} → ${after} on the server`;
  });

  // ---- misc pages
  await tc('TC-UI-27', '404 page', 'Open /dashboard/does-not-exist, click "Back to dashboard"', '"Page not found"; button returns to /dashboard', async () => {
    await page.goto(`${APP}/dashboard/does-not-exist`, { waitUntil: 'networkidle0' });
    await waitText(page, 'Page not found');
    await click(page, 'Back to dashboard');
    await waitPath(page, '/dashboard');
    return '"Page not found" → back to /dashboard';
  });

  await tc('TC-UI-28', 'Mobile layout (375 px)', 'Open dashboard, contacts and settings at 375 × 812', 'No horizontal scrolling on any page', async () => {
    const m = await newPage({ width: 375, height: 812 });
    const fresh = await api('POST', '/auth/login', { body: { email: U.email, password: U.password } });
    await signIn(m, { tokens: fresh.body });
    const widths = [];
    for (const p of ['/dashboard', '/dashboard/contacts', '/dashboard/settings']) {
      await m.goto(APP + p, { waitUntil: 'networkidle0' });
      await sleep(400);
      const w = await m.evaluate(() => document.documentElement.scrollWidth);
      widths.push(`${p} ${w}px`);
      ok(w <= 375, `${p} is ${w}px wide`);
    }
    await m.browserContext().close();
    return widths.join(', ');
  });

  await tc('TC-UI-29', 'Forgot password page', '/forgot-password → enter an email → submit', '"Check your email" confirmation', async () => {
    const p3 = await newPage();
    await p3.goto(`${APP}/forgot-password`, { waitUntil: 'networkidle0' });
    await typeInto(p3, 'input[type="email"]', `pingone-qa-${RUN}-nobody@example.com`);
    await click(p3, 'link', { exact: false, tag: 'button[type="submit"]' }).catch(() => p3.keyboard.press('Enter'));
    await waitText(p3, 'Check your email');
    await p3.browserContext().close();
    return '"Check your email" shown';
  });

  await tc('TC-UI-30', 'Reset password with an invalid link', '/reset-password?token=invalid → enter a new password twice → submit', '"This link has expired" with a way to request a new link', async () => {
    const p4 = await newPage();
    await p4.goto(`${APP}/reset-password?token=invalid-token`, { waitUntil: 'networkidle0' });
    await typeInto(p4, 'input[placeholder="Enter a new password"]', 'Brand@New123');
    await typeInto(p4, 'input[placeholder="Re-enter the new password"]', 'Brand@New123');
    await p4.keyboard.press('Enter');
    await waitText(p4, 'This link has expired');
    ok(await hasText(p4, 'Request a new link'), 'no request link');
    await p4.browserContext().close();
    return '"This link has expired" + "Request a new link"';
  });

  await tc('TC-UI-31', 'Admin console access', 'Log in at /admin/login as a normal user, then as an admin', 'Normal user refused with a message; admin reaches the admin dashboard', async () => {
    const p5 = await newPage();
    await p5.goto(`${APP}/admin/login`, { waitUntil: 'networkidle0' });
    await typeInto(p5, 'input[placeholder="you@company.com"]', U.email);
    await typeInto(p5, 'input[placeholder="Enter your password"]', U.password);
    await p5.keyboard.press('Enter');
    const refused = await p5.waitForSelector('[role="alert"]', { visible: true }).then((h) => h.evaluate((e) => e.innerText.trim()));
    const A = await newUser('Admin', 'Ui');
    await prisma.user.update({ where: { id: A.id }, data: { role: 'ADMIN' } });
    await typeInto(p5, 'input[placeholder="you@company.com"]', A.email);
    await typeInto(p5, 'input[placeholder="Enter your password"]', PASSWORD);
    await p5.keyboard.press('Enter');
    await waitPath(p5, '/admin');
    await sleep(1500);
    const text = await p5.evaluate(() => document.body.innerText.slice(0, 400));
    ok(!/Administrator access is required/.test(text), 'admin dashboard refused');
    await p5.browserContext().close();
    return `User refused ("${refused}"); admin reached /admin`;
  });

  await tc('TC-UI-32', 'Sign out', 'User menu → "Sign out", then open /dashboard', 'Back on the login page; dashboard no longer reachable', async () => {
    const fresh = await api('POST', '/auth/login', { body: { email: U.email, password: U.password } });
    const p6 = await newPage();
    await signIn(p6, { tokens: fresh.body });
    await p6.goto(`${APP}/dashboard`, { waitUntil: 'networkidle0' });
    await click(p6, 'Kavya Rao', { exact: false });
    await click(p6, 'Sign out');
    await waitPath(p6, '/');
    await p6.goto(`${APP}/dashboard`, { waitUntil: 'networkidle0' });
    await waitPath(p6, '/');
    await p6.browserContext().close();
    return 'Signed out; /dashboard redirects to login';
  });

  await tc('TC-UI-33', 'Delete account', 'Settings → "Delete account" → password + type DELETE → "Delete my account"', 'Signed out; the account can no longer log in', async () => {
    const fresh = await api('POST', '/auth/login', { body: { email: U.email, password: U.password } });
    const p7 = await newPage();
    await signIn(p7, { tokens: fresh.body });
    await p7.goto(`${APP}/dashboard/settings`, { waitUntil: 'networkidle0' });
    await click(p7, 'Delete account');
    await typeInto(p7, 'input[name="password"]', U.password);
    await typeInto(p7, 'input[name="confirmText"]', 'DELETE');
    await click(p7, 'Delete my account');
    await waitPath(p7, '/');
    const l = await api('POST', '/auth/login', { body: { email: U.email, password: U.password } });
    ok(l.status === 401 || l.status === 403, `login → ${l.status}`);
    await p7.browserContext().close();
    return `Redirected to login; login afterwards → ${l.status}`;
  });
} catch (err) {
  console.error('UI suite aborted:', err);
  results.push({ id: 'UI-SUITE', module: 'Frontend (UI)', scenario: 'Suite aborted', steps: '', expected: '', actual: err.message, status: 'FAIL' });
} finally {
  await browser.close();
  // Counted before any merge, so the summary describes this run only.
  const counts = { PASS: 0, FAIL: 0 };
  for (const r of results) counts[r.status] += 1;
  mkdirSync(path.dirname(OUT), { recursive: true });
  // A partial run (--only) updates its rows in the last full results instead
  // of replacing them, so the report keeps every test.
  if (ONLY && existsSync(OUT)) {
    const previous = JSON.parse(readFileSync(OUT, 'utf8')).results ?? [];
    const fresh = new Map(results.map((r) => [r.id, r]));
    const merged = previous.map((r) => fresh.get(r.id) ?? r);
    for (const r of results) if (!previous.some((p) => p.id === r.id)) merged.push(r);
    results.splice(0, results.length, ...merged);
  }
  writeFileSync(OUT, JSON.stringify({ run: RUN, results }, null, 2));
  console.log(`\n${counts.PASS} passed, ${counts.FAIL} failed — ${OUT}`);
  try {
    console.log(`Cleaned up ${await cleanupTestData(`pingone-qa-${RUN}-`)} test account(s).`);
  } catch (err) {
    console.error('Cleanup failed:', err.message);
  }
  await prisma.$disconnect();
  process.exitCode = counts.FAIL ? 1 : 0;
}
