import { spawn } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/net.ts';
import { E2E_WEB_ROOT } from '../helpers/server-process.ts';

/**
 * Builds the UI once before the E2E run, so every spec exercises the current
 * `src/web` rather than a stale build. It builds into `.e2e-dist/web`
 * ({@link E2E_WEB_ROOT}), never `dist/web`: a Switchboard the developer runs from
 * this checkout keeps serving its own build (test servers get
 * `SWITCHBOARD_WEB_ROOT`, tests/helpers/server-process.ts). Uses the project's own
 * Vite with `shell: false`.
 */
export default async function globalSetup(): Promise<void> {
  const vite = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [vite, 'build', '--logLevel', 'warn', '--outDir', E2E_WEB_ROOT, '--emptyOutDir'], { cwd: REPO_ROOT, shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`vite build exited with ${code}`))));
  });
}
