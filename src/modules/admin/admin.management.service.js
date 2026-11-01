// ============================================================
// Admin management services: Users, Messages, Platforms, Analytics & Settings.
// All operations are PLATFORM-WIDE and must run behind requireAdmin / requireSuperAdmin.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import {
  CHANGED_BY,
  MAX_RETRY_ATTEMPTS,
  MESSAGE_STATUS,
  RETRY_BACKOFF_MS,
} from '../../constants/codes.js';
import { transitionStatus } from '../deliveries/delivery-status.service.js';
import { assertQueueReachable, enqueueDelivery } from '../../queue/queue.service.js';
import * as audit from './audit.service.js';
import { AUDIT_ACTION } from './audit.service.js';
import { AppError } from '../../utils/AppError.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A pending/sending delivery untouched for this long has lost its queue job —
 * a healthy one is picked up within seconds, and even the longest retry
 * backoff (10 min) moves it to `failed` first, which updates the row.
 */
const STUCK_AFTER_MINUTES = 15;

const isStuck = (delivery) =>
  [MESSAGE_STATUS.PENDING, MESSAGE_STATUS.SENDING].includes(delivery.status?.code) &&
  Date.now() - new Date(delivery.updatedAt).getTime() > STUCK_AFTER_MINUTES * 60_000;

const isRetryable = (delivery) => delivery.status?.code === MESSAGE_STATUS.FAILED || isStuck(delivery);

/**
 * The address a delivery went to on its own channel — an email for Gmail, the
 * Telegram handle for Telegram, the number for WhatsApp/SMS — mirroring how
 * scheduler/recipient-resolver.js picks it (platform handle, then primary).
 */
function recipientAddressFor(platformCode, contact) {
  if (!contact) return null;
  const handle = contact.platformHandles?.find((h) => h.platform?.code === platformCode)?.handle;
  if (platformCode === 'gmail') return handle ?? contact.emails?.[0]?.email ?? null;
  if (platformCode === 'telegram') return handle ?? null;
  return handle ?? contact.phones?.[0]?.phone ?? null;
}

/** Admin login throttle — applied in admin.routes.js, reported by getSystemSettings. */
export const ADMIN_LOGIN_LIMIT = Object.freeze({ max: 10, windowMinutes: 15 });

/* ── 1. Users Management ─────────────────────────────────────────────── */

export async function listUsers({
  page = 1,
  limit = 15,
  search,
  role,
  status,
  sortBy = 'createdAt',
  sortOrder = 'desc',
} = {}) {
  const skip = (page - 1) * limit;

  const where = {
    deletedAt: null,
    ...(role ? { role } : {}),
    ...(status === 'active' ? { isActive: true } : {}),
    ...(status === 'suspended' ? { isActive: false } : {}),
    ...(status === 'unverified' ? { isVerified: false } : {}),
    ...(search
      ? {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  // Determine sorting field
  let orderBy = { [sortBy]: sortOrder };
  if (sortBy === 'name') {
    orderBy = [{ firstName: sortOrder }, { lastName: sortOrder }];
  }

  const [total, users, totalAll, activeCount, unverifiedCount, suspendedCount] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        isActive: true,
        isVerified: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            messages: true,
            contacts: true,
            platformCredentials: true,
          },
        },
      },
    }),
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { deletedAt: null, isActive: true } }),
    prisma.user.count({ where: { deletedAt: null, isVerified: false } }),
    prisma.user.count({ where: { deletedAt: null, isActive: false } }),
  ]);

  return {
    users,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    },
    metrics: {
      totalUsers: totalAll,
      activeUsers: activeCount,
      unverifiedUsers: unverifiedCount,
      suspendedUsers: suspendedCount,
    },
  };
}

export async function getUserById(userId) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      isActive: true,
      isVerified: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
      platformCredentials: {
        select: {
          id: true,
          isActive: true,
          connectedAt: true,
          platform: { select: { code: true, name: true } },
        },
      },
      _count: {
        select: {
          messages: true,
          contacts: true,
          scheduledJobs: true,
        },
      },
    },
  });

  if (!user) {
    throw AppError.notFound('User not found');
  }

  // Fetch recent deliveries sent by this user's jobs
  const recentDeliveries = await prisma.messageDelivery.findMany({
    where: { job: { userId } },
    take: 5,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      status: { select: { code: true, description: true } },
      platform: { select: { code: true, name: true } },
      errorReason: true,
    },
  });

  // Recent audit actions targeting this user
  const auditLogs = await prisma.adminAuditLog.findMany({
    where: { targetUserId: userId },
    take: 5,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      action: true,
      createdAt: true,
      metadata: true,
      admin: { select: { firstName: true, lastName: true, email: true } },
    },
  });

  return {
    user,
    recentDeliveries,
    auditLogs,
  };
}

