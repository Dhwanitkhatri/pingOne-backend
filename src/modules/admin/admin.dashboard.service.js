// ============================================================
// Admin dashboard aggregations — PLATFORM-WIDE, across every tenant.
//
// This is the deliberate difference from modules/analytics, which scopes
// every query to one user's own deliveries. Nothing in this file filters by
// user_id, so it must only ever be reachable behind `requireAdmin`.
//
// Raw SQL for the same reasons analytics uses it: Prisma's groupBy can't do
// COUNT FILTER or date_trunc, and pulling 100k delivery rows into Node to
// reduce them to eight numbers is how a dashboard becomes the slowest page
// in the product. Values are interpolated through Prisma's tagged template,
// so everything is parameterised — nothing is concatenated in.
//
// ::int / ::float8 casts are load-bearing: Postgres COUNT and SUM return
// bigint, which Prisma maps to a JS BigInt that JSON.stringify throws on.
// ============================================================

import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { MESSAGE_STATUS } from '../../constants/codes.js';

// "Sent" means the platform accepted it. Kept as one constant so the stat
// card, the activity chart and the platform donut can never drift apart.
const IS_SENT = Prisma.sql`s.code IN (${MESSAGE_STATUS.SENT}, ${MESSAGE_STATUS.DELIVERED}, ${MESSAGE_STATUS.READ})`;
const IS_FAILED = Prisma.sql`s.code = ${MESSAGE_STATUS.FAILED}`;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ── 1. Stat cards ───────────────────────────────────────────────────── */

/**
 * The four headline counters, each with a percentage change against the
 * immediately preceding window of equal length.
 *
 * Two different kinds of metric live here and they trend differently:
 *
 *   CUMULATIVE (total users) — a running total. Its trend compares the total
 *     now against the total as it stood at the start of the window, i.e. how
 *     much the population grew.
 *
 *   FLOW (messages sent, failures, active users) — events inside a window.
 *     Its trend compares this window's count against the previous window's.
 *
 * Treating a cumulative metric as a flow is the classic dashboard bug: it
 * would report "total users +2458%" on the first month and ~0% forever after.
 *
 * @param {{ windowDays?: number }} options
 */
export async function getStats({ windowDays = 30 } = {}) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * DAY_MS);
  const previousStart = new Date(now.getTime() - 2 * windowDays * DAY_MS);

  const [
    totalUsers,
    usersAtWindowStart,
    newUsersThisWindow,
    newUsersPreviousWindow,
    activeUsers,
    activePreviousWindow,
    messageCounts,
  ] = await Promise.all([
    prisma.user.count({ where: { deletedAt: null } }),

    // The population as it stood when this window opened — the denominator
    // for cumulative growth.
    prisma.user.count({ where: { deletedAt: null, createdAt: { lt: windowStart } } }),

    prisma.user.count({ where: { deletedAt: null, createdAt: { gte: windowStart } } }),
    prisma.user.count({
      where: { deletedAt: null, createdAt: { gte: previousStart, lt: windowStart } },
    }),

    // Active = signed in at least once inside the window.
    prisma.user.count({
      where: { deletedAt: null, isActive: true, lastLoginAt: { gte: windowStart } },
    }),

    // KNOWN BIAS, and it only ever runs one way. `last_login_at` holds a
    // user's MOST RECENT login, not every login — so someone who signed in
    // during both windows appears only in the current one. The previous
    // window is therefore a lower bound, which flatters the trend. Recording
    // a row per login (a session-events table) is the fix; until then this
    // number is directional, not exact, and the API says so via
    // `activeUsers.trendIsApproximate`.
    prisma.user.count({
      where: {
        deletedAt: null,
        isActive: true,
        lastLoginAt: { gte: previousStart, lt: windowStart },
      },
    }),

    countMessages({ windowStart, previousStart }),
  ]);

  return {
    range: { windowDays, from: windowStart, to: now },
    totalUsers: {
      value: totalUsers,
      trend: percentChange(totalUsers, usersAtWindowStart),
      newThisWindow: newUsersThisWindow,
      previousWindow: newUsersPreviousWindow,
    },
    messagesSent: {
      value: messageCounts.sentCurrent,
      trend: percentChange(messageCounts.sentCurrent, messageCounts.sentPrevious),
      previousWindow: messageCounts.sentPrevious,
    },
    activeUsers: {
      value: activeUsers,
      trend: percentChange(activeUsers, activePreviousWindow),
      previousWindow: activePreviousWindow,
      trendIsApproximate: true,
    },
    failedMessages: {
      value: messageCounts.failedCurrent,
      trend: percentChange(messageCounts.failedCurrent, messageCounts.failedPrevious),
      previousWindow: messageCounts.failedPrevious,
      // Down is good here. The UI paints a negative trend green and labels it
      // "improvement" rather than the usual "vs. last month".
      lowerIsBetter: true,
    },
  };
}

