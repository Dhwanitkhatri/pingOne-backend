// ============================================================
//   POST   /schedule       create (one-time or recurring)
//   PUT    /schedule/:id   update time/recurrence/recipients (before it fires)
//   DELETE /schedule/:id   cancel (only if it hasn't started sending)
//   GET    /schedule       list mine
//   GET    /schedule/:id   get one
// ============================================================

import { Router } from 'express';
import * as controller from './scheduler.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { createScheduleSchema, updateScheduleSchema } from './scheduler.schema.js';

const router = Router();

router.use(authenticate);

router.get('/', controller.list);
router.get('/:id', controller.get);
router.post('/', validate({ body: createScheduleSchema }), controller.create);
router.put('/:id', validate({ body: updateScheduleSchema }), controller.update);
router.delete('/:id', controller.remove);

export default router;
