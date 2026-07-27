// ============================================================
// Contacts service.
//
// A contact is a small aggregate: the row in `contacts` plus its phones,
// emails and per-platform handles. Everything here is scoped to the
// owning user — every query carries `userId`, so one user can never read
// or mutate another's contacts even by guessing ids.
//
// Deletes are SOFT (deleted_at) because contacts are referenced by
// delivery history; every read filters `deletedAt: null`.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { getPlatformId, getPlatformMap } from '../../utils/platforms.js';
import { normalizePhone, toSkipTake, paginationMeta } from '../../utils/validators.js';

const contactSelect = {
  id: true,
  firstName: true,
  lastName: true,
  createdAt: true,
  updatedAt: true,
  preferredPlatform: { select: { code: true, name: true } },
  phones: {
    select: { id: true, phone: true, isPrimary: true },
    orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
  },
  emails: {
    select: { id: true, email: true, isPrimary: true },
    orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
  },
  platformHandles: {
    select: { id: true, handle: true, platform: { select: { code: true, name: true } } },
  },
  groupMemberships: { select: { group: { select: { id: true, name: true } } } },
};

/** Flatten the join table into a plain `groups` array for the client. */
function shapeContact(contact) {
  const { groupMemberships, preferredPlatform, platformHandles, ...rest } = contact;
  return {
    ...rest,
    preferredPlatform: preferredPlatform?.code ?? null,
    platformHandles: platformHandles.map((h) => ({
      id: h.id,
      platform: h.platform.code,
      handle: h.handle,
    })),
    groups: groupMemberships.map((m) => m.group),
  };
}

// ---- input normalisation -------------------------------------------

/**
 * De-duplicate a phone/email list and guarantee EXACTLY ONE primary:
 * the first entry flagged primary, or the first entry if none was.
 * Returns undefined when the caller didn't send the field at all
 * (meaning "leave it alone"), vs [] for an explicit empty list.
 */
function prepareFlagged(entries, field) {
  if (entries === undefined) return undefined;

  const byValue = new Map();
  for (const entry of entries) {
    const value = entry[field];
    if (byValue.has(value)) {
      if (entry.isPrimary) byValue.get(value).isPrimary = true;
    } else {
      byValue.set(value, { [field]: value, isPrimary: Boolean(entry.isPrimary) });
    }
  }

  const rows = [...byValue.values()];
  if (rows.length) {
    const flagged = rows.findIndex((r) => r.isPrimary);
    const primaryIndex = flagged === -1 ? 0 : flagged;
    rows.forEach((row, i) => {
      row.isPrimary = i === primaryIndex;
    });
  }
  return rows;
}

/** Resolve platform codes to ids; one handle per platform (unique index). */
async function prepareHandles(entries) {
  if (entries === undefined) return undefined;

  const platformMap = await getPlatformMap();
  const byPlatform = new Map();

  for (const { platform, handle } of entries) {
    const platformId = platformMap.get(platform);
    if (platformId === undefined) {
      throw AppError.badRequest(`Platform "${platform}" is not available`, {
        code: 'UNKNOWN_PLATFORM',
      });
    }
    byPlatform.set(platform, { platformId, handle });
  }

  return [...byPlatform.values()];
}

/** 404 unless the contact exists, is live, and belongs to this user. */
async function assertOwned(userId, contactId) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, userId, deletedAt: null },
    select: { id: true },
  });
  if (!contact) {
    throw AppError.notFound('Contact not found', { code: 'CONTACT_NOT_FOUND' });
  }
  return contact;
}

// ---- reads ----------------------------------------------------------

