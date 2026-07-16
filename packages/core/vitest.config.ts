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
  },
});