export async function updateUserStatus({ userId, isActive, reason, adminUser, sessionContext }) {
  if (adminUser.id === userId && !isActive) {
    throw AppError.badRequest('You cannot suspend your own account');
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, isActive: true },
  });

  if (!target) {
    throw AppError.notFound('User not found');
  }

  if (target.role === 'SUPER_ADMIN' && adminUser.role !== 'SUPER_ADMIN') {
    throw AppError.forbidden('Only a Super Admin can modify another Super Admin');
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { isActive },
    select: { id: true, email: true, isActive: true, role: true, updatedAt: true },
  });

  await audit.record(
    {
      adminId: adminUser.id,
      action: isActive ? AUDIT_ACTION.USER_REACTIVATE : AUDIT_ACTION.USER_SUSPEND,
      targetType: 'user',
      targetId: userId,
      targetUserId: userId,
      targetLabel: target.email,
      metadata: { reason: reason || (isActive ? 'Reactivated by admin' : 'Suspended by admin') },
    },
    sessionContext
  );

  return updated;
}

export async function updateUserRole({ userId, role, reason, adminUser, sessionContext }) {
  if (adminUser.id === userId) {
    throw AppError.badRequest('You cannot change your own role');
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true },
  });

  if (!target) {
    throw AppError.notFound('User not found');
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { role },
    select: { id: true, email: true, role: true, updatedAt: true },
  });

  await audit.record(
    {
      adminId: adminUser.id,
      action: AUDIT_ACTION.USER_ROLE_CHANGE,
      targetType: 'user',
      targetId: userId,
      targetUserId: userId,
      targetLabel: target.email,
      metadata: { oldRole: target.role, newRole: role, reason: reason || 'Role updated by super admin' },
    },
    sessionContext
  );

  return updated;
}

/* ── 2. Messages & Deliveries Management ────────────────────────────── */

