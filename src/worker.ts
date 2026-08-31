import { closePool } from './db/pool.js';
import { createWorker } from './jobs/worker.js';
import { logger } from './lib/logger.js';

// Standalone entrypoint for running the queue as its own process. Set
// RUN_WORKER_IN_PROCESS=false on the API when using this, or jobs run twice.
const worker = createWorker();
worker.start();

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'worker shutting down');
  await worker.stop();
  await closePool();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
