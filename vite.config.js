import {defineConfig} from 'vite';
import {resolve} from 'node:path';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        app: resolve(import.meta.dirname, 'index.html'),
      },
    },
  },
});
