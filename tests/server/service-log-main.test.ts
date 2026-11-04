import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, freeTestPorts, makeTempDir, rawRequest, removeTempDir } from '../helpers/net.ts';
import { testServerEnv } from '../helpers/server-process.ts';
import { SERVER_DETACHED, stopTrackedServer, trackServer } from '../helpers/server-registry.ts';
import { SERVICE_LOG_MAX_BYTES } from '../../src/server/service-log.ts';

let tmp: string;
let pid: number | undefined;

beforeEach(async () => {
  tmp = await makeTempDir('service-log');
});
afterEach(async () => {
  if (pid !== undefined) await stopTrackedServer(pid);
  pid = undefined;
  await removeTempDir(tmp);
});

describe('the service log under launchd (stdout + stderr appended to <dataDir>/logs/service.log)', () => {
  it('trims an oversized log at start, keeps writing to it, and logs no routine requests', async () => {
    const dataDir = path.join(tmp, 'data');
    const logs = path.join(dataDir, 'logs');
    const log = path.join(logs, 'service.log');
    await mkdir(logs, { recursive: true });
    // Over the cap, like the 1.85 GB one: 60 MiB of old lines, the newest one marked.
    const old = 'old line of a previous run .......................................\n';
    const count = Math.ceil((60 * 1024 * 1024) / old.length);
    await writeFile(log, `${old.repeat(count)}newest old line\n`);
    const port = (await freeTestPorts())[0] as number;
    // What launchd does: the file opened for appending as the service's stdout and stderr.
    const fd = openSync(log, 'a');
    const child = spawn(process.execPath, [path.join('src', 'server', 'main.ts')], {
      cwd: REPO_ROOT,
      env: testServerEnv({ SWITCHBOARD_DATA_DIR: dataDir, SWITCHBOARD_PORT: String(port) }),
      shell: false,
      stdio: ['ignore', fd, fd],
      detached: SERVER_DETACHED,
    });
    const closed = new Promise<number | null>((resolve) => {
      child.once('close', (code) => resolve(code));
      child.once('error', () => resolve(null));
    });
    trackServer(child, dataDir, REPO_ROOT, closed);
    pid = child.pid;
    closeSync(fd);

    const listening = `Server listening at http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    let text = '';
    while (Date.now() < deadline) {
      text = (await stat(log)).size < 1024 * 1024 ? await readFile(log, 'utf8') : '';
      if (text.includes('service log rotated')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(text).toContain('service log rotated');
    expect(text).not.toContain('old line of a previous run');
    const kept = await readFile(`${log}.1`, 'utf8');
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(SERVICE_LOG_MAX_BYTES / 2);
    expect(Buffer.byteLength(kept)).toBeGreaterThan(SERVICE_LOG_MAX_BYTES / 2 - old.length);
    expect(kept.startsWith(old)).toBe(true);
    // The newest old lines are kept (followed by whatever this start printed before the check).
    expect(kept).toContain('newest old line\n');
    expect(kept).toContain(listening);

    // The server keeps writing into the trimmed file; a routine request adds no line.
    const host = `127.0.0.1:${port}`;
    expect((await rawRequest({ port, path: '/', headers: { host, 'sec-fetch-site': 'none' } })).status).toBe(200);
    expect(await stopTrackedServer(child.pid as number)).toBe(0);
    pid = undefined;
    const after = await readFile(log, 'utf8');
    expect(after).toContain('shutting down');
    expect(after).not.toContain('incoming request');
    expect(after).not.toContain('request completed');
    expect(after).not.toContain('\u0000');
  }, 60_000);
});