/** Paginated, searchable list of the user's contacts. */
export async function listContacts(userId, query) {
  const { search, groupId, platform, sort, sortBy } = query;

  const where = {
    userId,
    deletedAt: null,
    ...(groupId ? { groupMemberships: { some: { groupId } } } : {}),
    ...(platform ? { platformHandles: { some: { platformId: await getPlatformId(platform) } } } : {}),
    ...(search
      ? {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { emails: { some: { email: { contains: search, mode: 'insensitive' } } } },
            // Search phones on digits only, so "(415) 555-0100" finds +14155550100.
            { phones: { some: { phone: { contains: normalizePhone(search).replace('+', '') } } } },
          ],
        }
      : {}),
  };

  const [total, contacts] = await prisma.$transaction([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      select: contactSelect,
      orderBy: { [sortBy]: sort },
      ...toSkipTake(query),
    }),
  ]);

  return { data: contacts.map(shapeContact), pagination: paginationMeta(query, total) };
}

/** One contact, with all its children. */
export async function getContact(userId, contactId) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, userId, deletedAt: null },
    select: contactSelect,
  });
  if (!contact) {
    throw AppError.notFound('Contact not found', { code: 'CONTACT_NOT_FOUND' });
  }
  return shapeContact(contact);
}

// ---- writes ---------------------------------------------------------

/** Create a contact and its children in one nested write. */
export async function createContact(userId, input) {
  const phones = prepareFlagged(input.phones, 'phone');
  const emails = prepareFlagged(input.emails, 'email');
  const handles = await prepareHandles(input.platformHandles);
  const preferredPlatformId = input.preferredPlatform
    ? await getPlatformId(input.preferredPlatform)
    : null;

  const contact = await prisma.contact.create({
    data: {
      userId,
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      preferredPlatformId,
      ...(phones?.length ? { phones: { create: phones } } : {}),
      ...(emails?.length ? { emails: { create: emails } } : {}),
      ...(handles?.length ? { platformHandles: { create: handles } } : {}),
    },
    select: contactSelect,
  });

  return shapeContact(contact);
}

/**
 * Update a contact. Only the keys present in the body are touched; a
 * child collection that IS present is replaced wholesale (that's what
 * makes "remove a phone number" expressible).
 */
export async function updateContact(userId, contactId, input) {
  await assertOwned(userId, contactId);

  const phones = prepareFlagged(input.phones, 'phone');
  const emails = prepareFlagged(input.emails, 'email');
  const handles = await prepareHandles(input.platformHandles);

  const data = {};
  if (input.firstName !== undefined) data.firstName = input.firstName;
  if (input.lastName !== undefined) data.lastName = input.lastName ?? null;
  if (input.preferredPlatform !== undefined) {
    data.preferredPlatformId = input.preferredPlatform
      ? await getPlatformId(input.preferredPlatform)
      : null;
  }

  const contact = await prisma.$transaction(async (tx) => {
    if (phones !== undefined) {
      await tx.contactPhone.deleteMany({ where: { contactId } });
      if (phones.length) {
        await tx.contactPhone.createMany({ data: phones.map((p) => ({ ...p, contactId })) });
      }
    }
    if (emails !== undefined) {
      await tx.contactEmail.deleteMany({ where: { contactId } });
      if (emails.length) {
        await tx.contactEmail.createMany({ data: emails.map((e) => ({ ...e, contactId })) });
      }
    }
    if (handles !== undefined) {
      await tx.contactPlatformHandle.deleteMany({ where: { contactId } });
      if (handles.length) {
        await tx.contactPlatformHandle.createMany({
          data: handles.map((h) => ({ ...h, contactId })),
        });
      }
    }

    // Always runs, so @updatedAt is bumped even for a children-only edit.
    return tx.contact.update({ where: { id: contactId }, data, select: contactSelect });
  });

  return shapeContact(contact);
}

/**
 * Soft-delete. The row stays so delivery history keeps resolving, but the
 * contact disappears from every list and can no longer be targeted.
 */
export async function deleteContact(userId, contactId) {
  await assertOwned(userId, contactId);

  await prisma.$transaction([
    prisma.contact.update({ where: { id: contactId }, data: { deletedAt: new Date() } }),
    // Drop group memberships so group counts stay honest.
    prisma.contactGroupMember.deleteMany({ where: { contactId } }),
  ]);

  return { id: contactId, deleted: true };
}

