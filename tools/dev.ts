/**
 * `npm run dev`: rebuilds the UI into dist/web on every change (Vite build in
 * watch mode, exclusions from vite.config.ts) and runs the server under
 * `node --watch`, so the page is served exactly as in production (same port,
 * Host/Origin guard and sb_token cookie). Reload the browser after a UI rebuild.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { build } from 'vite';

const repoRoot = path.resolve(import.meta.dirname, '..');
process.env['SWITCHBOARD_VITE_WATCH'] = '1';

const watcher = await build({ configFile: path.join(repoRoot, 'vite.config.ts'), mode: 'development' });

const server = spawn(process.execPath, ['--watch', path.join('src', 'server', 'main.ts')], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: false,
  env: process.env,
});

async function closeWatcher(): Promise<void> {
  if ('close' in watcher && typeof watcher.close === 'function') await watcher.close();
}

const stop = (signal: NodeJS.Signals): void => {
  server.kill(signal);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

server.on('exit', (code) => {
  void closeWatcher().finally(() => process.exit(code ?? 0));
});
