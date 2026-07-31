// ============================================================
// Analytics aggregations. Read-only, always scoped to one user.
//
// These are raw SQL rather than Prisma queries, for two reasons:
//   * Prisma's groupBy can't do conditional aggregates (COUNT FILTER) or
//     date_trunc/EXTRACT, which is most of what's needed here.
//   * The alternative — findMany() then reduce in JS — pulls every delivery row
//     into memory to produce a handful of numbers. That's what the old
//     /dashboard endpoint did; it's fine at 100 rows and falls over at 100k.
//
// Every value is interpolated through a tagged template, so Prisma parameterises
// it. Nothing is string-concatenated into these queries.
//
// Casts are load-bearing: Postgres COUNT/SUM return bigint, which Prisma maps to
// a JS BigInt that JSON.stringify refuses to serialise, and AVG returns numeric,
// which becomes a Decimal object. ::int and ::float8 keep the responses plain JSON.
// ============================================================

import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { MESSAGE_STATUS } from '../../constants/codes.js';

// Reused SQL fragments. Kept as constants so "what counts as delivered" is
// defined once — the definitions have to agree across all four endpoints or the
// numbers won't reconcile.
const IS_SUCCESS = Prisma.sql`s.code IN (${MESSAGE_STATUS.SENT}, ${MESSAGE_STATUS.DELIVERED}, ${MESSAGE_STATUS.READ})`;
const IS_DELIVERED = Prisma.sql`s.code IN (${MESSAGE_STATUS.DELIVERED}, ${MESSAGE_STATUS.READ})`;
const IS_READ = Prisma.sql`s.code = ${MESSAGE_STATUS.READ}`;
const IS_FAILED = Prisma.sql`s.code = ${MESSAGE_STATUS.FAILED}`;
const IS_PENDING = Prisma.sql`s.code IN (${MESSAGE_STATUS.PENDING}, ${MESSAGE_STATUS.SENDING})`;

/**
 * GET /analytics/summary
 * Headline counts for the window, plus the full status breakdown.
 */
export async function getSummary(userId, { from, to, platform }) {
  const [totals] = await prisma.$queryRaw`
    SELECT
      COUNT(*)::int                                    AS total,
      COUNT(*) FILTER (WHERE ${IS_SUCCESS})::int       AS successful,
      COUNT(*) FILTER (WHERE ${IS_DELIVERED})::int     AS delivered,
      COUNT(*) FILTER (WHERE ${IS_READ})::int          AS read,
      COUNT(*) FILTER (WHERE ${IS_FAILED})::int        AS failed,
      COUNT(*) FILTER (WHERE ${IS_PENDING})::int       AS pending,
      COUNT(DISTINCT d.contact_id)::int                AS contacts_reached,
      COUNT(DISTINCT d.job_id)::int                    AS jobs_fired,
      COALESCE(SUM(d.retry_count), 0)::int             AS total_retries,
      AVG(EXTRACT(EPOCH FROM (d.delivered_at - d.sent_at)))::float8 AS avg_delivery_seconds
    FROM message_deliveries d
    JOIN scheduled_jobs   j ON j.id = d.job_id
    JOIN message_statuses s ON s.id = d.status_id
    JOIN platforms        p ON p.id = d.platform_id
    WHERE ${scopeClause(userId, from, to, platform)}
  `;

  const statusRows = await prisma.$queryRaw`
    SELECT s.code AS status, COUNT(*)::int AS count
    FROM message_deliveries d
    JOIN scheduled_jobs   j ON j.id = d.job_id
    JOIN message_statuses s ON s.id = d.status_id
    JOIN platforms        p ON p.id = d.platform_id
    WHERE ${scopeClause(userId, from, to, platform)}
    GROUP BY s.code
    ORDER BY count DESC
  `;

  // Counted independently of the delivery join: a user with scheduled jobs that
  // haven't fired yet still has upcoming work, and it would be invisible in a
  // deliveries-only query.
  const [upcomingJobs, totalMessages, totalContacts] = await Promise.all([
    prisma.scheduledJob.count({ where: { userId, nextRunAt: { not: null } } }),
    prisma.message.count({ where: { userId } }),
    prisma.contact.count({ where: { userId, deletedAt: null } }),
  ]);

  return {
    range: { from, to, ...(platform && { platform }) },
    totals: {
      deliveries: totals.total,
      successful: totals.successful,
      delivered: totals.delivered,
      read: totals.read,
      failed: totals.failed,
      pending: totals.pending,
      successRate: asRate(totals.successful, totals.total),
      deliveryRate: asRate(totals.delivered, totals.total),
      readRate: asRate(totals.read, totals.total),
      failureRate: asRate(totals.failed, totals.total),
    },
    byStatus: Object.fromEntries(statusRows.map((r) => [r.status, r.count])),
    reach: {
      contactsReached: totals.contacts_reached,
      jobsFired: totals.jobs_fired,
    },
    retries: {
      total: totals.total_retries,
      perDelivery: totals.total > 0 ? round(totals.total_retries / totals.total, 2) : 0,
    },
    // Median would be the more honest statistic, but avg is what a dashboard
    // expects and the distribution here is tight enough for it to be useful.
    avgDeliverySeconds: totals.avg_delivery_seconds != null
      ? round(totals.avg_delivery_seconds, 1)
      : null,
    account: { totalMessages, totalContacts, upcomingJobs },
  };
}

