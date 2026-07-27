// ============================================================
// PingOne — database seed
// Populates the four reference/lookup tables. Idempotent: uses
// upsert on the unique `code`, so re-running never duplicates rows.
// Run with: npm run db:seed   (or `prisma db seed`)
// ============================================================

import { PrismaClient } from '@prisma/client';

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
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
