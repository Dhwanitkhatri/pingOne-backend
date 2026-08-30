// ============================================================
// Contact groups service.
//
// Groups are just named sets of the user's own contacts, joined through
// contact_group_members (composite PK: contact_id + group_id, so a
// contact can't be added twice). Membership writes verify that EVERY
// contact id belongs to the caller — otherwise a group would become a
// way to probe other users' contact ids.
//
// Like contacts, deletes are soft.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { toSkipTake, paginationMeta } from '../../utils/validators.js';

const groupSelect = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { members: true } },
};

const memberSelect = {
  addedAt: true,
  contact: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phones: {
        select: { phone: true, isPrimary: true },
        orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
      },
      emails: {
        select: { email: true, isPrimary: true },
        orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
      },
      // Carried so a "message this group" flow can address each member the
      // same way the contacts list does — without these the client can only
      // guess a channel from the email/phone it happens to have.
      preferredPlatform: { select: { code: true } },
      platformHandles: {
        select: {
          handle: true,
          chatId: true,
          linkedAt: true,
          platform: { select: { code: true } },
        },
      },
    },
  },
};

/**
 * The handful of members shown as avatars on a group row. Kept deliberately
 * thin — the list endpoint returns many groups, and the card only needs
 * initials plus the channel each person prefers.
 */
const MEMBER_PREVIEW_COUNT = 4;

const memberPreviewSelect = {
  contact: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      preferredPlatform: { select: { code: true } },
    },
  },
};

/**
 * Flatten a membership row into the contact-shaped object the client uses.
 * Mirrors `shapeContact` in the contacts service: platform relations become
 * code strings, and a Telegram chat id is reported only as `linked`.
 */
function shapeMember({ addedAt, contact }) {
  const { preferredPlatform, platformHandles, ...rest } = contact;

  return {
    ...rest,
    preferredPlatform: preferredPlatform?.code ?? null,
    ...(platformHandles
      ? {
          platformHandles: platformHandles.map((h) => ({
            platform: h.platform.code,
            handle: h.handle,
            linked: Boolean(h.chatId),
            linkedAt: h.linkedAt ?? null,
          })),
        }
      : {}),
    ...(addedAt ? { addedAt } : {}),
  };
}

function shapeGroup({ _count, members, ...group }) {
  return {
    ...group,
    memberCount: _count.members,
    ...(members ? { members: members.map(shapeMember) } : {}),
  };
}

/** 404 unless the group exists, is live, and belongs to this user. */
async function assertOwned(userId, groupId) {
  const group = await prisma.contactGroup.findFirst({
    where: { id: groupId, userId, deletedAt: null },
    select: { id: true },
  });
  if (!group) {
    throw AppError.notFound('Group not found', { code: 'GROUP_NOT_FOUND' });
  }
  return group;
}

/**
 * Narrow a list of contact ids to the ones this user actually owns.
 * @returns {Promise<{ valid: number[], invalid: number[] }>}
 */
async function partitionOwnedContacts(userId, contactIds) {
  const unique = [...new Set(contactIds)];

  const owned = await prisma.contact.findMany({
    where: { id: { in: unique }, userId, deletedAt: null },
    select: { id: true },
  });

  const validSet = new Set(owned.map((c) => c.id));
  return {
    valid: unique.filter((id) => validSet.has(id)),
    invalid: unique.filter((id) => !validSet.has(id)),
  };
}

