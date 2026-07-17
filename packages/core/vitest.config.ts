import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**'],
    // Default (5000ms) is too tight on Windows CI runners for tests that run
    // full orchestrator pipelines with real file I/O, or that include an
    // intentional retry delay (e.g. the plan same-provider retry) — both
    // comfortably finish well under this on Linux/macOS but occasionally
    // time out on Windows's slower filesystem/process overhead.
    testTimeout: 15000,
    // Even at 15s, Windows CI runners occasionally blow the budget under
    // contention (shared/un-pinned hardware) rather than due to a real
    // regression. Retry once in CI to absorb that timing noise without
    // masking genuine, reproducible failures (retry stays 0 locally).
    retry: process.env.CI ? 1 : 0,
  },
});
