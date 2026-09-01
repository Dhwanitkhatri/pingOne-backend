// ============================================================
// Templates service. Owns:
//   - CRUD for Template + nested TemplateVariable rows
//   - placeholder rendering ({name} -> "Jiken")
//   - required-variable validation
//   - the multi-platform preview used by the Message Preview API
//
// Rendering happens in TWO passes, because a template's variables don't all
// resolve at the same moment:
//
//   pass 1  renderTemplate()      — the sender picks a template. Every
//           at compose time        `manual` variable is filled from the value
//                                  they typed (or its defaultValue). Every
//                                  `contact` variable is deliberately LEFT
//                                  as a literal {placeholder}, because there
//                                  is no single answer yet — the message is
//                                  going to several people.
//
//   pass 2  personalizeForContact() — the delivery worker, once per
//           at delivery time        MessageDelivery row. Fills the leftover
//                                   `contact` placeholders from that one
//                                   recipient's Contact row.
//
// So Message.content is the half-rendered master copy, and each recipient's
// actual text is derived from it at send time. Nothing else needs to know
// about the split: pass 2 is a no-op on a template with no contact variables.
// ============================================================

import { prisma } from '../../config/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { getAdapter } from '../../platforms/adapter.registry.js';
import { PLATFORM, VARIABLE_SOURCE } from '../../constants/codes.js';
import { resolveContactField } from './contact-fields.js';

// {variableName} — word chars/underscore only, matches the schema's regex.
const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

const isContactVariable = (variable) => variable.source === VARIABLE_SOURCE.CONTACT;

export async function listTemplates(userId) {
  return prisma.template.findMany({
    where: { userId, isActive: true },
    include: { variables: true, platform: { select: { code: true, name: true } } },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function createTemplate(userId, { platformId, title, content, variables }) {
  return prisma.template.create({
    data: {
      userId,
      platformId,
      title,
      content,
      variables: { create: variables },
    },
    include: { variables: true },
  });
}

export async function updateTemplate(userId, templateId, patch) {
  await assertOwnership(userId, templateId);

  const { variables, ...rest } = patch;

  return prisma.$transaction(async (tx) => {
    if (variables) {
      // Simplest correct approach: replace the variable set wholesale.
      await tx.templateVariable.deleteMany({ where: { templateId } });
      await tx.templateVariable.createMany({
        data: variables.map((v) => ({ ...v, templateId })),
      });
    }
    return tx.template.update({
      where: { id: templateId },
      data: rest,
      include: { variables: true },
    });
  });
}

export async function deleteTemplate(userId, templateId) {
  await assertOwnership(userId, templateId);
  // No deletedAt column on Template — soft delete via isActive.
  await prisma.template.update({ where: { id: templateId }, data: { isActive: false } });
}

/**
 * Pass 1 — render the `manual` variables and leave the `contact` ones alone.
 *
 * Throws 400 if any required *manual* variable has no value AND no
 * defaultValue. A required contact variable is not checked here: whether the
 * recipient has a last name on file is not something the sender can answer at
 * this point, so that check belongs to pass 2, per recipient.
 */
export async function renderTemplate(userId, templateId, providedVariables) {
  const template = await getOwnedTemplate(userId, templateId);

  const missing = template.variables
    .filter((v) => v.isRequired && !isContactVariable(v))
    .filter((v) => !(v.variableName in providedVariables) && v.defaultValue == null)
    .map((v) => v.variableName);

  if (missing.length > 0) {
    throw AppError.badRequest('Missing required template variables', {
      code: 'MISSING_TEMPLATE_VARIABLES',
      details: missing,
    });
  }

  const valueByName = new Map(
    template.variables
      .filter((v) => !isContactVariable(v))
      .map((v) => [v.variableName, v.defaultValue ?? ''])
  );
  // A caller can't fill a contact variable by hand — accepting a value for one
  // here would burn the same name into every recipient's copy, which is the
  // exact bug `source` exists to prevent.
  const contactVariableNames = new Set(
    template.variables.filter(isContactVariable).map((v) => v.variableName)
  );
  for (const [key, value] of Object.entries(providedVariables)) {
    if (!contactVariableNames.has(key)) valueByName.set(key, value);
  }

  const rendered = template.content.replace(PLACEHOLDER_RE, (match, name) =>
    valueByName.has(name) ? valueByName.get(name) : match // contact + unknown placeholders survive
  );

  return { rendered, template };
}

/**
 * Pass 2 — fill the `contact` placeholders left behind by pass 1 for one
 * specific recipient. Called once per MessageDelivery by the delivery worker.
 *
 * A missing value (the contact has no last name, no email on file) falls back
 * to the variable's defaultValue. With no default either:
 *   - `isRequired` -> throw, so that ONE delivery fails with a readable
 *     reason instead of the recipient getting "Hi ," or a raw "{name}".
 *   - otherwise    -> empty string, matching how pass 1 treats a manual
 *     variable nobody filled in.
 *
 * @param {string} content   Message.content — the output of pass 1
 * @param {Array<{variableName: string, source: string, contactField: string|null,
 *                defaultValue: string|null, isRequired: boolean}>} variables
 *   the template's variables; may be empty or contain no contact variables,
 *   in which case `content` is returned unchanged
 * @param {object} contact   loaded with CONTACT_VARIABLE_INCLUDE
 * @returns {string}
 */
export function personalizeForContact(content, variables, contact) {
  const contactVariables = (variables ?? []).filter(isContactVariable);
  if (contactVariables.length === 0) return content;

  const byName = new Map(contactVariables.map((v) => [v.variableName, v]));

  return content.replace(PLACEHOLDER_RE, (match, name) => {
    const variable = byName.get(name);
    if (!variable) return match; // manual leftovers and unknown names stay put

    const value = resolveContactField(contact, variable.contactField) ?? variable.defaultValue;
    if (value != null) return value;

    if (variable.isRequired) {
      throw AppError.badRequest(
        `Contact ${contact.id} has no ${variable.contactField} on file, ` +
          `which template variable "{${name}}" requires`,
        { code: 'MISSING_CONTACT_VARIABLE' }
      );
    }
    return '';
  });
}

/**
 * Message Preview API: render once, then run the result through every
 * platform adapter's formatMessage() so the caller sees exactly what
 * each channel will produce — without sending anything.
 */
export async function previewTemplate(userId, templateId, providedVariables) {
  const { rendered } = await renderTemplate(userId, templateId, providedVariables);

  const platforms = Object.values(PLATFORM);
  const preview = {};
  for (const code of platforms) {
    const adapter = getAdapter(code);
    preview[code] = adapter.formatMessage(rendered).formatted;
  }
  return preview;
}

// ---- internal helpers ----------------------------------------------

async function getOwnedTemplate(userId, templateId) {
  const template = await prisma.template.findFirst({
    where: { id: templateId, userId, isActive: true },
    include: { variables: true },
  });
  if (!template) throw AppError.notFound('Template not found');
  return template;
}

async function assertOwnership(userId, templateId) {
  const exists = await prisma.template.findFirst({ where: { id: templateId, userId } });
  if (!exists) throw AppError.notFound('Template not found');
}
