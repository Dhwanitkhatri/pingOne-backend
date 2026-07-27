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