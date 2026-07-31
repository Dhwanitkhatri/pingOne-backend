// ============================================================
// Shared code constants. These MUST match the `code` values seeded
// into message_statuses / recurrence_types / platforms. If your seed
// script uses different strings, update these to match — don't change
// them independently on each side.
// ============================================================

export const MESSAGE_STATUS = Object.freeze({
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/**
 * How far along the delivery lifecycle each status is. Webhooks arrive out of
 * order surprisingly often (Meta will hand you `read` before `delivered`), so
 * status transitions compare ranks and refuse to move backwards — otherwise a
 * late-arriving `delivered` callback would silently un-read a message.
 *
 * `failed` and `cancelled` are terminal: nothing overwrites them.
 */
export const STATUS_RANK = Object.freeze({
  [MESSAGE_STATUS.PENDING]: 0,
  [MESSAGE_STATUS.SENDING]: 1,
  [MESSAGE_STATUS.SENT]: 2,
  [MESSAGE_STATUS.DELIVERED]: 3,
  [MESSAGE_STATUS.READ]: 4,
  [MESSAGE_STATUS.FAILED]: 5,
  [MESSAGE_STATUS.CANCELLED]: 5,
});

/** Statuses that count as a successful delivery for analytics purposes. */
export const SUCCESS_STATUSES = Object.freeze([
  MESSAGE_STATUS.SENT,
  MESSAGE_STATUS.DELIVERED,
  MESSAGE_STATUS.READ,
]);

/** Goes into DeliveryStatusLog.changedBy — VarChar(20), keep these short. */
export const CHANGED_BY = Object.freeze({
  SYSTEM: 'system',
  WEBHOOK: 'webhook',
  USER: 'user',
});

export const RECURRENCE_TYPE = Object.freeze({
  ONCE: 'none', // matches seed.js's actual code — the seed calls it "none", not "once"
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
});

export const PLATFORM = Object.freeze({
  TELEGRAM: 'telegram',
  WHATSAPP: 'whatsapp',
  GMAIL: 'gmail',
  SMS: 'sms',
});

// Retry backoff schedule (ms) — attempt 1 fails -> wait BACKOFF[0] -> attempt 2 ...
export const RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000];
export const MAX_RETRY_ATTEMPTS = RETRY_BACKOFF_MS.length;

/**
 * Day tokens accepted in RecurrenceRule.daysOfWeek ("MON,WED,FRI"), indexed to
 * match JavaScript's Date#getDay() (0 = Sunday).
 */
export const DAY_TOKENS = Object.freeze(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);