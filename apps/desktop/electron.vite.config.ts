import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // Bundle @healix/core into the main process (it's ESM); externalize the rest.
    plugins: [externalizeDepsPlugin({ exclude: ['@healix/core'] })],
    build: {
      rollupOptions: {
        // @healix/core is bundled, which would otherwise pull its heavy native
        // deps into the bundle — playwright then breaks on its runtime dynamic
        // require of chromium-bidi. Keep these external (resolved from
        // node_modules at runtime); they are listed as desktop dependencies.
        // The @babel/* packages are also kept external: they're transitive
        // deps of @healix/core (not desktop's own package.json), so
        // externalizeDepsPlugin doesn't catch them, and bundling their
        // circular-require ("hasRequired...") CJS internals breaks at
        // runtime (Object.defineProperty called on non-object).
        external: [
          'playwright',
          'playwright-core',
          'chromium-bidi',
          'archiver',
          '@babel/parser',
          '@babel/traverse',
          '@babel/types',
          '@babel/generator',
        ],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: { '@': resolve('src/renderer/src') },
    },
  },
});
