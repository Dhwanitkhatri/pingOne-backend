import * as service from './notifications.service.js';
import { AppError } from '../../utils/AppError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
  const notifications = await service.listNotifications(req.user.id);
  res.status(200).json({ notifications });
});

export const markRead = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw AppError.notFound('Notification not found');
  if (!(await service.markRead(req.user.id, id))) throw AppError.notFound('Notification not found');
  res.status(204).send();
});