// ---- import ---------------------------------------------------------

/**
 * Merge externally-sourced contacts (Google, CSV) into the user's book.
 *
 * A row matches an existing contact when it shares ANY email or phone
 * number. Matched rows gain whatever details they bring that the contact
 * doesn't already have; unmatched rows become new contacts. Rows are
 * processed in order and the index is updated as we go, so duplicates
 * *within* one import collapse into a single contact too.
 *
 * @param {number} userId
 * @param {Array<{firstName: string, lastName?: string|null, emails?: string[],
 *                phones?: string[], handles?: Array<{platform: string, handle: string}>}>} rows
 * @param {{ onDuplicate?: 'merge' | 'skip' }} [options]
 */
export async function mergeImportedContacts(userId, rows, { onDuplicate = 'merge' } = {}) {
  const existing = await prisma.contact.findMany({
    where: { userId, deletedAt: null },
    select: {
      id: true,
      emails: { select: { email: true } },
      phones: { select: { phone: true } },
    },
  });

  // value -> contactId lookup for match detection.
  const byEmail = new Map();
  const byPhone = new Map();
  for (const contact of existing) {
    for (const { email } of contact.emails) byEmail.set(email, contact.id);
    for (const { phone } of contact.phones) byPhone.set(phone, contact.id);
  }

  const platformMap = await getPlatformMap();
  const summary = { imported: 0, merged: 0, skipped: 0, failed: 0, errors: [] };

  for (const [index, row] of rows.entries()) {
    try {
      const emails = [...new Set(row.emails ?? [])];
      const phones = [...new Set(row.phones ?? [])];

      const matchId =
        emails.map((e) => byEmail.get(e)).find(Boolean) ??
        phones.map((p) => byPhone.get(p)).find(Boolean);

      if (matchId && onDuplicate === 'skip') {
        summary.skipped += 1;
        continue;
      }

      const handles = (row.handles ?? [])
        .filter((h) => platformMap.has(h.platform))
        .map((h) => ({ platformId: platformMap.get(h.platform), handle: h.handle }));

      if (matchId) {
        // skipDuplicates leans on the (contact_id, value) unique indexes, so
        // re-importing the same export is a no-op rather than an error.
        if (emails.length) {
          await prisma.contactEmail.createMany({
            data: emails.map((email) => ({ contactId: matchId, email, isPrimary: false })),
            skipDuplicates: true,
          });
        }
        if (phones.length) {
          await prisma.contactPhone.createMany({
            data: phones.map((phone) => ({ contactId: matchId, phone, isPrimary: false })),
            skipDuplicates: true,
          });
        }
        if (handles.length) {
          await prisma.contactPlatformHandle.createMany({
            data: handles.map((h) => ({ ...h, contactId: matchId })),
            skipDuplicates: true,
          });
        }
        summary.merged += 1;

        // Newly attached values must also resolve to this contact for the
        // rest of the batch.
        for (const email of emails) byEmail.set(email, matchId);
        for (const phone of phones) byPhone.set(phone, matchId);
      } else {
        const created = await prisma.contact.create({
          data: {
            userId,
            firstName: row.firstName,
            lastName: row.lastName ?? null,
            ...(emails.length
              ? { emails: { create: emails.map((email, i) => ({ email, isPrimary: i === 0 })) } }
              : {}),
            ...(phones.length
              ? { phones: { create: phones.map((phone, i) => ({ phone, isPrimary: i === 0 })) } }
              : {}),
            ...(handles.length ? { platformHandles: { create: handles } } : {}),
          },
          select: { id: true },
        });
        summary.imported += 1;

        // Index the new contact so later rows in this same batch match it.
        for (const email of emails) byEmail.set(email, created.id);
        for (const phone of phones) byPhone.set(phone, created.id);
      }
    } catch (err) {
      summary.failed += 1;
      if (summary.errors.length < 20) {
        summary.errors.push({ row: index + 1, name: row.firstName, message: err.message });
      }
    }
  }

  return summary;
}
