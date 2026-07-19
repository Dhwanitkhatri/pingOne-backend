// ============================================================
// API router — mounts every feature module under the versioned prefix.
// New modules (contacts, templates, messages, scheduling, …) get added
// here as the project grows.
// ============================================================

import { Router } from 'express';
import healthRoutes from '../modules/health/health.routes.js';
import authRoutes from '../modules/auth/auth.routes.js';
import credentialsRoutes from '../modules/credentials/credentials.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/credentials', credentialsRoutes);

export default router;