/**
 * GET /analytics/platform-stats
 * The same metrics broken out per channel — which is the question that actually
 * drives decisions ("is WhatsApp worth keeping?").
 */
export async function getPlatformStats(userId, { from, to }) {
  const rows = await prisma.$queryRaw`
    SELECT
      p.code                                           AS platform,
      p.name                                           AS name,
      COUNT(*)::int                                    AS total,
      COUNT(*) FILTER (WHERE ${IS_SUCCESS})::int       AS successful,
      COUNT(*) FILTER (WHERE ${IS_DELIVERED})::int     AS delivered,
      COUNT(*) FILTER (WHERE ${IS_READ})::int          AS read,
      COUNT(*) FILTER (WHERE ${IS_FAILED})::int        AS failed,
      COUNT(*) FILTER (WHERE ${IS_PENDING})::int       AS pending,
      COUNT(DISTINCT d.contact_id)::int                AS contacts_reached,
      COALESCE(SUM(d.retry_count), 0)::int             AS total_retries,
      AVG(EXTRACT(EPOCH FROM (d.delivered_at - d.sent_at)))::float8 AS avg_delivery_seconds
    FROM message_deliveries d
    JOIN scheduled_jobs   j ON j.id = d.job_id
    JOIN message_statuses s ON s.id = d.status_id
    JOIN platforms        p ON p.id = d.platform_id
    WHERE ${scopeClause(userId, from, to)}
    GROUP BY p.code, p.name
    ORDER BY total DESC
  `;

  // Failure reasons are the actionable half of this endpoint — "WhatsApp is at
  // 60%" is only useful alongside *why*.
  const errorRows = await prisma.$queryRaw`
    SELECT p.code AS platform, d.error_reason AS reason, COUNT(*)::int AS count
    FROM message_deliveries d
    JOIN scheduled_jobs   j ON j.id = d.job_id
    JOIN message_statuses s ON s.id = d.status_id
    JOIN platforms        p ON p.id = d.platform_id
    WHERE ${scopeClause(userId, from, to)}
      AND ${IS_FAILED}
      AND d.error_reason IS NOT NULL
    GROUP BY p.code, d.error_reason
    ORDER BY count DESC
  `;

  const topErrorsByPlatform = new Map();
  for (const row of errorRows) {
    const list = topErrorsByPlatform.get(row.platform) ?? [];
    if (list.length < 3) list.push({ reason: row.reason, count: row.count });
    topErrorsByPlatform.set(row.platform, list);
  }

  return {
    range: { from, to },
    platforms: rows.map((row) => ({
      platform: row.platform,
      name: row.name,
      total: row.total,
      successful: row.successful,
      delivered: row.delivered,
      read: row.read,
      failed: row.failed,
      pending: row.pending,
      contactsReached: row.contacts_reached,
      successRate: asRate(row.successful, row.total),
      deliveryRate: asRate(row.delivered, row.total),
      readRate: asRate(row.read, row.total),
      failureRate: asRate(row.failed, row.total),
      retries: row.total_retries,
      avgDeliverySeconds: row.avg_delivery_seconds != null
        ? round(row.avg_delivery_seconds, 1)
        : null,
      topErrors: topErrorsByPlatform.get(row.platform) ?? [],
    })),
  };
}

/**
 * GET /analytics/delivery-rates
 * A time series for charting, bucketed by day, week or month.
 *
 * Buckets with no deliveries are filled in as zeroes rather than omitted — a
 * chart that silently skips empty days draws a misleading line.
 */
