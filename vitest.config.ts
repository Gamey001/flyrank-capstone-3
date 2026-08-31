import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // All files share one database and truncate it between tests, so running
    // them in parallel would let one wipe another's fixtures mid-test.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Mocks, so no test depends on a third party or on having a network.
      GEO_PROVIDERS: 'mock-a,mock-b',
      SPAM_MIN_FILL_MS: '1200',
      EMAIL_TRANSPORT: 'log',
      RUN_WORKER_IN_PROCESS: 'false',
      // Effectively off: every test shares one client IP, so real limits would
      // make unrelated tests fail each other. The rate-limit files set their
      // own limits before importing the app.
      RATE_LIMIT_IP_MAX: '100000',
      RATE_LIMIT_WIDGET_MAX: '100000',
    },
    include: ['test/**/*.test.ts'],
  },
});
