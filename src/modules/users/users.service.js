// ============================================================
// User settings service — notification preferences.
//
// Signup creates the preferences row, but reads still upsert: an account
// created before this table existed (or one whose row was cleaned up)
// should get sensible defaults instead of a 404. The schema defaults are
// the single source of truth for what those are.
// ============================================================

import { prisma } from '../../config/prisma.js';

const preferenceSelect = {
  notifyOnFailure: true,
  notifyOnSuccess: true,
  notifyOnTokenExpiry: true,
  digestFrequency: true,
  updatedAt: true,
};

/** Read the user's preferences, creating the defaults row if absent. */
export function getPreferences(userId) {
  return prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId }, // all columns fall back to their schema defaults
    update: {},
    select: preferenceSelect,
  });
}

/**
 * Partially update the preferences. Upsert covers the case where the row
 * doesn't exist yet, so the first write never has to be preceded by a read.
 */
export function updatePreferences(userId, input) {
  const data = {};
  if (input.notifyOnFailure !== undefined) data.notifyOnFailure = input.notifyOnFailure;
  if (input.notifyOnSuccess !== undefined) data.notifyOnSuccess = input.notifyOnSuccess;
  if (input.notifyOnTokenExpiry !== undefined) data.notifyOnTokenExpiry = input.notifyOnTokenExpiry;
  if (input.digestFrequency !== undefined) data.digestFrequency = input.digestFrequency;

  return prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
    select: preferenceSelect,
  });
}
