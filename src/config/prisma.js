// ============================================================
// Prisma client singleton.
// A single shared instance is reused across the app (and survives
// hot-reloads in dev via globalThis) to avoid exhausting the DB
// connection pool with a new client on every import/reload.
// ============================================================

import { PrismaClient } from '@prisma/client';
import { isDev } from './env.js';

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__pingonePrisma ??
  new PrismaClient({
    log: isDev ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (isDev) {
  globalForPrisma.__pingonePrisma = prisma;
}
