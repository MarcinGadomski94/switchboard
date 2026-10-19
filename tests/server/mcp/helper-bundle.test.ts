import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HELPER_MANIFEST, HELPER_NODE_ARGS, fileSha256, freshHelperBundle } from '../../../src/server/mcp/helper-bundle.ts';
import { buildHelperBundles } from '../../../tools/release/helper-bundle.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../helpers/net.ts';

const run = promisify(execFile);

/**
 * 1.24 perf (`docs/performance.md` → *The MCP helper's footprint*): the prebuilt helpers in
 * `dist/hook` run only while their manifest matches the sources, and a running helper stays small.
 */
describe('helper bundles', () => {
  let out: string;

  beforeAll(async () => {
    out = await makeTempDir('helper-bundle');
    await buildHelperBundles(REPO_ROOT, () => undefined, path.join(out, 'hook'));
  }, 60_000);

  afterAll(async () => {
    await removeTempDir(out);
  });

  it('a fresh build is used; a manifest naming a changed source, another lock or another format is not', async () => {
    expect(await freshHelperBundle('sb-mcp', REPO_ROOT, path.join(out, 'hook'))).toBe(path.join(out, 'hook', 'sb-mcp.js'));
    expect(await freshHelperBundle('sb-access-mcp', REPO_ROOT, path.join(out, 'hook'))).toBe(path.join(out, 'hook', 'sb-access-mcp.js'));

    // A root of its own: one source, a lock and a bundle.
    const root = path.join(out, 'root');
    const dir = path.join(root, 'dist', 'hook');
    await mkdir(path.join(root, 'src', 'hook'), { recursive: true });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(root, 'src', 'hook', 'sb-mcp.ts'), 'export {};\n');
    await writeFile(path.join(root, 'package-lock.json'), '{}\n');
    await writeFile(path.join(dir, 'sb-mcp.js'), 'export {};\n');
    const manifest = (patch: Record<string, unknown> = {}) =>
      writeFile(
        path.join(dir, HELPER_MANIFEST),
        JSON.stringify({ format: 1, lock: '', helpers: { 'sb-mcp': { file: 'sb-mcp.js', sources: { 'src/hook/sb-mcp.ts': '' } } }, ...patch }),
      );
    const source = await fileSha256(path.join(root, 'src', 'hook', 'sb-mcp.ts'));
    const lock = await fileSha256(path.join(root, 'package-lock.json'));
    await manifest({ lock, helpers: { 'sb-mcp': { file: 'sb-mcp.js', sources: { 'src/hook/sb-mcp.ts': source } } } });
    expect(await freshHelperBundle('sb-mcp', root)).toBe(path.join(dir, 'sb-mcp.js'));
    expect(await freshHelperBundle('sb-access-mcp', root)).toBeNull();
    await writeFile(path.join(root, 'src', 'hook', 'sb-mcp.ts'), 'export const edited = 1;\n');
    expect(await freshHelperBundle('sb-mcp', root)).toBeNull();
    await manifest({ lock, helpers: { 'sb-mcp': { file: 'sb-mcp.js', sources: { 'src/hook/sb-mcp.ts': await fileSha256(path.join(root, 'src', 'hook', 'sb-mcp.ts')) } } } });
    expect(await freshHelperBundle('sb-mcp', root)).toBe(path.join(dir, 'sb-mcp.js'));
    await manifest({ lock: 'other', helpers: { 'sb-mcp': { file: 'sb-mcp.js', sources: {} } } });
    expect(await freshHelperBundle('sb-mcp', root)).toBeNull();
    await manifest({ format: 2, lock, helpers: { 'sb-mcp': { file: 'sb-mcp.js', sources: {} } } });
    expect(await freshHelperBundle('sb-mcp', root)).toBeNull();
    await manifest({ lock, helpers: { 'sb-mcp': { file: '../sb-mcp.js', sources: {} } } });
    expect(await freshHelperBundle('sb-mcp', root)).toBeNull();
    await writeFile(path.join(dir, HELPER_MANIFEST), 'not json');
    expect(await freshHelperBundle('sb-mcp', root)).toBeNull();
  });

  // The resident size of a running helper (ps: macOS / Linux). 1.24.1 ran the source: ≈125 MB on macOS.
  it.skipIf(process.platform === 'win32')('a running bundled helper stays well under the source one', async () => {
    const rss = async (args: readonly string[]): Promise<number> => {
      // Port 9 (discard): its probes fail at once; the helper serves its base tools and waits on stdin.
      const child = spawn(process.execPath, [...args, '--switchboard-mcp', '9', 'rss-check'], { env: { PATH: process.env['PATH'] ?? '', SWITCHBOARD_TODO_TOKEN: 'x' }, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
      try {
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        const deadline = Date.now() + 20_000;
        while (!out.includes('"id":2') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
        expect(out).toContain('todo_list');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(child.pid)]);
        return Number(stdout.trim()) / 1024;
      } finally {
        child.kill('SIGKILL');
      }
    };
    const source = await rss([path.join(REPO_ROOT, 'src', 'hook', 'sb-mcp.ts')]);
    const bundle = await rss([...HELPER_NODE_ARGS, path.join(out, 'hook', 'sb-mcp.js')]);
    // Measured on Apple silicon, Node 24: ≈125 MB → ≈69 MB.
    expect(bundle).toBeLessThan(source - 30);
    expect(bundle).toBeLessThan(90);
  }, 60_000);
});