/**
 * Sent and failed counts for both windows in a single pass over the table.
 *
 * Four separate COUNT queries would each re-scan message_deliveries; one
 * scan with four conditional aggregates does the same work once.
 */
async function countMessages({ windowStart, previousStart }) {
  const [row] = await prisma.$queryRaw`
    SELECT
      COUNT(*) FILTER (WHERE ${IS_SENT}   AND d.created_at >= ${windowStart})::int AS sent_current,
      COUNT(*) FILTER (WHERE ${IS_SENT}   AND d.created_at >= ${previousStart}
                                          AND d.created_at <  ${windowStart})::int AS sent_previous,
      COUNT(*) FILTER (WHERE ${IS_FAILED} AND d.created_at >= ${windowStart})::int AS failed_current,
      COUNT(*) FILTER (WHERE ${IS_FAILED} AND d.created_at >= ${previousStart}
                                          AND d.created_at <  ${windowStart})::int AS failed_previous
    FROM message_deliveries d
    JOIN message_statuses s ON s.id = d.status_id
    WHERE d.created_at >= ${previousStart}
  `;

  return {
    sentCurrent: row.sent_current,
    sentPrevious: row.sent_previous,
    failedCurrent: row.failed_current,
    failedPrevious: row.failed_previous,
  };
}

/* ── 2. Messaging activity chart ─────────────────────────────────────── */

/**
 * Daily send volume for the area chart, 7 or 30 days.
 *
 * Days with no traffic are emitted as explicit zeroes rather than omitted.
 * A chart that silently skips empty days compresses the x-axis and draws a
 * line that never happened — the single most common way a "nice" dashboard
 * chart lies.
 *
 * @param {{ days?: number }} options
 */
export async function getMessagingActivity({ days = 7 } = {}) {
  const to = endOfUtcDay(new Date());
  const from = new Date(to.getTime() - days * DAY_MS);

  const rows = await prisma.$queryRaw`
    SELECT
      date_trunc('day', d.created_at)             AS bucket,
      COUNT(*) FILTER (WHERE ${IS_SENT})::int     AS sent,
      COUNT(*) FILTER (WHERE ${IS_FAILED})::int   AS failed,
      COUNT(*)::int                               AS total
    FROM message_deliveries d
    JOIN message_statuses s ON s.id = d.status_id
    WHERE d.created_at >= ${from} AND d.created_at < ${to}
    GROUP BY bucket
    ORDER BY bucket ASC
  `;

  const byDay = new Map(rows.map((r) => [r.bucket.toISOString(), r]));
  const series = [];

  for (let cursor = new Date(from); cursor < to; cursor = new Date(cursor.getTime() + DAY_MS)) {
    const row = byDay.get(cursor.toISOString());

    series.push({
      date: cursor.toISOString(),
      // Short weekday for the 7-day view's axis (Mon, Tue…); the 30-day view
      // labels by date instead and ignores this.
      label: cursor.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
      sent: row?.sent ?? 0,
      failed: row?.failed ?? 0,
      total: row?.total ?? 0,
    });
  }

  const totals = series.reduce(
    (acc, point) => ({
      sent: acc.sent + point.sent,
      failed: acc.failed + point.failed,
      total: acc.total + point.total,
    }),
    { sent: 0, failed: 0, total: 0 }
  );

  return {
    range: { days, from, to },
    series,
    totals: {
      ...totals,
      peak: series.reduce((max, p) => Math.max(max, p.sent), 0),
      dailyAverage: series.length ? Math.round(totals.sent / series.length) : 0,
    },
  };
}