export async function listMessages({
  page = 1,
  limit = 15,
  search,
  platform,
  status,
  days,
} = {}) {
  const skip = (page - 1) * limit;

  const where = {
    ...(days ? { createdAt: { gte: new Date(Date.now() - days * DAY_MS) } } : {}),
    ...(platform ? { platform: { code: platform } } : {}),
    ...(status ? { status: { code: status } } : {}),
    ...(search
      ? {
          OR: [
            { contact: { firstName: { contains: search, mode: 'insensitive' } } },
            { contact: { lastName: { contains: search, mode: 'insensitive' } } },
            { contact: { phones: { some: { phone: { contains: search } } } } },
            { contact: { emails: { some: { email: { contains: search, mode: 'insensitive' } } } } },
            { platformMessageId: { contains: search } },
            { errorReason: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [total, deliveries, counts] = await Promise.all([
    prisma.messageDelivery.count({ where }),
    prisma.messageDelivery.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        retryCount: true,
        errorReason: true,
        platformMessageId: true,
        platform: { select: { code: true, name: true } },
        status: { select: { code: true, description: true } },
        contact: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            // Primary first, so [0] is the address the worker actually used.
            phones: { select: { phone: true, isPrimary: true }, orderBy: { isPrimary: 'desc' }, take: 1 },
            emails: { select: { email: true, isPrimary: true }, orderBy: { isPrimary: 'desc' }, take: 1 },
            platformHandles: { select: { handle: true, platform: { select: { code: true } } } },
          },
        },
        job: {
          select: {
            id: true,
            user: { select: { id: true, firstName: true, lastName: true, email: true } },
            // Never the subject or body: what a user wrote is theirs. Support
            // works from delivery metadata (status, error, provider id, times)
            // — kept out at the query so it can't leak through the API either.
            message: { select: { id: true } },
          },
        },
      },
    }),
    prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS total_all,
        COUNT(*) FILTER (WHERE s.code IN ('sent', 'delivered', 'read'))::int AS sent_count,
        COUNT(*) FILTER (WHERE s.code IN ('delivered', 'read'))::int AS delivered_count,
        COUNT(*) FILTER (WHERE s.code = 'failed')::int AS failed_count,
        -- Queued or sending within the stuck threshold: genuinely in flight.
        -- Anything older lost its queue job (e.g. a worker that died, or one
        -- on another database took it) and will never move on its own.
        COUNT(*) FILTER (
          WHERE s.code IN ('pending', 'sending') AND d.updated_at >= NOW() - ${STUCK_AFTER_MINUTES}::int * INTERVAL '1 minute'
        )::int AS pending_count,
        COUNT(*) FILTER (
          WHERE s.code IN ('pending', 'sending') AND d.updated_at < NOW() - ${STUCK_AFTER_MINUTES}::int * INTERVAL '1 minute'
        )::int AS stuck_count
      FROM message_deliveries d
      JOIN message_statuses s ON s.id = d.status_id
    `,
  ]);

  const rawCount = counts[0] || {};
  const totalAll = rawCount.total_all ?? 0;
  const sentCount = rawCount.sent_count ?? 0;
  const failedCount = rawCount.failed_count ?? 0;
  // Of the deliveries that reached an outcome, how many the platform
  // accepted. Pending/stuck ones haven't succeeded OR failed yet, so counting
  // them against the rate (as this used to) understated it.
  const finished = sentCount + failedCount;
  const successRate = finished > 0 ? Math.round((sentCount / finished) * 100) : 100;

  return {
    deliveries: deliveries.map(({ contact, ...delivery }) => ({
      ...delivery,
      contact: contact && {
        id: contact.id,
        firstName: contact.firstName,
        lastName: contact.lastName,
        phones: contact.phones,
        emails: contact.emails,
      },
      recipientAddress: recipientAddressFor(delivery.platform?.code, contact),
      isStuck: isStuck(delivery),
    })),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    },
    metrics: {
      totalAll,
      sentCount,
      deliveredCount: rawCount.delivered_count ?? 0,
      failedCount,
      pendingCount: rawCount.pending_count ?? 0,
      stuckCount: rawCount.stuck_count ?? 0,
      successRate,
    },
  };
}

/**
 * Manually re-queue a failed — or stuck — delivery.
 *
 * `failed` is retryable, and so is a `pending`/`sending` row that hasn't moved
 * for STUCK_AFTER_MINUTES: its queue job is gone, so it would otherwise sit
 * there forever. A fresher pending row is still on the queue, and re-queueing
 * a `sent`/`delivered`/`read` one would message the recipient twice — the
 * worker's own guard only covers the confirmed states.
 *
 * The retry count is reset so the re-queued attempt gets the full automatic
 * backoff ladder again; a manual retry is a fresh start, not attempt N+1 of a
 * ladder that was already exhausted.
 */
export async function retryDelivery({ deliveryId, adminUser, sessionContext }) {
  const delivery = await prisma.messageDelivery.findUnique({
    where: { id: deliveryId },
    include: { status: true },
  });

  if (!delivery) {
    throw AppError.notFound('Delivery record not found');
  }

  if (!isRetryable(delivery)) {
    throw AppError.badRequest(
      `Only failed or stuck deliveries can be retried (this one is ${delivery.status.code})`,
      { code: 'DELIVERY_NOT_RETRYABLE' }
    );
  }

  // Before touching the row — a delivery flipped to pending with no queue job
  // behind it would sit there forever.
  await assertQueueReachable();

  // Through the status service, not a raw update, so delivery_status_logs
  // records the failed -> pending move like every other transition.
  const { delivery: updated } = await transitionStatus({
    deliveryId,
    toCode: MESSAGE_STATUS.PENDING,
    changedBy: CHANGED_BY.USER,
    errorReason: null,
    force: true,
    data: { retryCount: 0 },
  });

  await enqueueDelivery(deliveryId, 'high');

  await audit.record(
    {
      adminId: adminUser.id,
      action: AUDIT_ACTION.MESSAGE_RETRY,
      targetType: 'message',
      targetId: deliveryId,
      targetLabel: `Delivery #${deliveryId}`,
      metadata: {
        previousStatus: delivery.status.code,
        previousRetryCount: delivery.retryCount,
        previousError: delivery.errorReason,
      },
    },
    sessionContext
  );

  return updated;
}

/* ── 3. Platforms Management ─────────────────────────────────────────── */

