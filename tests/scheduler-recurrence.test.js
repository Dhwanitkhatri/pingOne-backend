import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { computeNextRun, computeNextRunAfter } from '../src/modules/scheduler/recurrence.js';

function recurrence(typeCode, options = {}) {
  return {
    recurrenceType: { code: typeCode },
    intervalValue: 1,
    daysOfWeek: null,
    dayOfMonth: null,
    monthOfYear: null,
    endDate: null,
    maxOccurrences: null,
    ...options,
  };
}

function localDate(year, monthIndex, day, hour = 9, minute = 15) {
  return new Date(year, monthIndex, day, hour, minute, 0, 0);
}

function localParts(date) {
  return [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
  ];
}

test('monthly dates 29, 30, and 31 clamp in February and return to the requested day', () => {
  for (const day of [29, 30, 31]) {
    const rule = recurrence('monthly', { dayOfMonth: day });
    const january = localDate(2025, 0, day);
    const february = computeNextRun(january, rule);
    const march = computeNextRun(february, rule);

    assert.deepEqual(localParts(february), [2025, 2, 28, 9, 15], `February for day ${day}`);
    assert.deepEqual(localParts(march), [2025, 3, day, 9, 15], `March for day ${day}`);
  }
});

test('yearly February 29 clamps in non-leap years and returns on the next leap year', () => {
  const rule = recurrence('yearly', { monthOfYear: 2, dayOfMonth: 29 });
  let run = localDate(2024, 1, 29);
  const expected = [
    [2025, 2, 28],
    [2026, 2, 28],
    [2027, 2, 28],
    [2028, 2, 29],
  ];

  for (const [year, month, day] of expected) {
    run = computeNextRun(run, rule);
    assert.deepEqual(localParts(run), [year, month, day, 9, 15]);
  }
});

test('daily recurrence preserves local wall time across DST and varies by server timezone', () => {
  // The implementation documents server-local calendar arithmetic. Each child
  // process isolates TZ so these expectations do not depend on the test host.
  // The project does not define how client ISO timestamps should map to a
  // user's intended timezone; these checks cover recurrence arithmetic only.
  const recurrenceUrl = new URL('../src/modules/scheduler/recurrence.js', import.meta.url).href;
  const childSource = `
    import { computeNextRun } from ${JSON.stringify(recurrenceUrl)};
    const rule = {
      recurrenceType: { code: 'daily' }, intervalValue: 1,
      daysOfWeek: null, dayOfMonth: null, monthOfYear: null,
      endDate: null, maxOccurrences: null,
    };
    const summarize = (year, month, day) => {
      const from = new Date(year, month - 1, day, 9, 30, 0, 0);
      const next = computeNextRun(from, rule);
      return {
        from: [from.getFullYear(), from.getMonth() + 1, from.getDate(), from.getHours(), from.getMinutes()],
        next: [next.getFullYear(), next.getMonth() + 1, next.getDate(), next.getHours(), next.getMinutes()],
        elapsedHours: (next - from) / 3600000,
        fromIso: from.toISOString(),
      };
    };
    console.log(JSON.stringify({ spring: summarize(2024, 3, 9), fall: summarize(2024, 11, 2), utc: summarize(2024, 3, 9) }));
  `;

  function runInTimezone(timezone) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
      encoding: 'utf8',
      env: { ...process.env, TZ: timezone },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }

  const newYork = runInTimezone('America/New_York');
  const utc = runInTimezone('UTC');

  assert.deepEqual(newYork.spring.next, [2024, 3, 10, 9, 30]);
  assert.equal(newYork.spring.elapsedHours, 23);
  assert.deepEqual(newYork.fall.next, [2024, 11, 3, 9, 30]);
  assert.equal(newYork.fall.elapsedHours, 25);
  assert.deepEqual(utc.utc.next, [2024, 3, 10, 9, 30]);
  assert.equal(utc.utc.elapsedHours, 24);
  assert.notEqual(newYork.spring.fromIso, utc.utc.fromIso);
});

test('catch-up skips elapsed daily occurrences and selects the first future run', () => {
  const rule = recurrence('daily');
  const from = localDate(2025, 0, 1);
  const now = localDate(2025, 0, 4);
  const result = computeNextRunAfter(from, rule, 1, now);

  assert.equal(result.skipped, 3);
  assert.deepEqual(localParts(result.nextRunAt), [2025, 1, 5, 9, 15]);
});

test('catch-up counts skipped occurrences against maxOccurrences', () => {
  const rule = recurrence('daily', { maxOccurrences: 3 });
  const from = localDate(2025, 0, 1);
  const now = localDate(2025, 0, 10);
  const result = computeNextRunAfter(from, rule, 1, now);

  assert.equal(result.skipped, 2);
  assert.equal(result.nextRunAt, null);
});

test('endDate includes the final calendar day and terminates the recurrence afterward', () => {
  const endDate = localDate(2025, 0, 2, 0, 0);
  const rule = recurrence('daily', { endDate });
  const from = localDate(2025, 0, 1, 23, 15);
  const lastRun = computeNextRun(from, rule);

  assert.deepEqual(localParts(lastRun), [2025, 1, 2, 23, 15]);
  assert.equal(computeNextRun(lastRun, rule), null);
});

test('catch-up stops at endDate and reports only the missed runs inside the series', () => {
  const endDate = localDate(2025, 0, 3, 0, 0);
  const rule = recurrence('daily', { endDate });
  const from = localDate(2025, 0, 1);
  const now = localDate(2025, 0, 10);
  const result = computeNextRunAfter(from, rule, 1, now);

  assert.equal(result.skipped, 2);
  assert.equal(result.nextRunAt, null);
});
