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
        external: ['playwright', 'playwright-core', 'chromium-bidi', 'archiver'],
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
