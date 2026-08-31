import type { Server } from 'node:http';
import { env } from './config/env.js';
import { closePool, pool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createApp } from './http/app.js';
import { createWorker, type Worker } from './jobs/worker.js';
import { logger } from './lib/logger.js';
import { widgetAsset } from './services/widget-asset.service.js';
import { mailer } from './services/mailer.js';

// Migrating at boot is what makes `docker compose up` a single command on a
// clean machine; the runner's advisory lock makes concurrent starts safe.
const start = async (): Promise<void> => {
  await pool.query('SELECT 1');
  const { applied } = await runMigrations();
  if (applied.length > 0) logger.info({ applied }, 'database migrated');

  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        baseUrl: env.PUBLIC_BASE_URL,
        widgetVersion: widgetAsset.version,
        geoProviders: env.GEO_PROVIDERS,
        emailTransport: mailer.kind,
      },
      'widget platform listening',
    );
  });

  let worker: Worker | null = null;
  if (env.RUN_WORKER_IN_PROCESS) {
    worker = createWorker();
    worker.start();
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    // Stop accepting connections before draining, or in-flight requests die.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await worker?.stop();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection leaves the process in an unknown state: log it and
  // let the orchestrator start a clean one.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
};

start().catch((error) => {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
