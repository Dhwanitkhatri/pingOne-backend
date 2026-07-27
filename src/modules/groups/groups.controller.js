// ============================================================
// Contact group controllers — HTTP <-> service translation.
// req.user is guaranteed by the `authenticate` middleware on these routes.
// ============================================================

import * as groupsService from './groups.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
  const { data, pagination } = await groupsService.listGroups(req.user.id, req.query);
  res.status(200).json({ data, pagination });
});

export const getOne = asyncHandler(async (req, res) => {
  const group = await groupsService.getGroup(req.user.id, req.params.id);
  res.status(200).json({ data: group });
});

export const create = asyncHandler(async (req, res) => {
  const group = await groupsService.createGroup(req.user.id, req.body);
  res.status(201).json({ message: 'Group created', data: group });
});

export const update = asyncHandler(async (req, res) => {
  const group = await groupsService.updateGroup(req.user.id, req.params.id, req.body);
  res.status(200).json({ message: 'Group updated', data: group });
});

export const remove = asyncHandler(async (req, res) => {
  const result = await groupsService.deleteGroup(req.user.id, req.params.id);
  res.status(200).json({ message: 'Group deleted', ...result });
});

export const addMembers = asyncHandler(async (req, res) => {
  const result = await groupsService.addMembers(req.user.id, req.params.id, req.body.contactIds);
  res.status(200).json({ message: `${result.added} contact(s) added to the group`, ...result });
});

export const removeMember = asyncHandler(async (req, res) => {
  const result = await groupsService.removeMember(
    req.user.id,
    req.params.id,
    req.params.contactId
  );
  res.status(200).json({ message: 'Contact removed from the group', ...result });
});
