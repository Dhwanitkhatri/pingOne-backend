// ============================================================
// API router — mounts every feature module under the versioned prefix.
// New modules (templates, scheduling, …) get added here as the project
// grows.
// ============================================================

import { Router } from 'express';
import healthRoutes from '../modules/health/health.routes.js';
import authRoutes from '../modules/auth/auth.routes.js';
import oauthRoutes from '../modules/platforms/oauth.routes.js';
import platformRoutes from '../modules/platforms/platforms.routes.js';
import contactRoutes from '../modules/contacts/contacts.routes.js';
import groupRoutes from '../modules/groups/groups.routes.js';
import userRoutes from '../modules/users/users.routes.js';
import messageRoutes from '../modules/messages/messages.routes.js';

const router = Router();

router.use('/health', healthRoutes);

// Two routers share the /auth prefix: local credentials (signup, login,
// tokens) and the provider OAuth flows (/auth/google, /auth/meta).
router.use('/auth', authRoutes);
router.use('/auth', oauthRoutes);

router.use('/platforms', platformRoutes);
// Legacy alias — the platform endpoints originally shipped under /credentials.
router.use('/credentials', platformRoutes);

router.use('/contacts', contactRoutes);
router.use('/groups', groupRoutes);
router.use('/users', userRoutes);
router.use('/messages', messageRoutes);

export default router;
