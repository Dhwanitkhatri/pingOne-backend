// ============================================================
// Server entry point. Starts the HTTP server and wires up graceful
// shutdown so in-flight requests finish and the DB pool closes cleanly
// on SIGINT/SIGTERM (Ctrl+C, container stop).
// ============================================================

import app from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';

const server = app.listen(env.PORT, () => {
  console.log(`🚀 PingOne API listening on http://localhost:${env.PORT}`);
  console.log(`   Environment: ${env.NODE_ENV}`);
  console.log(`   Health:      http://localhost:${env.PORT}${env.API_PREFIX}/health`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully…`);
  server.close(async () => {
    await prisma.$disconnect();
    console.log('Closed HTTP server and database connection. Bye.');
    process.exit(0);
  });

  // Force-exit if cleanup hangs
  setTimeout(() => {
    console.error('Could not close in time, forcing exit.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