/* ── 3. Platform distribution donut ──────────────────────────────────── */

/**
 * Share of send volume per channel.
 *
 * Percentages are apportioned with largest-remainder rather than naive
 * rounding, so the four slices sum to exactly 100 and the legend never reads
 * 38 / 28 / 22 / 13. A donut whose labels don't add up is the fastest way to
 * lose a viewer's trust in every other number on the page.
 *
 * @param {{ days?: number }} options
 */
export async function getPlatformDistribution({ days = 30 } = {}) {
  const to = new Date();
  const from = new Date(to.getTime() - days * DAY_MS);

  const rows = await prisma.$queryRaw`
    SELECT
      p.code                                       AS code,
      p.name                                       AS name,
      COUNT(*) FILTER (WHERE ${IS_SENT})::int      AS sent,
      COUNT(*) FILTER (WHERE ${IS_FAILED})::int    AS failed,
      COUNT(*)::int                                AS total
    FROM message_deliveries d
    JOIN message_statuses s ON s.id = d.status_id
    JOIN platforms        p ON p.id = d.platform_id
    WHERE d.created_at >= ${from} AND d.created_at < ${to}
    GROUP BY p.code, p.name
    ORDER BY sent DESC
  `;

  // Every configured channel appears, including ones with no traffic — an
  // admin needs to see that SMS sent nothing this month, not have it vanish.
  const allPlatforms = await prisma.platform.findMany({
    where: { isActive: true },
    select: { code: true, name: true },
    orderBy: { id: 'asc' },
  });

  const byCode = new Map(rows.map((r) => [r.code, r]));
  const merged = allPlatforms.map((p) => {
    const row = byCode.get(p.code);
    return {
      platform: p.code,
      name: p.name,
      sent: row?.sent ?? 0,
      failed: row?.failed ?? 0,
      total: row?.total ?? 0,
    };
  });

  const totalSent = merged.reduce((sum, p) => sum + p.sent, 0);

  return {
    range: { days, from, to },
    totalSent,
    platforms: apportionPercentages(merged, totalSent).sort((a, b) => b.sent - a.sent),
  };
}

/**
 * Largest-remainder apportionment: floor everything, then hand the leftover
 * points to whoever was robbed most by the flooring.
 */
function apportionPercentages(items, total) {
  if (!total) return items.map((item) => ({ ...item, percentage: 0 }));

  const exact = items.map((item) => {
    const raw = (item.sent / total) * 100;
    return { item, floor: Math.floor(raw), remainder: raw - Math.floor(raw) };
  });

  let leftover = 100 - exact.reduce((sum, e) => sum + e.floor, 0);

  // Descending remainder — the biggest loser from flooring is repaid first.
  for (const entry of [...exact].sort((a, b) => b.remainder - a.remainder)) {
    if (leftover <= 0) break;
    entry.floor += 1;
    leftover -= 1;
  }

  return exact.map(({ item, floor }) => ({ ...item, percentage: floor }));
}

/* ── 4. Recent activity feed ─────────────────────────────────────────── */

/**
 * A merged, newest-first feed of what has been happening across the platform.
 *
 * Four heterogeneous sources with no common table, so each is queried for its
 * own newest `limit` rows and the results are merged in memory. Taking `limit`
 * from each guarantees the merged head is correct: the true newest `limit`
 * events cannot contain an item that wasn't in the top `limit` of its own
 * source. Fetching all four in full and sorting would be correct too, and
 * would also read the entire history of the platform on every dashboard load.
 *
 * @param {{ limit?: number }} options
 */
