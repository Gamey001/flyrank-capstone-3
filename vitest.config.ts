import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Every integration test shares one Postgres database and truncates it
    // between files. Running files sequentially is what keeps that honest —
    // parallel files would truncate each other's fixtures mid-test.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Deterministic by default: the suite must not depend on a third party
      // being reachable, or on the machine having a network at all.
      GEO_PROVIDERS: 'mock-a,mock-b',
      SPAM_MIN_FILL_MS: '1200',
      EMAIL_TRANSPORT: 'log',
      RUN_WORKER_IN_PROCESS: 'false',
      // Effectively off for the suite: every test shares one client IP, so the
      // real limits would make unrelated tests fail each other. The dedicated
      // rate-limit test sets its own low limits before importing the app.
      RATE_LIMIT_IP_MAX: '100000',
      RATE_LIMIT_WIDGET_MAX: '100000',
    },
    include: ['test/**/*.test.ts'],
  },
});
