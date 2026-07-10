import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    exclude: ['**/node_modules/**', '**/out/**', '**/release/**'],
  },
});
