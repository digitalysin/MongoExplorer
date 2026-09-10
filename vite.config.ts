import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  // Assets are loaded over file:// in the packaged app, so paths must be relative.
  base: './',
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
    chunkSizeWarningLimit: 1500
  }
});
