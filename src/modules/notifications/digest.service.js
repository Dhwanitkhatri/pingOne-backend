// ============================================================
// Summary email ("Weekly summary" in Settings) — a recap of everything the
// user sent over the last period, broken down by outcome and platform.
//
// NotificationPreference.digestFrequency picks the period (daily / weekly /
// monthly / never) and lastDigestSentAt records the last one, so the next is
// due one full period later — counted from signup for the very first. That
// survives restarts and a worker that was switched off for a while: an
// overdue digest simply goes out on the next check, once.
//
// Called from the scheduler worker's tick (see scheduler.worker.js).
// ============================================================

import { prisma } from '../../config/prisma.js';
import { sendDigestEmail } from '../../utils/mailer.js';
import { MESSAGE_STATUS } from '../../constants/codes.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long each frequency's period is. 'never' is simply absent. */
export const DIGEST_PERIOD_MS = Object.freeze({
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  monthly: 30 * DAY_MS,
});

/**
 * Send every digest that has come due.
 * @param {Date} [now]
 * @returns {Promise<{ sent: number, skipped: number, failed: number }>}
 */
export async function sendDueDigests(now = new Date()) {
  const summary = { sent: 0, skipped: 0, failed: 0 };

  const preferences = await prisma.notificationPreference.findMany({
    where: {
      digestFrequency: { in: Object.keys(DIGEST_PERIOD_MS) },
      // Unverified addresses may not be the user's; disabled and deleted
      // accounts get nothing.
      user: { isVerified: true, isActive: true, deletedAt: null },
    },
    select: {
      id: true,
      userId: true,
      digestFrequency: true,
      lastDigestSentAt: true,
      user: { select: { email: true, firstName: true, createdAt: true } },
    },
  });

  for (const pref of preferences) {
    const periodMs = DIGEST_PERIOD_MS[pref.digestFrequency];
    const since = pref.lastDigestSentAt ?? pref.user.createdAt;
    if (now - since < periodMs) continue;

    // Claim it first: the update only matches while lastDigestSentAt is still
    // what we read, so two workers running the same tick can't both send.
    const claimed = await prisma.notificationPreference.updateMany({
      where: { id: pref.id, lastDigestSentAt: pref.lastDigestSentAt },
      data: { lastDigestSentAt: now },
    });
    if (claimed.count === 0) continue;

    try {
      const stats = await collectStats(pref.userId, since, now);
      // Nothing sent in the period: an empty recap is just noise. The period
      // still counts as covered, so the next one starts from now.
      if (stats.total === 0) {
        summary.skipped += 1;
        continue;
      }

      await sendDigestEmail(pref.user.email, {
        firstName: pref.user.firstName,
        frequency: pref.digestFrequency,
        since,
        until: now,
        stats,
      });
      summary.sent += 1;
    } catch (err) {
      // Release the claim so the next check retries this digest.
      await prisma.notificationPreference
        .update({ where: { id: pref.id }, data: { lastDigestSentAt: pref.lastDigestSentAt } })
        .catch(() => {});
      console.error(`[digest] could not send the ${pref.digestFrequency} digest for user ${pref.userId}: ${err.message}`);
      summary.failed += 1;
    }
  }

  if (summary.sent || summary.failed) {
    console.log(`[digest] sent ${summary.sent}, failed ${summary.failed}, empty ${summary.skipped}`);
  }
  return summary;
}

/**
 * Deliveries created in [since, until) for one user, counted by outcome and
 * platform, plus how many distinct messages (jobs) they came from.
 */
async function collectStats(userId, since, until) {
  const where = { job: { userId }, createdAt: { gte: since, lt: until } };

  const [rows, statuses, platforms, messages] = await Promise.all([
    prisma.messageDelivery.groupBy({ by: ['statusId', 'platformId'], where, _count: { _all: true } }),
    prisma.messageStatus.findMany({ select: { id: true, code: true } }),
    prisma.platform.findMany({ select: { id: true, name: true } }),
    prisma.scheduledJob.count({ where: { userId, deliveries: { some: { createdAt: { gte: since, lt: until } } } } }),
  ]);

  const statusCode = new Map(statuses.map((s) => [s.id, s.code]));
  const platformName = new Map(platforms.map((p) => [p.id, p.name]));

  const stats = { messages, total: 0, delivered: 0, sent: 0, failed: 0, inProgress: 0, byPlatform: {} };
  for (const row of rows) {
    const count = row._count._all;
    const code = statusCode.get(row.statusId);
    const name = platformName.get(row.platformId) ?? 'Other';

    stats.total += count;
    stats.byPlatform[name] = (stats.byPlatform[name] ?? 0) + count;

    if (code === MESSAGE_STATUS.DELIVERED || code === MESSAGE_STATUS.READ) stats.delivered += count;
    else if (code === MESSAGE_STATUS.SENT) stats.sent += count;
    else if (code === MESSAGE_STATUS.FAILED) stats.failed += count;
    else if (code !== MESSAGE_STATUS.CANCELLED) stats.inProgress += count;
  }
  return stats;
}
