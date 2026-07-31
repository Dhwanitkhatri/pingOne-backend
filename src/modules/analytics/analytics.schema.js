// ============================================================
// Query validation for the analytics endpoints.
//
// Every endpoint takes the same optional window (`from`/`to`) and defaults to
// the last 30 days, so a caller with no params gets something useful instead of
// a full-table scan.
// ============================================================

import { z } from 'zod';

const DEFAULT_WINDOW_DAYS = 30;

/**
 * IANA zone name, validated by asking Intl whether it can actually format with
 * it. Guessing a regex here would either reject valid zones or let an invalid
 * one reach Postgres, where it becomes a query error instead of a 400.
 */
const timezoneSchema = z.string().trim().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Not a recognised IANA timezone (e.g. "Asia/Kolkata")' }
);

export const dateRangeSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    platform: z.enum(['telegram', 'whatsapp', 'gmail', 'sms']).optional(),
  })
  .transform(applyDefaultWindow)
  .refine((range) => range.from <= range.to, {
    message: '`from` must be earlier than `to`',
  });

export const deliveryRatesSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    platform: z.enum(['telegram', 'whatsapp', 'gmail', 'sms']).optional(),
    // Passed to Postgres date_trunc(). Constrained to an enum so the value can
    // never be anything but one of these three.
    bucket: z.enum(['day', 'week', 'month']).default('day'),
  })
  .transform(applyDefaultWindow)
  .refine((range) => range.from <= range.to, {
    message: '`from` must be earlier than `to`',
  });

export const bestSendTimesSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    platform: z.enum(['telegram', 'whatsapp', 'gmail', 'sms']).optional(),
    // Timestamps are stored in UTC; "best hour to send" is only meaningful in
    // the audience's local time, so the caller says which zone to report in.
    timezone: timezoneSchema.default('UTC'),
    // Hours with fewer sends than this are excluded from the recommendation —
    // a single lucky send is not a 100%-performing hour.
    minSample: z.coerce.number().int().min(1).max(1000).default(5),
  })
  .transform(applyDefaultWindow)
  .refine((range) => range.from <= range.to, {
    message: '`from` must be earlier than `to`',
  });

/** Fills in a trailing 30-day window when either bound is omitted. */
function applyDefaultWindow(query) {
  const to = query.to ?? new Date();
  const from =
    query.from ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  return { ...query, from, to };
}
