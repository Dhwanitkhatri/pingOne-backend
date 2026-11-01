// ============================================================
// Platform reference-table lookups.
//
// `platforms` is a small, seeded, effectively-immutable table, so the
// code -> id mapping is cached in memory after the first hit. Every
// module that has to turn a human-readable platform code ("telegram")
// into the SmallInt FK used by contacts / credentials / jobs goes
// through here instead of re-querying.
// ============================================================

import { prisma } from '../config/prisma.js';
import { AppError } from './AppError.js';

/** Canonical platform codes, matching prisma/seed.js. */
export const PLATFORM_CODES = ['whatsapp', 'telegram', 'gmail', 'sms'];

const idByCode = new Map();
const codeById = new Map();

/** Load the whole table into the cache (one query, done once). */
async function loadCache() {
  if (idByCode.size) return;

  const rows = await prisma.platform.findMany({ select: { id: true, code: true } });
  if (!rows.length) {
    // A deploy problem, not the user's: `start` only runs migrations, so a
    // fresh database has an empty reference table until someone seeds it.
    // The fix goes in the server log; the client gets a plain 500.
    console.error('[platforms] The platforms table is empty — run `npm run db:seed` against this database.');
    throw new AppError(500, 'Something went wrong on our side. Please try again later.', {
      code: 'PLATFORMS_NOT_SEEDED',
    });
  }

  for (const { id, code } of rows) {
    idByCode.set(code, id);
    codeById.set(id, code);
  }
}

/**
 * Resolve a platform code to its numeric id.
 * @param {string} code e.g. 'telegram'
 * @returns {Promise<number>}
 */
export async function getPlatformId(code) {
  await loadCache();

  const id = idByCode.get(code);
  if (id === undefined) {
    throw AppError.badRequest(`Unknown platform "${code}"`, {
      code: 'UNKNOWN_PLATFORM',
      details: { supported: [...idByCode.keys()] },
    });
  }
  return id;
}

/**
 * Resolve a platform id back to its code. Returns undefined for ids that
 * aren't in the table.
 * @param {number} id
 * @returns {Promise<string | undefined>}
 */
export async function getPlatformCode(id) {
  await loadCache();
  return codeById.get(id);
}

/**
 * The full code -> id map (a copy, so callers can't corrupt the cache).
 * @returns {Promise<Map<string, number>>}
 */
export async function getPlatformMap() {
  await loadCache();
  return new Map(idByCode);
}
