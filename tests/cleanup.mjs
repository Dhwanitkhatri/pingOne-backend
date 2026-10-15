// ============================================================
// Removes the accounts (and everything they own) created by the test suites.
// Every test account's email starts with "pingone-qa-" and ends with
// "@example.com", so real users can never match.
// ============================================================

import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/config/prisma.js';
import { env } from '../src/config/env.js';

export const EMAIL_PREFIX = 'pingone-qa-';
const BACKEND_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} [prefix] narrows the match, e.g. "pingone-qa-<run>-" to
 *   remove only one run's accounts. Defaults to every test account.
 * @returns {Promise<number>} accounts removed
 */
export async function cleanupTestData(prefix = EMAIL_PREFIX) {
  if (!prefix.startsWith(EMAIL_PREFIX)) throw new Error(`refusing to clean up "${prefix}"`);

  const users = await prisma.user.findMany({
    where: { email: { startsWith: prefix, endsWith: '@example.com' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (!ids.length) return 0;

  const attachments = await prisma.messageAttachment.findMany({
    where: { message: { userId: { in: ids } } },
    select: { fileUrl: true },
  });
  for (const { fileUrl } of attachments) {
    const file = path.join(BACKEND_ROOT, env.UPLOAD_DIR, 'attachments', path.basename(new URL(fileUrl).pathname));
    if (existsSync(file)) unlinkSync(file);
  }

  // Children before parents: deliveries, recipients and jobs reference
  // contacts/messages with ON DELETE NO ACTION, so the user cascade alone
  // would be refused.
  const inJobs = { job: { userId: { in: ids } } };
  const jobs = await prisma.scheduledJob.findMany({ where: { userId: { in: ids } }, select: { recurrenceRuleId: true } });
  await prisma.deliveryStatusLog.deleteMany({ where: { delivery: inJobs } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.messageDelivery.deleteMany({ where: inJobs });
  await prisma.jobRecipient.deleteMany({ where: inJobs });
  await prisma.scheduledJob.deleteMany({ where: { userId: { in: ids } } });
  await prisma.recurrenceRule.deleteMany({ where: { id: { in: jobs.map((j) => j.recurrenceRuleId).filter(Boolean) } } });
  await prisma.contactReply.deleteMany({ where: { contact: { userId: { in: ids } } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}