/** Reject a second live group with the same name (case-insensitive). */
async function assertNameAvailable(userId, name, exceptId = null) {
  const clash = await prisma.contactGroup.findFirst({
    where: {
      userId,
      deletedAt: null,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });

  if (clash) {
    throw AppError.conflict(`You already have a group named "${name}"`, {
      code: 'GROUP_NAME_TAKEN',
    });
  }
}

// ---- reads ----------------------------------------------------------

export async function listGroups(userId, query) {
  const { search, sort, sortBy } = query;

  const where = {
    userId,
    deletedAt: null,
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [total, groups] = await prisma.$transaction([
    prisma.contactGroup.count({ where }),
    prisma.contactGroup.findMany({
      where,
      select: {
        ...groupSelect,
        // Avatar preview only — `memberCount` remains the real total.
        members: {
          where: { contact: { deletedAt: null } },
          select: memberPreviewSelect,
          orderBy: { addedAt: 'asc' },
          take: MEMBER_PREVIEW_COUNT,
        },
      },
      orderBy: { [sortBy]: sort },
      ...toSkipTake(query),
    }),
  ]);

  return { data: groups.map(shapeGroup), pagination: paginationMeta(query, total) };
}

/** One group, including its members. */
export async function getGroup(userId, groupId) {
  const group = await prisma.contactGroup.findFirst({
    where: { id: groupId, userId, deletedAt: null },
    select: {
      ...groupSelect,
      members: {
        // A soft-deleted contact stays in delivery history but is not a member.
        where: { contact: { deletedAt: null } },
        select: memberSelect,
        orderBy: { addedAt: 'asc' },
      },
    },
  });

  if (!group) {
    throw AppError.notFound('Group not found', { code: 'GROUP_NOT_FOUND' });
  }

  return shapeGroup(group);
}

// ---- writes ---------------------------------------------------------

export async function createGroup(userId, { name, description, contactIds }) {
  await assertNameAvailable(userId, name);

  const { valid, invalid } = contactIds?.length
    ? await partitionOwnedContacts(userId, contactIds)
    : { valid: [], invalid: [] };

  const group = await prisma.contactGroup.create({
    data: {
      userId,
      name,
      description: description ?? null,
      ...(valid.length ? { members: { create: valid.map((contactId) => ({ contactId })) } } : {}),
    },
    select: groupSelect,
  });

  return { ...shapeGroup(group), ...(invalid.length ? { ignoredContactIds: invalid } : {}) };
}

export async function updateGroup(userId, groupId, input) {
  await assertOwned(userId, groupId);
  if (input.name !== undefined) await assertNameAvailable(userId, input.name, groupId);

  const data = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description ?? null;

  const group = await prisma.contactGroup.update({
    where: { id: groupId },
    data,
    select: groupSelect,
  });

  return shapeGroup(group);
}

/** Soft-delete the group and drop its memberships. */
export async function deleteGroup(userId, groupId) {
  await assertOwned(userId, groupId);

  await prisma.$transaction([
    prisma.contactGroup.update({ where: { id: groupId }, data: { deletedAt: new Date() } }),
    prisma.contactGroupMember.deleteMany({ where: { groupId } }),
  ]);

  return { id: groupId, deleted: true };
}

// ---- membership -----------------------------------------------------

/**
 * Add contacts to a group. Ids that aren't the caller's live contacts are
 * reported back rather than silently dropped; contacts already in the
 * group are counted separately (adding twice is not an error).
 */
export async function addMembers(userId, groupId, contactIds) {
  await assertOwned(userId, groupId);

  const { valid, invalid } = await partitionOwnedContacts(userId, contactIds);

  if (!valid.length) {
    throw AppError.badRequest('None of those contact ids belong to you', {
      code: 'NO_VALID_CONTACTS',
      details: { invalidContactIds: invalid },
    });
  }

  // Composite PK (contact_id, group_id) makes this idempotent.
  const { count } = await prisma.contactGroupMember.createMany({
    data: valid.map((contactId) => ({ contactId, groupId })),
    skipDuplicates: true,
  });

  const memberCount = await prisma.contactGroupMember.count({ where: { groupId } });

  return {
    added: count,
    alreadyMembers: valid.length - count,
    invalidContactIds: invalid,
    memberCount,
  };
}

export async function removeMember(userId, groupId, contactId) {
  await assertOwned(userId, groupId);

  const { count } = await prisma.contactGroupMember.deleteMany({ where: { groupId, contactId } });
  if (!count) {
    throw AppError.notFound('That contact is not a member of this group', {
      code: 'MEMBER_NOT_FOUND',
    });
  }

  const memberCount = await prisma.contactGroupMember.count({ where: { groupId } });
  return { groupId, contactId, removed: true, memberCount };
}