export async function getDeliveryRates(userId, { from, to, bucket, platform }) {
  const rows = await prisma.$queryRaw`
    SELECT
      date_trunc(${bucket}, d.created_at)              AS bucket,
      COUNT(*)::int                                    AS total,
      COUNT(*) FILTER (WHERE ${IS_SUCCESS})::int       AS successful,
      COUNT(*) FILTER (WHERE ${IS_DELIVERED})::int     AS delivered,
      COUNT(*) FILTER (WHERE ${IS_READ})::int          AS read,
      COUNT(*) FILTER (WHERE ${IS_FAILED})::int        AS failed,
      COUNT(*) FILTER (WHERE ${IS_PENDING})::int       AS pending
    FROM message_deliveries d
    JOIN scheduled_jobs   j ON j.id = d.job_id
    JOIN message_statuses s ON s.id = d.status_id
    JOIN platforms        p ON p.id = d.platform_id
    WHERE ${scopeClause(userId, from, to, platform)}
    GROUP BY bucket
    ORDER BY bucket ASC
  `;

  const byBucket = new Map(
    rows.map((row) => [row.bucket.toISOString(), row])
  );

  const series = enumerateBuckets(from, to, bucket).map((start) => {
    const row = byBucket.get(start.toISOString());
    const total = row?.total ?? 0;

    return {
      bucket: start.toISOString(),
      total,
      successful: row?.successful ?? 0,
      delivered: row?.delivered ?? 0,
      read: row?.read ?? 0,
      failed: row?.failed ?? 0,
      pending: row?.pending ?? 0,
      successRate: asRate(row?.successful ?? 0, total),
      deliveryRate: asRate(row?.delivered ?? 0, total),
      failureRate: asRate(row?.failed ?? 0, total),
    };
  });

  const totals = series.reduce(
    (acc, point) => ({
      total: acc.total + point.total,
      successful: acc.successful + point.successful,
      delivered: acc.delivered + point.delivered,
      failed: acc.failed + point.failed,
    }),
    { total: 0, successful: 0, delivered: 0, failed: 0 }
  );

  return {
    range: { from, to, bucket, ...(platform && { platform }) },
    series,
    overall: {
      ...totals,
      successRate: asRate(totals.successful, totals.total),
      deliveryRate: asRate(totals.delivered, totals.total),
      failureRate: asRate(totals.failed, totals.total),
    },
  };
}

/**
 * GET /analytics/best-send-times
 * When does mail actually get read? Aggregates every send by local hour and
 * weekday and ranks them.
 *
 * The ranking uses additive smoothing rather than the raw rate. Without it a
 * single 1-for-1 hour outranks a 480-for-500 hour, and the "best time to send"
 * ends up being whichever hour happens to have the least data — the exact
 * opposite of the intended answer. Each bucket is shrunk toward the overall
 * average in proportion to how little evidence it has.
 */
export async function getBestSendTimes(userId, { from, to, timezone, minSample, platform }) {
  // sent_at is a naive UTC timestamp, so it's labelled as UTC before being
  // converted — otherwise Postgres would interpret it in the server's zone.
  const localSentAt = Prisma.sql`(d.sent_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone})`;

  const rows = await prisma.$queryRaw`
    SELECT
      EXTRACT(HOUR FROM ${localSentAt})::int           AS hour,
      EXTRACT(DOW  FROM ${localSentAt})::int           AS day_of_week,
      COUNT(*)::int                                    AS total,
      COUNT(*) FILTER (WHERE ${IS_DELIVERED})::int     AS delivered,
      COUNT(*) FILTER (WHERE ${IS_READ})::int          AS read,
      COUNT(*) FILTER (WHERE ${IS_FAILED})::int        AS failed
    FROM message_deliveries d
    JOIN scheduled_jobs   j ON j.id = d.job_id
    JOIN message_statuses s ON s.id = d.status_id
    JOIN platforms        p ON p.id = d.platform_id
    WHERE ${scopeClause(userId, from, to, platform)}
      AND d.sent_at IS NOT NULL
    GROUP BY hour, day_of_week
    ORDER BY hour, day_of_week
  `;

  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);
  const grandDelivered = rows.reduce((sum, r) => sum + r.delivered, 0);
  const baselineRate = grandTotal > 0 ? grandDelivered / grandTotal : 0;

  const byHour = collapse(rows, (r) => r.hour);
  const byWeekday = collapse(rows, (r) => r.day_of_week);

  return {
    range: { from, to, timezone, ...(platform && { platform }) },
    sampleSize: grandTotal,
    baselineDeliveryRate: round(baselineRate * 100, 1),
    byHour: byHour.map((b) => ({
      hour: b.key,
      label: `${String(b.key).padStart(2, '0')}:00`,
      ...bucketMetrics(b, baselineRate),
    })),
    byWeekday: byWeekday.map((b) => ({
      dayOfWeek: b.key,
      label: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][b.key],
      ...bucketMetrics(b, baselineRate),
    })),
    // The actual recommendation: hours with enough evidence to trust, best first.
    recommendations: byHour
      .filter((b) => b.total >= minSample)
      .map((b) => ({
        hour: b.key,
        label: `${String(b.key).padStart(2, '0')}:00`,
        ...bucketMetrics(b, baselineRate),
      }))
      .sort((a, b) => b.score - a.score || b.total - a.total)
      .slice(0, 5),
    notes:
      grandTotal === 0
        ? 'No sends in this window yet — send some messages and check back.'
        : `Ranked by delivery rate smoothed toward the ${round(baselineRate * 100, 1)}% baseline, ` +
          `excluding hours with fewer than ${minSample} sends.`,
  };
}

