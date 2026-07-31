// ============================================================
// Computes the next run time for a recurring ScheduledJob.
//
// Everything here is a pure function of (previous run, rule, occurrences so
// far) — no DB, no clock reads except the explicit `now` you pass to
// computeNextRunAfter(). That keeps it trivially unit-testable and means the
// scheduler worker can replay a schedule without side effects.
//
// Termination is checked in this order, and any one of them ends the series:
//   1. recurrence type is `none`      -> one-time job, never runs again
//   2. maxOccurrences already reached -> series complete
//   3. next run would fall past endDate
//
// TIMEZONE: the arithmetic uses local-time Date methods (getDay, setDate, ...),
// so "which day of the week" and "which day of the month" are decided in the
// *server's* timezone. scheduled_at is a naive TIMESTAMP with no zone, so that's
// the only consistent interpretation available without a per-user timezone
// column. Run the API and worker in the same timezone (UTC is the sane choice).
// If per-user timezones are added later, this is the module to revisit — and the
// tests in it are pure functions, so the change is verifiable.
// ============================================================

import { RECURRENCE_TYPE, DAY_TOKENS } from '../../constants/codes.js';

/**
 * The next run strictly after `fromDate`, or null if the series is over.
 *
 * @param {Date} fromDate the run that just fired
 * @param {{ recurrenceType: {code: string}, intervalValue: number|null,
 *           daysOfWeek: string|null, dayOfMonth: number|null,
 *           monthOfYear: number|null, endDate: Date|null,
 *           maxOccurrences: number|null } | null} rule
 * @param {number} [occurrenceCount] runs completed so far, including the one
 *   that just fired. Omit only if the job has no maxOccurrences limit.
 * @returns {Date|null}
 */
export function computeNextRun(fromDate, rule, occurrenceCount = 0) {
  if (!rule) return null; // one-time job — no recurrence row attached

  const typeCode = rule.recurrenceType?.code;
  if (!typeCode || typeCode === RECURRENCE_TYPE.ONCE) return null;

  // The run that just fired counts, so once occurrenceCount hits the cap we're
  // done — there is no "next" run to schedule.
  if (rule.maxOccurrences != null && occurrenceCount >= rule.maxOccurrences) {
    return null;
  }

  const interval = Math.max(1, rule.intervalValue ?? 1);
  const from = new Date(fromDate);
  let next;

  switch (typeCode) {
    case RECURRENCE_TYPE.DAILY:
      next = addDays(from, interval);
      break;

    case RECURRENCE_TYPE.WEEKLY:
      next = nextWeekly(from, interval, parseDaysOfWeek(rule.daysOfWeek));
      break;

    case RECURRENCE_TYPE.MONTHLY:
      next = addMonths(from, interval, rule.dayOfMonth);
      break;

    case RECURRENCE_TYPE.YEARLY:
      next = addYears(from, interval, rule.monthOfYear, rule.dayOfMonth);
      break;

    default:
      return null; // unknown code — treat as one-time rather than guessing
  }

  return withinEndDate(next, rule.endDate) ? next : null;
}

/**
 * Fast-forwards a stale schedule. If the worker was down for three days, a
 * daily job's nextRunAt is three intervals in the past — firing it three times
 * in a row would spam every recipient, so instead we walk the series forward to
 * the first run that hasn't happened yet and skip the missed ones.
 *
 * @returns {{ nextRunAt: Date|null, skipped: number }} `skipped` is how many
 *   occurrences were passed over, so the caller can log it and still count them
 *   against maxOccurrences.
 */
export function computeNextRunAfter(fromDate, rule, occurrenceCount = 0, now = new Date()) {
  let candidate = computeNextRun(fromDate, rule, occurrenceCount);
  let skipped = 0;

  // Bounded so a malformed rule can never spin forever.
  const MAX_CATCHUP_STEPS = 1000;

  while (candidate && candidate <= now && skipped < MAX_CATCHUP_STEPS) {
    skipped += 1;
    candidate = computeNextRun(candidate, rule, occurrenceCount + skipped);
  }

  return { nextRunAt: candidate, skipped };
}

/**
 * "MON,WED,FRI" -> [1, 3, 5], sorted, deduped, matching Date#getDay().
 * Unrecognised tokens are ignored rather than thrown — the value is validated
 * at the API boundary, and a bad row in the DB shouldn't wedge the worker.
 */
export function parseDaysOfWeek(daysOfWeek) {
  if (!daysOfWeek) return [];

  const indexes = new Set();
  for (const token of daysOfWeek.split(',')) {
    const index = DAY_TOKENS.indexOf(token.trim().toUpperCase());
    if (index !== -1) indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b);
}

// ---- per-type arithmetic -------------------------------------------
// All of these preserve the time-of-day of the original run.

function addDays(from, days) {
  const next = new Date(from);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Weekly, honouring daysOfWeek. With days selected, `interval` means "every N
 * weeks" and the job fires on each selected day within an active week:
 *
 *   MON,WED,FRI every 1 week  ->  Mon, Wed, Fri, Mon, Wed, Fri, ...
 *   TUE every 2 weeks         ->  Tue, (skip a week), Tue, ...
 *
 * With no days selected we fall back to "same weekday, N weeks later".
 */
function nextWeekly(from, interval, dayIndexes) {
  if (dayIndexes.length === 0) return addDays(from, 7 * interval);

  const currentDay = from.getDay();

  // Another selected day later this same week? Fire on that.
  const laterThisWeek = dayIndexes.find((d) => d > currentDay);
  if (laterThisWeek !== undefined) {
    return addDays(from, laterThisWeek - currentDay);
  }

  // Otherwise jump to the first selected day of the next active week.
  const daysToWeekStart = 7 - currentDay; // -> upcoming Sunday
  const weeksToSkip = interval - 1; // interval 1 = next week, 2 = skip one, ...
  return addDays(from, daysToWeekStart + weeksToSkip * 7 + dayIndexes[0]);
}

/**
 * Monthly, without the classic overflow bug: plain setMonth() turns
 * Jan 31 + 1 month into Mar 3 (because Feb 31 doesn't exist and Date rolls
 * over). We clamp to the last valid day of the target month instead.
 */
function addMonths(from, months, dayOfMonth) {
  const next = new Date(from);
  const targetDay = dayOfMonth ?? from.getDate();

  next.setDate(1); // park on a day every month has before shifting
  next.setMonth(next.getMonth() + months);
  next.setDate(Math.min(targetDay, daysInMonth(next.getFullYear(), next.getMonth())));

  return next;
}

/** Yearly. monthOfYear is 1-12 from the API; JS months are 0-11. */
function addYears(from, years, monthOfYear, dayOfMonth) {
  const next = new Date(from);
  const targetMonth = monthOfYear != null ? monthOfYear - 1 : from.getMonth();
  const targetDay = dayOfMonth ?? from.getDate();

  next.setDate(1);
  next.setFullYear(next.getFullYear() + years);
  next.setMonth(targetMonth);
  // Feb 29 on a non-leap year clamps to Feb 28 rather than sliding into March.
  next.setDate(Math.min(targetDay, daysInMonth(next.getFullYear(), targetMonth)));

  return next;
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * endDate is a DATE column (midnight), so a naive `next > endDate` would drop
 * the final day's run for any job that sends at, say, 09:00. Compare against
 * the end of that day instead.
 */
function withinEndDate(next, endDate) {
  if (!endDate) return true;

  const cutoff = new Date(endDate);
  cutoff.setHours(23, 59, 59, 999);
  return next <= cutoff;
}
