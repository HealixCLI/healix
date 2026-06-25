import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // Bundle @healix/core into the main process (it's ESM); externalize the rest.
    plugins: [externalizeDepsPlugin({ exclude: ['@healix/core'] })],
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
