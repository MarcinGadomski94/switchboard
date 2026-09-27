import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Folders no tool may scan or watch (parallel lane worktrees live under `.worktrees/`). */
const IGNORED = ['**/.worktrees/**', '**/.spike/**', '**/dist/**', '**/node_modules/**'];

/**
 * Vite builds the React UI from `src/web` into `dist/web`, which the Fastify
 * server serves (`npm start`). The app flow has no Vite dev server:
 * `npm run dev` rebuilds on change (tools/dev.ts), so the page, the Host/Origin
 * guard and the `sb_token` cookie behave exactly as in production.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  base: '/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    // tools/dev.ts turns watching on; the exclusions apply whenever it is on.
    watch: process.env['SWITCHBOARD_VITE_WATCH'] === '1' ? { exclude: IGNORED } : null,
  },
  server: {
    host: '127.0.0.1',
    watch: { ignored: IGNORED },
  },
  optimizeDeps: {
    entries: ['index.html'],
  },
});
