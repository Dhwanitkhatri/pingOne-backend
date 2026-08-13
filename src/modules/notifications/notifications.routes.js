import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import * as controller from './notifications.controller.js';

const router = Router();
router.use(authenticate);
router.get('/', controller.list);
router.patch('/:id/read', controller.markRead);

export default router;
