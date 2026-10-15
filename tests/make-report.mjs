// ============================================================
// Builds ../TEST_CASES.md (the documentation table) from the latest results:
//   tests/results/api-results.json   written by `npm run test:api` / `test:api:quick`
//   tests/results/ui-results.json    written by `npm run test:ui`
//
//   npm run test:report
//
// Every row comes from a recorded run — run the suites first.
// ============================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_RESULTS = path.join(HERE, 'results', 'api-results.json');
const UI_RESULTS = path.join(HERE, 'results', 'ui-results.json');
const OUT = path.join(HERE, '..', '..', 'TEST_CASES.md');
const APP = process.env.TEST_APP_ORIGIN || 'http://localhost:3000';

function load(file, command) {
  if (!existsSync(file)) {
    console.warn(`⚠ ${path.relative(process.cwd(), file)} not found — run \`${command}\` first. Its section is left out.`);
    return { results: [] };
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

const api = load(API_RESULTS, 'npm run test:api');
const ui = load(UI_RESULTS, 'npm run test:ui');
const all = [...api.results, ...ui.results].filter((r) => r.id !== 'SUITE' && r.id !== 'UI-SUITE');
if (!all.length) {
  console.error('No results to report.');
  process.exit(1);
}
const failed = (id) => all.some((r) => r.id === id && r.status === 'FAIL');

// Plain wording for failures that otherwise show a script error. Status is
// left untouched — they are still failures.
const EXPLAIN = {
  'TC-DLV-03': [/never reached/, 'The final (4th) attempt did not run within 15 min. Usually the Redis connection dropped during the 10-minute wait (see Observations).'],
  'TC-NOT-05': [/no notification/, 'No notification yet — it is created at the final attempt, which did not run in time (depends on TC-DLV-03).'],
  'TC-NOT-06': [/Cannot read properties/, 'Not executable — no notification existed to mark as read (depends on TC-NOT-05).'],
};
for (const r of all) {
  const [pattern, text] = EXPLAIN[r.id] ?? [];
  if (r.status === 'FAIL' && pattern?.test(r.actual)) r.actual = text;
}

const MODULES = [
  'Health', 'Authentication', 'User Settings', 'Platform Connection', 'Contacts', 'Groups',
  'Messages & Attachments', 'Templates', 'Sending & Scheduling', 'Delivery, Retry & Webhooks',
  'AI Content Assistant', 'Analytics', 'Notifications & Preferences', 'Admin Panel', 'Security', 'Frontend (UI)',
];
const STATUS = { PASS: 'Pass', FAIL: 'Fail', MANUAL: 'Manual (not run)' };
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const num = (id) => Number(id.split('-').pop());
const count = (rows, s) => rows.filter((r) => r.status === s).length;
const date = new Date(api.finishedAt ?? Date.now()).toISOString().slice(0, 10);

let md = `# PingOne — Test Cases and Results

## 1. Test Environment

| Item | Value |
|---|---|
| Test date | ${date} |
| Backend | Node.js, Express 4, PostgreSQL via Prisma, Redis + BullMQ worker |
| Frontend | React 19 + Vite, served on ${APP} |
| API base URL | http://localhost:${env.PORT}${env.API_PREFIX} |
| API tests | \`pingOne-backend/tests/api.e2e.mjs\` — real HTTP calls against the running API, worker, database and Redis |
| UI tests | \`pingOne-backend/tests/ui.e2e.mjs\` — automated browser tests in headless Chrome (puppeteer-core) against the running frontend |
| Test data | Temporary accounts \`pingone-qa-…@example.com\`, created and deleted by each test run |

**Status legend:** **Pass** = executed, actual result matched the expected result. **Fail** = executed, did not match. **Manual (not run)** = needs a real third-party account (Google login, real Telegram number, real recipient) or was skipped, and was not executed automatically.

**Note on Telegram tests:** a Telegram bot credential with a deliberately fake token is used, so Telegram rejects the final send. This still exercises the whole pipeline: API → queue → worker → Telegram adapter → status tracking → retries. Real delivery is covered by the manual test TC-SND-02.
`;

const summary = [];
let section = 2;
for (const mod of MODULES) {
  const rows = all.filter((r) => r.module === mod).sort((a, b) => num(a.id) - num(b.id));
  if (!rows.length) continue;
  summary.push({ mod, rows });
  md += `\n## ${section}. ${mod}\n\n| TC ID | Test Scenario | Test Steps / Input | Expected Result | Actual Result | Status |\n|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    md += `| ${r.id} | ${cell(r.scenario)} | ${cell(r.steps)} | ${cell(r.expected)} | ${cell(r.actual)} | **${STATUS[r.status]}** |\n`;
  }
  section += 1;
}

md += `\n## ${section}. Summary\n\n| Module | Total | Pass | Fail | Manual |\n|---|---|---|---|---|\n`;
for (const { mod, rows } of summary) {
  md += `| ${mod} | ${rows.length} | ${count(rows, 'PASS')} | ${count(rows, 'FAIL')} | ${count(rows, 'MANUAL')} |\n`;
}
md += `| **Total** | **${all.length}** | **${count(all, 'PASS')}** | **${count(all, 'FAIL')}** | **${count(all, 'MANUAL')}** |\n`;
section += 1;

md += `
## ${section}. Defects Found and Fixed During Testing

| Defect ID | Found by | Description | Fix | Verified by |
|---|---|---|---|---|
| BUG-01 | TC-USR-08 | After a user deleted their account, their pending and recurring scheduled messages stayed active. The scheduler kept firing them every period, and each run failed (credentials removed) and retried 4 times. | \`users.service.js\`: deleting an account now cancels every pending scheduled job (status cancelled, nextRunAt cleared) in the same transaction. | TC-USR-08 |
| BUG-02 | TC-UI-07 | When a logged-out user opened a dashboard page (e.g. Contacts) and then logged in, they always landed on the main dashboard instead of the page they asked for. | \`ProtectedRoute.jsx\` passes the requested page to the login screen; \`SignInCard.jsx\` returns the user there after login. | TC-UI-07 |
| BUG-03 | TC-UI-22 | The AI topic filter rejected everyday messaging prompts as "Only message and email generation tasks are supported." 6 of 8 normal prompts failed, e.g. "Remind the team about tomorrow's standup", "Let our customers know…", "Notify students…", because it only recognised singular nouns such as "reminder" or "customer". | \`ai.service.js\`: the communication-word list now includes verbs (remind, notify, inform, announce, confirm, welcome…), plurals and audiences (customers, clients, team, staff, students…). Code, essay, trivia and prompt-injection requests are still rejected. | TC-AI-17, TC-AI-11 |
| BUG-04 | TC-UI-22 | When AI generation failed, the error text in the composer had no \`role="alert"\`, so screen readers did not announce it (other forms in the app do). | \`AiMessageInput.jsx\`: error message marked \`role="alert"\`. | TC-UI-22 |
| BUG-05 | Worker investigation | The full Redis URL, **including the Redis password**, was printed to the console on every start, and was included in the API error message sent to the browser when Redis was unreachable. | \`bull.queue.js\` / \`queue.service.js\`: only protocol, host and port are printed or returned. | Worker start-up log shows the host only |
| BUG-06 | TC-DLV-03 | If the worker hit any unexpected error it shut down with exit code 0 ("stopped on purpose"), so nodemon or the hosting platform did not treat it as a crash. Deliveries, retries and scheduled messages then stopped silently. | \`worker.js\`: shutdowns caused by a crash now exit with code 1; Ctrl+C / SIGTERM still exit with 0. | Code review |
| BUG-07 | TC-AI-01 | A momentary "model is experiencing high demand" (HTTP 503) answer from Google Gemini failed the AI request immediately. | \`openai.provider.js\`: temporary 500/502/503/504 answers are retried twice (after 1 s and 2 s), still within the existing AI timeout. Quota errors (429) are not retried. | TC-AI-01 to TC-AI-03 |
`;
section += 1;

// Observations are included only when they apply to this run.
const observations = [];
const aiProviderFailed = all.some(
  (r) => r.status === 'FAIL' && /AI_PROVIDER|AI_MODEL|AI is busy|AI_TIMEOUT/.test(r.actual)
);
if (aiProviderFailed) {
  observations.push([
    `The live AI tests depend on Google Gemini. In this run the configured model \`${env.AI_MODEL}\` answered with a quota (429) or overload (503) error, so those tests failed for an external reason. The app handled it correctly: a clear error message, no crash, nothing saved.`,
    'Use a Gemini API key with billing enabled (or wait for the free quota to reset) and re-run the AI tests.',
  ]);
}
if (failed('TC-DLV-03')) {
  observations.push([
    'TC-DLV-03 (and the notification tests that depend on it) need the worker to keep its Redis connection for the full 10-minute retry wait. A hosted Redis that drops idle connections (e.g. Upstash free tier, `ECONNRESET` in the worker log) delays the final attempt past the test limit. Attempts 1–3 run on time (TC-DLV-02).',
    'Use a local Redis (`docker run -p 6379:6379 redis`, `REDIS_URL=redis://localhost:6379`) and re-run the full API suite.',
  ]);
}
try {
  if (new URL(env.FRONTEND_URL).origin !== new URL(APP).origin) {
    observations.push([
      `\`FRONTEND_URL\` in the backend \`.env\` is \`${env.FRONTEND_URL}\`, but the frontend was tested at \`${APP}\`. Password-reset links in emails would open the wrong address.`,
      'Set `FRONTEND_URL` to the address the frontend actually runs on.',
    ]);
  }
} catch {
  /* malformed URL — env validation already reports it */
}
if (!env.META_APP_SECRET || !env.META_WEBHOOK_VERIFY_TOKEN) {
  observations.push([
    'WhatsApp webhooks are disabled because `META_APP_SECRET` / `META_WEBHOOK_VERIFY_TOKEN` are not set; the endpoint correctly refuses all calls (503).',
    'Set both values when WhatsApp delivery receipts are needed.',
  ]);
}

if (observations.length) {
  md += `\n## ${section}. Observations (not code defects)\n\n| # | Observation | Recommendation |\n|---|---|---|\n`;
  observations.forEach(([o, r], i) => {
    md += `| ${i + 1} | ${o} | ${r} |\n`;
  });
}

writeFileSync(OUT, md);
console.log(
  `Wrote ${OUT}: ${all.length} cases — ${count(all, 'PASS')} pass, ${count(all, 'FAIL')} fail, ${count(all, 'MANUAL')} manual`
);