export async function listPlatforms() {
  const now = new Date();
  const past24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [platforms, stats24h, credentialCounts] = await Promise.all([
    prisma.platform.findMany({
      orderBy: { id: 'asc' },
    }),
    // COUNT(d.id), not COUNT(*): the LEFT JOIN yields one all-NULL row for a
    // platform with no traffic, which COUNT(*) would report as 1 message.
    prisma.$queryRaw`
      SELECT
        p.code,
        COUNT(d.id)::int AS total_24h,
        COUNT(*) FILTER (WHERE s.code IN ('sent', 'delivered', 'read'))::int AS sent_24h,
        COUNT(*) FILTER (WHERE s.code = 'failed')::int AS failed_24h,
        MAX(d.created_at) AS last_delivery_at
      FROM platforms p
      LEFT JOIN message_deliveries d ON d.platform_id = p.id AND d.created_at >= ${past24h}
      LEFT JOIN message_statuses s ON s.id = d.status_id
      GROUP BY p.code
    `,
    prisma.userPlatformCredential.groupBy({
      by: ['platformId'],
      where: { isActive: true },
      _count: { id: true },
    }),
  ]);

  const statsMap = new Map(stats24h.map((s) => [s.code, s]));
  const credMap = new Map(credentialCounts.map((c) => [c.platformId, c._count.id]));

  const enriched = platforms.map((p) => {
    const stat = statsMap.get(p.code) || {};
    const total24h = stat.total_24h ?? 0;
    const sent24h = stat.sent_24h ?? 0;
    const failed24h = stat.failed_24h ?? 0;
    const successRate = total24h > 0 ? Math.round((sent24h / total24h) * 100) : 100;

    return {
      id: p.id,
      code: p.code,
      name: p.name,
      isActive: p.isActive,
      connectedUsersCount: credMap.get(p.id) ?? 0,
      throughput24h: total24h,
      sent24h,
      failed24h,
      successRate,
      lastDeliveryAt: stat.last_delivery_at ?? null,
      status: !p.isActive ? 'disabled' : failed24h > 10 && successRate < 80 ? 'degraded' : 'operational',
    };
  });

  return { platforms: enriched };
}

export async function togglePlatform({ code, isActive, adminUser, sessionContext }) {
  const platform = await prisma.platform.findUnique({
    where: { code },
  });

  if (!platform) {
    throw AppError.notFound(`Platform ${code} not found`);
  }

  const updated = await prisma.platform.update({
    where: { code },
    data: { isActive },
  });

  await audit.record(
    {
      adminId: adminUser.id,
      action: isActive ? AUDIT_ACTION.PLATFORM_ENABLE : AUDIT_ACTION.PLATFORM_DISABLE,
      targetType: 'platform',
      targetLabel: platform.name,
      metadata: { platformCode: code, isActive },
    },
    sessionContext
  );

  return updated;
}

/* ── 4. Analytics & Reporting ────────────────────────────────────────── */

