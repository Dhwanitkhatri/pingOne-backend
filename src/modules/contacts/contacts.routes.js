// ============================================================
// Contact routes (mounted at /api/v1/contacts). All protected.
//
//   GET    /contacts                list (paginated, searchable)
//   POST   /contacts                create
//   GET    /contacts/import/google  pull from the connected Gmail account
//   POST   /contacts/import/csv     upload a CSV (multipart field "file")
//   GET    /contacts/:id            one contact
//   PUT    /contacts/:id            update  (PATCH is accepted too)
//   DELETE /contacts/:id            soft delete
//
// The /import/* paths are declared BEFORE /:id so they are never
// swallowed by the id route.
// ============================================================

import { Router } from 'express';
import * as controller from './contacts.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { uploadCsv } from '../../middleware/upload.js';
import { idParamSchema } from '../../utils/validators.js';
import {
  createContactSchema,
  updateContactSchema,
  listContactsQuerySchema,
  csvImportOptionsSchema,
} from './contacts.schema.js';

const router = Router();

router.use(authenticate);

// ---- import (must precede /:id) ----
router.get('/import/google', controller.importFromGoogle);
router.post(
  '/import/csv',
  uploadCsv('file'),
  // Runs after multer, which is what turns the multipart text fields into req.body.
  validate({ body: csvImportOptionsSchema }),
  controller.importFromCsv
);

// ---- collection ----
router.get('/', validate({ query: listContactsQuerySchema }), controller.list);
router.post('/', validate({ body: createContactSchema }), controller.create);

// ---- item ----
router.get('/:id', validate({ params: idParamSchema }), controller.getOne);
router.put(
  '/:id',
  validate({ params: idParamSchema, body: updateContactSchema }),
  controller.update
);
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateContactSchema }),
  controller.update
);
router.delete('/:id', validate({ params: idParamSchema }), controller.remove);

export default router;
