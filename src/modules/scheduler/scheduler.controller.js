import * as service from './scheduler.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
  const schedules = await service.listSchedules(req.user.id);
  res.status(200).json({ schedules });
});

export const get = asyncHandler(async (req, res) => {
  const schedule = await service.getSchedule(req.user.id, Number(req.params.id));
  res.status(200).json({ schedule });
});

export const create = asyncHandler(async (req, res) => {
  const schedule = await service.createSchedule(req.user.id, req.body);
  res.status(201).json({ schedule });
});

export const update = asyncHandler(async (req, res) => {
  const schedule = await service.updateSchedule(req.user.id, Number(req.params.id), req.body);
  res.status(200).json({ schedule });
});

export const remove = asyncHandler(async (req, res) => {
  await service.cancelSchedule(req.user.id, Number(req.params.id));
  res.status(204).send();
});
