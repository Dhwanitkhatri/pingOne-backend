// ============================================================
// API router — mounts every feature module under the versioned prefix.
// ============================================================

import { Router } from 'express';

import healthRoutes from '../modules/health/health.routes.js';
import authRoutes from '../modules/auth/auth.routes.js';

import oauthRoutes from '../modules/platforms/oauth.routes.js';
import platformRoutes from '../modules/platforms/platforms.routes.js';

import contactRoutes from '../modules/contacts/contacts.routes.js';
import groupRoutes from '../modules/groups/groups.routes.js';
import userRoutes from '../modules/users/users.routes.js';
import notificationRoutes from '../modules/notifications/notifications.routes.js';

import messageRoutes from '../modules/messages/messages.routes.js';
import schedulerRoutes from '../modules/scheduler/scheduler.routes.js';
import templateRoutes from '../modules/templates/templates.routes.js';

import analyticsRoutes from '../modules/analytics/analytics.routes.js';
import webhookRoutes from '../modules/webhooks/webhooks.routes.js';
import aiRoutes from '../modules/ai/ai.routes.js';

const router = Router();

router.use('/health', healthRoutes);

// Local authentication
router.use('/auth', authRoutes);

// OAuth authentication
router.use('/auth', oauthRoutes);

// Platform credentials
router.use('/platforms', platformRoutes);

// Legacy alias
router.use('/credentials', platformRoutes);

router.use('/contacts', contactRoutes);
router.use('/groups', groupRoutes);
router.use('/users', userRoutes);
router.use('/notifications', notificationRoutes);
router.use('/messages', messageRoutes);
router.use('/scheduler', schedulerRoutes);
router.use('/templates', templateRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/ai', aiRoutes);

// PUBLIC — no authenticate middleware. Meta and Telegram call these and have no
// PingOne session; each request is authenticated by HMAC signature / shared
// secret inside the router instead. See webhooks/signature.js.
router.use('/webhooks', webhookRoutes);

export default router;
