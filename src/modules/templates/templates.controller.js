import * as service from './templates.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
  const templates = await service.listTemplates(req.user.id);
  res.status(200).json({ templates });
});

export const create = asyncHandler(async (req, res) => {
  const template = await service.createTemplate(req.user.id, req.body);
  res.status(201).json({ template });
});

export const update = asyncHandler(async (req, res) => {
  const template = await service.updateTemplate(req.user.id, Number(req.params.id), req.body);
  res.status(200).json({ template });
});

export const remove = asyncHandler(async (req, res) => {
  await service.deleteTemplate(req.user.id, Number(req.params.id));
  res.status(204).send();
});

export const render = asyncHandler(async (req, res) => {
  const { rendered } = await service.renderTemplate(req.user.id, Number(req.params.id), req.body.variables);
  res.status(200).json({ rendered });
});

export const preview = asyncHandler(async (req, res) => {
  const preview = await service.previewTemplate(req.user.id, Number(req.params.id), req.body.variables);
  res.status(200).json({ preview });
});
