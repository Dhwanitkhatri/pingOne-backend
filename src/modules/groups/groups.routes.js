// ============================================================
// Contact group routes (mounted at /api/v1/groups). All protected.
//
//   GET    /groups                       list (paginated, searchable)
//   POST   /groups                       create
//   GET    /groups/:id                   one group, with its members
//   PUT    /groups/:id                   update  (PATCH is accepted too)
//   DELETE /groups/:id                   soft delete
//   POST   /groups/:id/members           add contacts to the group
//   DELETE /groups/:id/members/:contactId remove one contact
// ============================================================

import { Router } from 'express';
import * as controller from './groups.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParamSchema } from '../../utils/validators.js';
import {
  createGroupSchema,
  updateGroupSchema,
  listGroupsQuerySchema,
  addMembersSchema,
  memberParamsSchema,
} from './groups.schema.js';

const router = Router();

router.use(authenticate);

// ---- collection ----
router.get('/', validate({ query: listGroupsQuerySchema }), controller.list);
router.post('/', validate({ body: createGroupSchema }), controller.create);

// ---- membership (declared before /:id so the paths stay unambiguous) ----
router.post(
  '/:id/members',
  validate({ params: idParamSchema, body: addMembersSchema }),
  controller.addMembers
);
router.delete(
  '/:id/members/:contactId',
  validate({ params: memberParamsSchema }),
  controller.removeMember
);

// ---- item ----
router.get('/:id', validate({ params: idParamSchema }), controller.getOne);
router.put('/:id', validate({ params: idParamSchema, body: updateGroupSchema }), controller.update);
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateGroupSchema }),
  controller.update
);
router.delete('/:id', validate({ params: idParamSchema }), controller.remove);

export default router;
