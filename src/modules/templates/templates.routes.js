// ============================================================
//   GET    /templates          list my templates
//   POST   /templates          create
//   PUT    /templates/:id      update
//   DELETE /templates/:id      soft-delete
//   POST   /templates/:id/render   -> { rendered: "Hello Jiken" }
//   POST   /templates/:id/preview  -> { preview: { telegram, gmail, sms, whatsapp } }
// ============================================================

import { Router } from 'express';
import * as controller from './templates.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { createTemplateSchema, updateTemplateSchema, renderTemplateSchema } from './templates.schema.js';

const router = Router();

router.use(authenticate);

router.get('/', controller.list);
router.post('/', validate({ body: createTemplateSchema }), controller.create);
router.put('/:id', validate({ body: updateTemplateSchema }), controller.update);
router.delete('/:id', controller.remove);
router.post('/:id/render', validate({ body: renderTemplateSchema }), controller.render);
router.post('/:id/preview', validate({ body: renderTemplateSchema }), controller.preview);

export default router;