export async function getAnalytics({ days = 30 } = {}) {
  const to = new Date();
  const from = new Date(to.getTime() - days * DAY_MS);

  const [volumeSeries, hourlyDist, failureReasons, topSenders] = await Promise.all([
    // Daily volume
    prisma.$queryRaw`
      SELECT
        date_trunc('day', d.created_at) AS bucket,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE s.code IN ('sent', 'delivered', 'read'))::int AS sent,
        COUNT(*) FILTER (WHERE s.code = 'failed')::int AS failed
      FROM message_deliveries d
      JOIN message_statuses s ON s.id = d.status_id
      WHERE d.created_at >= ${from} AND d.created_at < ${to}
      GROUP BY bucket
      ORDER BY bucket ASC
    `,

    // Hourly distribution (0 to 23 UTC)
    prisma.$queryRaw`
      SELECT
        EXTRACT(HOUR FROM d.created_at)::int AS hour,
        COUNT(*)::int AS count
      FROM message_deliveries d
      WHERE d.created_at >= ${from} AND d.created_at < ${to}
      GROUP BY hour
      ORDER BY hour ASC
    `,

    // Top failure reasons
    prisma.$queryRaw`
      SELECT
        COALESCE(NULLIF(TRIM(d.error_reason), ''), 'Unknown Provider Error') AS reason,
        COUNT(*)::int AS count
      FROM message_deliveries d
      JOIN message_statuses s ON s.id = d.status_id
      WHERE s.code = 'failed' AND d.created_at >= ${from} AND d.created_at < ${to}
      GROUP BY reason
      ORDER BY count DESC
      LIMIT 6
    `,

    // Top active users
    prisma.$queryRaw`
      SELECT
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        COUNT(d.id)::int AS total_sent,
        COUNT(d.id) FILTER (WHERE s.code = 'failed')::int AS failed_count
      FROM users u
      JOIN scheduled_jobs j ON j.user_id = u.id
      JOIN message_deliveries d ON d.job_id = j.id
      JOIN message_statuses s ON s.id = d.status_id
      WHERE d.created_at >= ${from} AND d.created_at < ${to}
      GROUP BY u.id, u.first_name, u.last_name, u.email
      ORDER BY total_sent DESC
      LIMIT 8
    `,
  ]);

  // Fill in complete hour range 0..23
  const hourMap = new Map(hourlyDist.map((h) => [h.hour, h.count]));
  const fullHourly = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    label: `${i.toString().padStart(2, '0')}:00`,
    count: hourMap.get(i) ?? 0,
  }));

  const totalDispatched = volumeSeries.reduce((acc, row) => acc + (row.total ?? 0), 0);
  const totalSent = volumeSeries.reduce((acc, row) => acc + (row.sent ?? 0), 0);
  const totalFailed = volumeSeries.reduce((acc, row) => acc + (row.failed ?? 0), 0);
  const avgSuccessRate = totalDispatched > 0 ? Math.round((totalSent / totalDispatched) * 100) : 100;

  // GROUP BY only returns days that had traffic. Zero-fill the rest so the
  // chart's x axis is real calendar time — otherwise a quiet week collapses
  // and the line draws a straight slope across days that never happened.
  const byDay = new Map(volumeSeries.map((r) => [r.bucket.toISOString().slice(0, 10), r]));
  const firstDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const filledSeries = [];
  for (let t = firstDay.getTime(); t <= to.getTime(); t += DAY_MS) {
    const day = new Date(t);
    const row = byDay.get(day.toISOString().slice(0, 10));
    filledSeries.push({
      date: day.toISOString(),
      label: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      total: row?.total ?? 0,
      sent: row?.sent ?? 0,
      failed: row?.failed ?? 0,
    });
  }

  return {
    range: { days, from, to },
    summary: {
      totalDispatched,
      totalSent,
      totalFailed,
      avgSuccessRate,
      // Over the whole window, not just the days that had traffic.
      dailyAverage: Math.round(totalDispatched / days),
    },
    volumeSeries: filledSeries,
    hourlyDistribution: fullHourly,
    failureReasons,
    topSenders: topSenders.map((s) => ({
      id: s.id,
      name: `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim() || 'User',
      email: s.email,
      totalSent: s.total_sent ?? 0,
      failedCount: s.failed_count ?? 0,
      successRate: s.total_sent > 0 ? Math.round(((s.total_sent - s.failed_count) / s.total_sent) * 100) : 100,
    })),
  };
}

/* ── 5. Settings & Operators ─────────────────────────────────────────── */

export async function getOperators() {
  const operators = await prisma.user.findMany({
    where: {
      role: { in: ['ADMIN', 'SUPER_ADMIN'] },
      deletedAt: null,
    },
    orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  return { operators };
}

/**
 * Read-only runtime configuration for the Settings page.
 *
 * Every value here is read from the config that actually governs behaviour —
 * env and constants/codes.js. A settings page that prints hard-coded numbers
 * tells an operator something about the system that may simply be false.
 */
export async function getSystemSettings() {
  const memory = process.memoryUsage();

  return {
    environment: env.NODE_ENV,
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    memoryUsageMb: Math.round(memory.heapUsed / 1024 / 1024),
    securityPolicies: {
      accessTokenTtl: env.JWT_ACCESS_EXPIRES_IN,
      refreshTokenTtl: env.JWT_REFRESH_EXPIRES_IN,
      adminLoginMaxAttempts: ADMIN_LOGIN_LIMIT.max,
      adminLoginWindowMinutes: ADMIN_LOGIN_LIMIT.windowMinutes,
    },
    deliveryPolicies: {
      maxRetryAttempts: MAX_RETRY_ATTEMPTS,
      retryBackoffSeconds: RETRY_BACKOFF_MS.map((ms) => Math.round(ms / 1000)),
    },
  };
}
