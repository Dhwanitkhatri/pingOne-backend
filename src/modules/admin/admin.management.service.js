// ============================================================
// Admin management services: Users, Messages, Platforms, Analytics & Settings.
// All operations are PLATFORM-WIDE and must run behind requireAdmin / requireSuperAdmin.
// ============================================================

import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { MESSAGE_STATUS, SUCCESS_STATUSES } from '../../constants/codes.js';
import * as audit from './audit.service.js';
import { AUDIT_ACTION } from './audit.service.js';
import { AppError } from '../../utils/AppError.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
            phones: { select: { phone: true, isPrimary: true }, take: 1 },
            emails: { select: { email: true, isPrimary: true }, take: 1 },
          },
        },
        job: {
          select: {
            id: true,
            user: { select: { id: true, firstName: true, lastName: true, email: true } },
            message: { select: { id: true, subject: true, content: true } },
          },
        },
      },
    }),
    prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS total_all,
        COUNT(*) FILTER (WHERE s.code IN ('sent', 'delivered', 'read'))::int AS sent_count,
        COUNT(*) FILTER (WHERE s.code = 'delivered')::int AS delivered_count,
        COUNT(*) FILTER (WHERE s.code = 'failed')::int AS failed_count,
        COUNT(*) FILTER (WHERE s.code IN ('pending', 'sending'))::int AS pending_count
      FROM message_deliveries d
      JOIN message_statuses s ON s.id = d.status_id
    `,
  ]);

  const rawCount = counts[0] || {};
  const totalAll = rawCount.total_all ?? 0;
  const sentCount = rawCount.sent_count ?? 0;
  const failedCount = rawCount.failed_count ?? 0;
  const successRate = totalAll > 0 ? Math.round((sentCount / totalAll) * 100) : 100;

  return {
    deliveries,
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
      successRate,
    },
  };
}

export async function retryDelivery({ deliveryId, adminUser, sessionContext }) {
  const delivery = await prisma.messageDelivery.findUnique({
    where: { id: deliveryId },
    include: { status: true },
  });

  if (!delivery) {
    throw AppError.notFound('Delivery record not found');
  }

  const pendingStatus = await prisma.messageStatus.findUnique({
    where: { code: MESSAGE_STATUS.PENDING },
  });

  if (!pendingStatus) {
    throw AppError.internal('Pending status not configured');
  }

  const updated = await prisma.messageDelivery.update({
    where: { id: deliveryId },
    data: {
      statusId: pendingStatus.id,
      errorReason: null,
      retryCount: { increment: 1 },
    },
    include: {
      status: true,
      platform: true,
    },
  });

  await audit.record(
    {
      adminId: adminUser.id,
      action: 'message.retry',
      targetType: 'message',
      targetId: deliveryId,
      targetLabel: `Delivery #${deliveryId}`,
      metadata: { previousStatus: delivery.status.code, retryCount: updated.retryCount },
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
    prisma.$queryRaw`
      SELECT
        p.code,
        COUNT(*)::int AS total_24h,
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
      action: isActive ? 'platform.enable' : 'platform.disable',
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

  return {
    range: { days, from, to },
    summary: {
      totalDispatched,
      totalSent,
      totalFailed,
      avgSuccessRate,
      dailyAverage: volumeSeries.length ? Math.round(totalDispatched / volumeSeries.length) : 0,
    },
    volumeSeries: volumeSeries.map((r) => ({
      date: r.bucket.toISOString(),
      label: new Date(r.bucket).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      total: r.total ?? 0,
      sent: r.sent ?? 0,
      failed: r.failed ?? 0,
    })),
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

export async function getSystemSettings() {
  const memory = process.memoryUsage();

  return {
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    memoryUsageMb: Math.round(memory.heapUsed / 1024 / 1024),
    securityPolicies: {
      sessionTimeoutMinutes: 60,
      maxLoginAttempts: 10,
      lockoutMinutes: 15,
      requireEmailVerification: true,
      corsOrigins: process.env.CORS_ORIGINS || 'http://localhost:5173',
    },
    deliveryPolicies: {
      maxRetryAttempts: 3,
      retryBackoffSeconds: 30,
      batchSize: 50,
      webhookTimeoutSeconds: 10,
    },
  };
}