/**
 * GET /analytics/dashboard — the original endpoint, kept so existing frontend
 * calls don't break. Now derived from getSummary instead of loading every
 * delivery row into memory.
 */
export async function getDashboard(userId, range) {
  const summary = await getSummary(userId, range);
  const platformStats = await getPlatformStats(userId, range);

  const countByPlatform = Object.fromEntries(
    platformStats.platforms.map((p) => [p.platform, p.total])
  );

  return {
    totalMessages: summary.totals.deliveries,
    pending: summary.totals.pending,
    failed: summary.totals.failed,
    successRate: summary.totals.successRate,
    ...countByPlatform, // { telegram: 620, gmail: 410, sms: 150, whatsapp: 70 }
  };
}

// ---- internal helpers ----------------------------------------------

/**
 * The WHERE every query shares: this user's deliveries, inside the window, and
 * optionally one platform. `to` is exclusive so adjacent buckets can't
 * double-count a row on the boundary.
 */
function scopeClause(userId, from, to, platform) {
  return Prisma.sql`
    j.user_id = ${userId}
    AND d.created_at >= ${from}
    AND d.created_at < ${to}
    ${platform ? Prisma.sql`AND p.code = ${platform}` : Prisma.empty}
  `;
}

/** Sum hour×weekday rows down to one dimension. */
function collapse(rows, keyOf) {
  const map = new Map();

  for (const row of rows) {
    const key = keyOf(row);
    const bucket = map.get(key) ?? { key, total: 0, delivered: 0, read: 0, failed: 0 };

    bucket.total += row.total;
    bucket.delivered += row.delivered;
    bucket.read += row.read;
    bucket.failed += row.failed;
    map.set(key, bucket);
  }

  return [...map.values()].sort((a, b) => a.key - b.key);
}

/**
 * Smoothing strength, in pseudo-observations. A bucket with 10 sends is pulled
 * halfway to the baseline; one with 200 is barely moved. 10 is a deliberate
 * choice — high enough to neutralise single-digit noise, low enough that a
 * genuinely good hour with ~50 sends still stands out.
 */
const SMOOTHING_WEIGHT = 10;

function bucketMetrics(bucket, baselineRate) {
  const smoothed =
    (bucket.delivered + baselineRate * SMOOTHING_WEIGHT) / (bucket.total + SMOOTHING_WEIGHT);

  return {
    total: bucket.total,
    delivered: bucket.delivered,
    read: bucket.read,
    failed: bucket.failed,
    deliveryRate: asRate(bucket.delivered, bucket.total),
    readRate: asRate(bucket.read, bucket.total),
    score: round(smoothed * 100, 1),
  };
}

/**
 * Every bucket start between from and to, so gaps in the data become explicit
 * zeroes. Uses UTC arithmetic to match date_trunc's output.
 */
function enumerateBuckets(from, to, bucket) {
  const starts = [];
  let cursor = truncateUtc(from, bucket);

  while (cursor < to) {
    starts.push(new Date(cursor));
    cursor = advance(cursor, bucket);
  }
  return starts;
}

function truncateUtc(date, bucket) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);

  // date_trunc('week') snaps to Monday (ISO), so match that rather than Sunday.
  if (bucket === 'week') {
    const dayOfWeek = d.getUTCDay();
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  }
  if (bucket === 'month') d.setUTCDate(1);

  return d;
}

function advance(date, bucket) {
  const d = new Date(date);
  if (bucket === 'day') d.setUTCDate(d.getUTCDate() + 1);
  if (bucket === 'week') d.setUTCDate(d.getUTCDate() + 7);
  if (bucket === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/** Percentage to one decimal place; 0 rather than NaN when there's no data. */
function asRate(part, total) {
  if (!total) return 0;
  return round((part / total) * 100, 1);
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
