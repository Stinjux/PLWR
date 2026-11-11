import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: path.resolve(root, '../dist'), emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
