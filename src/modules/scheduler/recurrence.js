// ============================================================
// Computes the next run time for a recurring ScheduledJob.
//
// NOTE ON maxOccurrences: the schema tracks `maxOccurrences` on
// RecurrenceRule but there's no occurrence counter on ScheduledJob
// itself. If you want that limit enforced, add
// `occurrenceCount Int @default(0)` to ScheduledJob and increment it
// each firing — left as-is for now since it wasn't in the original
// schema and I didn't want to change it without you confirming.
// ============================================================

import { RECURRENCE_TYPE } from '../../constants/codes.js';

/**
 * @param {Date} fromDate  the run that just fired
 * @param {{ recurrenceType: {code: string}, intervalValue: number, endDate: Date|null }} rule
 * @returns {Date|null}  next run date, or null if the job shouldn't run again
 */
export function computeNextRun(fromDate, rule) {
  if (!rule) return null; // one-time job

  const next = new Date(fromDate);
  const interval = rule.intervalValue ?? 1;

  switch (rule.recurrenceType.code) {
    case RECURRENCE_TYPE.DAILY:
      next.setDate(next.getDate() + interval);
      break;
    case RECURRENCE_TYPE.WEEKLY:
      next.setDate(next.getDate() + 7 * interval);
      break;
    case RECURRENCE_TYPE.MONTHLY:
      next.setMonth(next.getMonth() + interval);
      if (rule.dayOfMonth) next.setDate(rule.dayOfMonth);
      break;
    case RECURRENCE_TYPE.YEARLY:
      next.setFullYear(next.getFullYear() + interval);
      break;
    case RECURRENCE_TYPE.ONCE:
    default:
      return null;
  }

  if (rule.endDate && next > rule.endDate) return null;
  return next;
}
