// ============================================================
// Admin audit trail — the append-only record of back-office activity.
//
// Two rules this module exists to enforce:
//
//   1. Writing an audit row must NEVER break the action it describes. A
//      suspension that succeeded but whose log insert failed is still a
//      suspension; throwing here would roll back real work over bookkeeping.
//      So `record()` swallows and logs its own errors.
//
//   2. Nothing is ever updated or deleted. There is no update/delete export
//      in this file, deliberately.
// ============================================================

import { prisma } from '../../config/prisma.js';

/** Canonical action verbs. Keep them dotted and stable — the UI groups on them. */
export const AUDIT_ACTION = Object.freeze({
  LOGIN: 'admin.login',
  LOGIN_DENIED: 'admin.login_denied',
  LOGOUT: 'admin.logout',
  USER_SUSPEND: 'user.suspend',
  USER_REACTIVATE: 'user.reactivate',
  USER_ROLE_CHANGE: 'user.role_change',
  USER_DELETE: 'user.delete',
  MESSAGE_RETRY: 'message.retry',
  PLATFORM_ENABLE: 'platform.enable',
  PLATFORM_DISABLE: 'platform.disable',
});

/**
 * Append one row to the trail.
 *
 * @param {object} entry
 * @param {number}  entry.adminId      who acted
 * @param {string}  entry.action       one of AUDIT_ACTION
 * @param {string} [entry.targetType]  'user' | 'message' | 'platform' | 'system'
 * @param {number} [entry.targetId]
 * @param {number} [entry.targetUserId] set as well as targetId when the target IS a user
 * @param {string} [entry.targetLabel] readable remnant (an email) for after deletion
 * @param {object} [entry.metadata]    before/after values, failure reasons
 * @param {{ ipAddress?: string, userAgent?: string }} [context]
 */
export async function record(entry, context = {}) {
  try {
    await prisma.adminAuditLog.create({
      data: {
        adminId: entry.adminId,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        targetUserId: entry.targetUserId ?? null,
        targetLabel: entry.targetLabel?.slice(0, 255) ?? null,
        metadata: entry.metadata ?? {},
        ipAddress: context.ipAddress?.slice(0, 64) ?? null,
        userAgent: context.userAgent?.slice(0, 255) ?? null,
      },
    });
  } catch (err) {
    // See rule 1 above — never let bookkeeping fail the operation.
    console.error(`[audit] failed to record "${entry.action}": ${err.message}`);
  }
}

/**
 * Read the trail, newest first. Cursor-paginated on the primary key rather
 * than OFFSET, so deep pages stay cheap and a row inserted mid-scroll can't
 * shift the window and duplicate an entry.
 *
 * @param {{ limit?: number, cursor?: number, action?: string, adminId?: number }} options
 */
export async function list({ limit = 25, cursor, action, adminId } = {}) {
  const rows = await prisma.adminAuditLog.findMany({
    where: {
      ...(action && { action }),
      ...(adminId && { adminId }),
      ...(cursor && { id: { lt: cursor } }),
    },
    // One extra row is the cheapest possible "is there a next page?" probe.
    take: limit + 1,
    orderBy: { id: 'desc' },
    include: {
      admin: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    entries: page.map((row) => ({
      id: row.id,
      action: row.action,
      admin: row.admin && {
        id: row.admin.id,
        name: `${row.admin.firstName} ${row.admin.lastName}`.trim(),
        email: row.admin.email,
      },
      target: {
        type: row.targetType,
        id: row.targetId,
        label: row.targetLabel,
      },
      metadata: row.metadata,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}
