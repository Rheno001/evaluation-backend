// vitest.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run all test files sequentially so DB state doesn't bleed between files
    pool: 'forks',
    poolOptions: {
      forks: { maxForks: 1, minForks: 1 },
    },
    // 30 s timeout per test — Neon round-trips can be slow on cold start
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
