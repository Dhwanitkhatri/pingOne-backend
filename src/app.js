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
import { clientIp } from './middleware/clientIp.js';
import { uploadRoot } from './utils/fileStorage.js';

const app = express();

// Behind a reverse proxy (nginx, Render, etc.) so rate-limit & IPs work.
app.set('trust proxy', 1);

// Render adds more proxy hops than `trust proxy: 1` peels off; this restores
// the visitor's own address from Cloudflare's header. Must run before any
// rate limiter or route reads req.ip.
app.use(clientIp);

// Security headers.
// crossOriginResourcePolicy is relaxed to cross-origin so the frontend (and
// Twilio, fetching MMS media) can load attachment files from /uploads. Helmet's
// default of same-origin would block both.
// crossOriginOpenerPolicy is off because the OAuth popup passes through this
// API's /auth/*/callback redirect. Helmet's default same-origin on that 302
// severs window.opener, so the frontend's /oauth/callback page can't
// postMessage the result back. This API serves no HTML, so it loses nothing.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: false,
  })
);

// CORS — only allow the configured frontend origins
app.use(
  cors({
    origin: env.CORS_ORIGINS,
    credentials: true,
  })
);

// Body parsing.
//nothing just to commit 
// The `verify` hook stashes the unparsed bytes on req.rawBody, which the
// WhatsApp webhook needs: Meta's X-Hub-Signature-256 is an HMAC over exactly
// what it sent, and re-serialising req.body would produce different bytes (key
// order, whitespace) and never match. Only kept for the webhook paths — holding
// a second copy of every request body in memory is pointless overhead elsewhere.
app.use(
  express.json({
    limit: '1mb',
    verify(req, res, buf) {
      if (req.originalUrl.includes('/webhooks/')) req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// Uploaded message attachments.
//
// Content-Disposition: attachment is not cosmetic — it stops a file that
// slipped through as HTML/SVG from executing in this origin's context when
// opened directly. Combined with helmet's nosniff, that closes the stored-XSS
// hole that serving user uploads otherwise opens. It does not affect <img>,
// <video> or Twilio's media fetch.
app.use(
  '/uploads',
  express.static(uploadRoot, {
    index: false,
    dotfiles: 'deny',
    maxAge: '7d',
    setHeaders(res) {
      res.setHeader('Content-Disposition', 'attachment');
    },
  })
);

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
