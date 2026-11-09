// Static build of the style lab (style.html) so screenshots aren't interrupted by dev-server reloads:
//   npx vite build --config concepts/styles/vite.style.config.ts
import { defineConfig } from 'vite';
import { resolve } from 'path';
export default defineConfig({
  root: resolve(__dirname, '../..'),
  base: './',
  build: { outDir: resolve(__dirname, '../../dist-style'), target: 'es2022', emptyOutDir: true, chunkSizeWarningLimit: 5000,
    rollupOptions: { input: resolve(__dirname, '../../style.html') } },
});
