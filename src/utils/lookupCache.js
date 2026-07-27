// ============================================================
// Generic "code -> id" cache for small reference tables
// (message_statuses, recurrence_types, platforms). These tables
// rarely change after seeding, so we cache lookups in-process
// instead of hitting the DB on every job/request.
// ============================================================

import { prisma } from '../config/prisma.js';
import { AppError } from './AppError.js';

const caches = new Map(); // tableName -> Map(code -> row)

/**
 * @param {'messageStatus'|'recurrenceType'|'platform'} model  Prisma model accessor name
 * @param {string} code
 * @returns {Promise<{id: number, code: string}>}
 */
export async function lookupByCode(model, code) {
  if (!caches.has(model)) caches.set(model, new Map());
  const cache = caches.get(model);

  if (cache.has(code)) return cache.get(code);

  const row = await prisma[model].findUnique({ where: { code } });
  if (!row) {
    throw new AppError(500, `"${code}" is not seeded in ${model} — check your db:seed script`, {
      code: 'REFERENCE_NOT_SEEDED',
    });
  }
  cache.set(code, row);
  return row;
}

/** Clears all cached lookups — call after re-seeding in tests. */
export function clearLookupCache() {
  caches.clear();
}
