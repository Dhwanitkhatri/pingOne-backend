// ============================================================
// Templates service. Owns:
//   - CRUD for Template + nested TemplateVariable rows
//   - placeholder rendering ({name} -> "Jiken")
//   - required-variable validation
//   - the multi-platform preview used by the Message Preview API
// ============================================================

import { prisma } from '../../config/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { getAdapter } from '../../platforms/adapter.registry.js';
import { PLATFORM } from '../../constants/codes.js';

// {variableName} — word chars/underscore only, matches the schema's regex.
const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

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
 * Render a template's content, substituting {placeholders}.
 * Throws 400 if any `isRequired` variable has no value AND no defaultValue.
 */
export async function renderTemplate(userId, templateId, providedVariables) {
  const template = await getOwnedTemplate(userId, templateId);

  const missing = template.variables
    .filter((v) => v.isRequired)
    .filter((v) => !(v.variableName in providedVariables) && v.defaultValue == null)
    .map((v) => v.variableName);

  if (missing.length > 0) {
    throw AppError.badRequest('Missing required template variables', {
      code: 'MISSING_TEMPLATE_VARIABLES',
      details: missing,
    });
  }

  const valueByName = new Map(template.variables.map((v) => [v.variableName, v.defaultValue ?? '']));
  for (const [key, value] of Object.entries(providedVariables)) {
    valueByName.set(key, value);
  }

  const rendered = template.content.replace(PLACEHOLDER_RE, (match, name) =>
    valueByName.has(name) ? valueByName.get(name) : match // leave unknown placeholders untouched
  );

  return { rendered, template };
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
