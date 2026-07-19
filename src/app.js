// ============================================================
// Express application assembly.
// Order matters: security & parsing middleware first, then routes,
// then the 404 handler, then the central error handler LAST.
// The app is exported without calling listen() so it can be reused
// by tests and started from server.js.
// ============================================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { env, isDev } from './config/env.js';
import apiRoutes from './api/routes.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';

const app = express();

// Behind a reverse proxy (nginx, Render, etc.) so rate-limit & IPs work.
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// CORS — only allow the configured frontend origins
app.use(
  cors({
    origin: env.CORS_ORIGINS,
    credentials: true,
  })
);

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
if (isDev) {
  // 🔧 DEV-ONLY verbose logger: request-as-curl + user id + response + timing.
  // Remove this single line for production (it also no-ops when NODE_ENV=production).
  app.use(requestLogger);
} else {
  app.use(morgan('combined'));
}

// Friendly root
app.get('/', (req, res) => {
  res.json({ name: 'PingOne API', version: '0.1.0', docs: `${env.API_PREFIX}/health` });
});

// Feature routes under the versioned prefix
app.use(env.API_PREFIX, apiRoutes);

// 404 + error handling (must be last)
app.use(notFound);
app.use(errorHandler);

export default app;
