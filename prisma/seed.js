// ============================================================
// PingOne — database seed
// Populates the four reference/lookup tables. Idempotent: uses
// upsert on the unique `code`, so re-running never duplicates rows.
// Run with: npm run db:seed   (or `prisma db seed`)
// ============================================================

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const platforms = [
  { code: 'whatsapp', name: 'WhatsApp' },
  { code: 'telegram', name: 'Telegram' },
  { code: 'gmail', name: 'Gmail' },
  { code: 'sms', name: 'SMS' },
];

const messageStatuses = [
  { code: 'pending', description: 'Queued, not yet sent' },
  { code: 'sending', description: 'Send in progress' },          // ADD
  { code: 'sent', description: 'Sent to platform API' },
  { code: 'delivered', description: 'Confirmed delivered to recipient' },
  { code: 'read', description: 'Confirmed read by recipient' },  // ADD
  { code: 'failed', description: 'Send attempt failed' },
  { code: 'cancelled', description: 'Cancelled by user before sending' },
];

const recurrenceTypes = [
  { code: 'none', description: 'One-time send, no recurrence' },
  { code: 'daily', description: 'Repeats every N days' },
  { code: 'weekly', description: 'Repeats on selected days of the week' },
  { code: 'monthly', description: 'Repeats on a specific day of the month' },
  { code: 'yearly', description: 'Repeats on a specific date every year' },
];

const fileTypes = [
  { code: 'image', mimePrefix: 'image/' },
  { code: 'pdf', mimePrefix: 'application/pdf' },
  { code: 'video', mimePrefix: 'video/' },
  { code: 'audio', mimePrefix: 'audio/' },
  { code: 'document', mimePrefix: 'application/' },
];

/**
 * Bootstrap the first back-office operator.
 *
 * Runs only when ADMIN_EMAIL and ADMIN_PASSWORD are both set, so a normal
 * `db:seed` on a developer machine or a production deploy stays a pure
 * reference-data seed and never quietly mints a privileged account.
 *
 * Idempotent in the safe direction: an existing account is PROMOTED to
 * SUPER_ADMIN, but its password is left alone. Re-running the seed must not
 * reset a live operator's password back to whatever is sitting in .env.
 */
async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.log('Skipped admin bootstrap — set ADMIN_EMAIL and ADMIN_PASSWORD to create one.');
    return;
  }

  if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });

  if (existing) {
    if (existing.role === 'SUPER_ADMIN') {
      console.log(`Admin bootstrap: ${email} is already a SUPER_ADMIN — nothing to do.`);
      return;
    }
    await prisma.user.update({ where: { id: existing.id }, data: { role: 'SUPER_ADMIN' } });
    console.log(`Admin bootstrap: promoted existing account ${email} to SUPER_ADMIN (password unchanged).`);
    return;
  }

  const rounds = Number(process.env.BCRYPT_SALT_ROUNDS ?? 12);

  await prisma.user.create({
    data: {
      firstName: process.env.ADMIN_FIRST_NAME?.trim() || 'Admin',
      lastName: process.env.ADMIN_LAST_NAME?.trim() || 'User',
      email,
      passwordHash: await bcrypt.hash(password, rounds),
      role: 'SUPER_ADMIN',
      isVerified: true,
      notificationPreferences: { create: {} },
    },
  });

  console.log(`Admin bootstrap: created SUPER_ADMIN ${email}.`);
}

async function main() {
  console.log('Seeding reference tables…');

  for (const p of platforms) {
    await prisma.platform.upsert({
      where: { code: p.code },
      update: { name: p.name },
      create: p,
    });
  }

  for (const s of messageStatuses) {
    await prisma.messageStatus.upsert({
      where: { code: s.code },
      update: { description: s.description },
      create: s,
    });
  }

  for (const r of recurrenceTypes) {
    await prisma.recurrenceType.upsert({
      where: { code: r.code },
      update: { description: r.description },
      create: r,
    });
  }

  for (const f of fileTypes) {
    await prisma.fileType.upsert({
      where: { code: f.code },
      update: { mimePrefix: f.mimePrefix },
      create: f,
    });
  }

  console.log(
    `Seeded: ${platforms.length} platforms, ${messageStatuses.length} statuses, ` +
      `${recurrenceTypes.length} recurrence types, ${fileTypes.length} file types.`
  );

  await seedAdmin();
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