export async function getRecentActivity({ limit = 8 } = {}) {
  const [signups, connections, failures, adminActions] = await Promise.all([
    prisma.user.findMany({
      where: { deletedAt: null },
      select: { id: true, firstName: true, lastName: true, email: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),

    prisma.userPlatformCredential.findMany({
      where: { isActive: true },
      select: {
        id: true,
        connectedAt: true,
        user: { select: { id: true, firstName: true, lastName: true } },
        platform: { select: { name: true, code: true } },
      },
      orderBy: { connectedAt: 'desc' },
      take: limit,
    }),

    prisma.messageDelivery.findMany({
      where: { status: { code: MESSAGE_STATUS.FAILED } },
      select: {
        id: true,
        errorReason: true,
        updatedAt: true,
        platform: { select: { name: true, code: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    }),

    prisma.adminAuditLog.findMany({
      where: {
        action: {
          in: ['user.suspend', 'user.reactivate', 'user.role_change', 'user.delete'],
        },
      },
      select: {
        id: true,
        action: true,
        targetLabel: true,
        createdAt: true,
        targetUser: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
  ]);

  const events = [
    ...signups.map((u) => ({
      id: `signup-${u.id}`,
      type: 'user_registered',
      severity: 'info',
      title: `${fullName(u)} registered a new account`,
      timestamp: u.createdAt,
      meta: { userId: u.id, email: u.email },
    })),

    ...connections.map((c) => ({
      id: `connect-${c.id}`,
      type: 'platform_connected',
      severity: 'success',
      title: `${fullName(c.user)} connected ${c.platform.name}`,
      timestamp: c.connectedAt,
      meta: { userId: c.user.id, platform: c.platform.code },
    })),

    ...failures.map((f) => ({
      id: `failure-${f.id}`,
      type: 'delivery_failed',
      severity: 'error',
      title: `Message delivery failure — ${f.platform.name}`,
      // The reason is the actionable half; the title alone tells an operator
      // nothing they can act on.
      description: f.errorReason ?? null,
      timestamp: f.updatedAt,
      meta: { deliveryId: f.id, platform: f.platform.code },
    })),

    ...adminActions.map((a) => ({
      id: `admin-${a.id}`,
      type: a.action,
      severity: a.action === 'user.reactivate' ? 'success' : 'warning',
      title: describeAdminAction(a),
      timestamp: a.createdAt,
      meta: { auditId: a.id },
    })),
  ];

  return {
    events: events
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .map((event) => ({ ...event, timestamp: event.timestamp.toISOString() })),
  };
}

function describeAdminAction(entry) {
  const who = entry.targetUser ? fullName(entry.targetUser) : (entry.targetLabel ?? 'A user');

  switch (entry.action) {
    case 'user.suspend':
      return `${who} account suspended by admin`;
    case 'user.reactivate':
      return `${who} account reactivated by admin`;
    case 'user.role_change':
      return `${who} role changed by admin`;
    case 'user.delete':
      return `${who} account deleted by admin`;
    default:
      return `${who} updated by admin`;
  }
}

function fullName(user) {
  return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || 'Unknown user';
}

/* ── 5. System health ────────────────────────────────────────────────── */

/**
 * Live status of the four subsystems the design lists.
 *
 * Everything here is MEASURED, not asserted — each probe times a real
 * operation, and a probe that throws reports `down` rather than taking the
 * endpoint with it. A health panel that 500s when something is unhealthy is
 * exactly backwards.
 *
 * Redis is imported lazily. The API process is designed to boot and serve
 * without Redis (only the worker needs it), and a static import would open a
 * connection on every process that touches this module.
 */
export async function getSystemHealth() {
  const [api, database, queue, platformApis] = await Promise.all([
    probeApiServer(),
    probeDatabase(),
    probeQueue(),
    probePlatformApis(),
  ]);

  const components = [api, database, queue, platformApis];

  // Worst-case roll-up: the system is only as healthy as its sickest part.
  const rank = { operational: 0, warning: 1, degraded: 2, down: 3 };
  const overall = components.reduce(
    (worst, c) => (rank[c.status] > rank[worst] ? c.status : worst),
    'operational'
  );

  return { overall, checkedAt: new Date().toISOString(), components };
}

/**
 * API responsiveness, measured as event-loop lag.
 *
 * Timing an HTTP round-trip to ourselves would mostly measure the network.
 * How long a zero-work callback waits for its turn is the number that
 * actually predicts whether requests are being served promptly — it is what
 * goes bad first when the process is saturated.
 */
async function probeApiServer() {
  const started = process.hrtime.bigint();
  await new Promise((resolve) => setImmediate(resolve));
  const lagMs = Number(process.hrtime.bigint() - started) / 1e6;

  return {
    key: 'api',
    name: 'API Server',
    status: classify(lagMs, { warning: 100, degraded: 500 }),
    latencyMs: round(lagMs, 1),
    detail: `Event-loop lag · up ${formatUptime(process.uptime())}`,
  };
}

async function probeDatabase() {
  const started = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
    const elapsed = Date.now() - started;

    return {
      key: 'database',
      name: 'Database',
      status: classify(elapsed, { warning: 150, degraded: 600 }),
      latencyMs: elapsed,
      detail: 'PostgreSQL round-trip',
    };
  } catch (err) {
    return {
      key: 'database',
      name: 'Database',
      status: 'down',
      latencyMs: null,
      detail: err.message,
    };
  }
}

/**
 * Queue health is latency AND depth. A Redis that answers PING in 2ms while
 * 40,000 jobs sit unprocessed is not healthy, and latency alone would call
 * it operational — so backlog escalates the status on its own.
 */
async function probeQueue() {
  const started = Date.now();

  try {
    const { connection, deliveryQueue, retryQueue } = await import('../../queue/bull.queue.js');

    // ioredis buffers commands while offline instead of rejecting, so a hung
    // ping has to be raced against a deadline or this probe hangs the whole
    // dashboard request.
    await Promise.race([
      connection.ping(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Redis ping timed out')), 2000).unref?.();
      }),
    ]);

    const elapsed = Date.now() - started;

    const [deliveryWaiting, retryWaiting, deliveryFailed] = await Promise.all([
      deliveryQueue.getWaitingCount(),
      retryQueue.getWaitingCount(),
      deliveryQueue.getFailedCount(),
    ]);

    const backlog = deliveryWaiting + retryWaiting;
    const byLatency = classify(elapsed, { warning: 200, degraded: 1000 });
    const byBacklog = classify(backlog, { warning: 500, degraded: 5000 });

    return {
      key: 'queue',
      name: 'Message Queue',
      status: worst(byLatency, byBacklog),
      latencyMs: elapsed,
      detail: `${backlog} queued · ${deliveryFailed} failed jobs`,
      metrics: { backlog, deliveryWaiting, retryWaiting, deliveryFailed },
    };
  } catch (err) {
    // Redis being unreachable is a real, expected state in this app — the API
    // runs fine without it and only immediate sends are affected. Report it
    // plainly instead of throwing.
    return {
      key: 'queue',
      name: 'Message Queue',
      status: 'down',
      latencyMs: null,
      detail: `Unreachable — ${err.message}`,
    };
  }
}

/**
 * Outbound channel health, inferred from our own recent delivery record
 * rather than by calling Meta/Google/Twilio on every dashboard load.
 *
 * Live pinging four third-party APIs would add seconds to this request, burn
 * rate limit, and still only prove the endpoint answers — not that OUR sends
 * are landing. The failure rate over the last hour measures the thing we
 * actually care about. Expired credentials are folded in because they produce
 * failures that haven't happened yet.
 */
async function probePlatformApis() {
  const since = new Date(Date.now() - 60 * 60 * 1000);

  try {
    const [row] = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int                              AS total,
        COUNT(*) FILTER (WHERE ${IS_FAILED})::int  AS failed,
        AVG(EXTRACT(EPOCH FROM (d.sent_at - d.created_at)))::float8 AS avg_send_seconds
      FROM message_deliveries d
      JOIN message_statuses s ON s.id = d.status_id
      WHERE d.created_at >= ${since}
    `;

    // Gmail is excluded: its stored secret is a refresh token, and expiresAt is
    // only the one-hour ACCESS token's — renewed automatically on every send —
    // so it reads as "expired" an hour after connecting while working fine.
    // Meta's long-lived WhatsApp token does genuinely expire, so it counts.
    const expiredCredentials = await prisma.userPlatformCredential.count({
      where: {
        isActive: true,
        expiresAt: { not: null, lt: new Date() },
        platform: { code: { not: 'gmail' } },
      },
    });

    const failureRate = row.total ? (row.failed / row.total) * 100 : 0;
    const latencyMs = row.avg_send_seconds != null ? Math.round(row.avg_send_seconds * 1000) : null;

    // No traffic in the last hour is not evidence of a problem — a quiet
    // platform must not be painted red.
    const byFailureRate = row.total === 0 ? 'operational' : classify(failureRate, { warning: 5, degraded: 20 });
    const byCredentials = classify(expiredCredentials, { warning: 1, degraded: 25 });

    return {
      key: 'platforms',
      name: 'Platform APIs',
      status: worst(byFailureRate, byCredentials),
      latencyMs,
      detail:
        row.total === 0
          ? 'No sends in the last hour'
          : `${round(failureRate, 1)}% failure rate over ${row.total} sends` +
            (expiredCredentials ? ` · ${expiredCredentials} expired credential(s)` : ''),
      metrics: {
        windowMinutes: 60,
        sends: row.total,
        failed: row.failed,
        failureRate: round(failureRate, 1),
        expiredCredentials,
      },
    };
  } catch (err) {
    return {
      key: 'platforms',
      name: 'Platform APIs',
      status: 'down',
      latencyMs: null,
      detail: err.message,
    };
  }
}

/* ── 6. One-shot overview ────────────────────────────────────────────── */

/**
 * Everything the dashboard page renders, in one request.
 *
 * The page needs all five panels before it is worth showing; five parallel
 * round-trips from the browser would each pay TLS + auth + the DB pool for
 * the same page load. The individual endpoints stay mounted for polling a
 * single panel (system health refreshes far more often than user counts) and
 * for anything else that wants one slice.
 */
export async function getOverview({ activityDays = 7 } = {}) {
  const [stats, messagingActivity, platformDistribution, recentActivity, systemHealth] =
    await Promise.all([
      getStats(),
      getMessagingActivity({ days: activityDays }),
      getPlatformDistribution(),
      getRecentActivity(),
      getSystemHealth(),
    ]);

  return {
    generatedAt: new Date().toISOString(),
    stats,
    messagingActivity,
    platformDistribution,
    recentActivity,
    systemHealth,
  };
}

/* ── helpers ─────────────────────────────────────────────────────────── */

/**
 * Percentage change against a baseline, to one decimal.
 *
 * Growth from zero is mathematically infinite, which no UI can render. It is
 * reported as null and the card simply shows no trend chip — honest, and
 * better than the "+100%" or "+∞%" that a naive guard produces.
 */
function percentChange(current, previous) {
  if (!previous) return current > 0 ? null : 0;
  return round(((current - previous) / previous) * 100, 1);
}

/** Map a measurement onto a status band. Thresholds are inclusive lower bounds. */
function classify(value, { warning, degraded }) {
  if (value >= degraded) return 'degraded';
  if (value >= warning) return 'warning';
  return 'operational';
}

function worst(...statuses) {
  const rank = { operational: 0, warning: 1, degraded: 2, down: 3 };
  return statuses.reduce((acc, s) => (rank[s] > rank[acc] ? s : acc), 'operational');
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** End of today, UTC — the exclusive upper bound so today's partial day counts. */
function endOfUtcDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
