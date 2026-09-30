import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunResult } from '../../../src/server/exec.ts';
import { ServiceError } from '../../../src/server/service/errors.ts';
import { checkNode, findOnPath } from '../../../src/server/service/node-check.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/** M9.1: "Requires Node ≥ 24 on PATH" (`docs/service.md` → *Node on PATH*). */

function answer(stdout: string, code = 0): RunResult {
  return { code, signal: null, stdout, stderr: code === 0 ? '' : 'boom', error: null, timedOut: false };
}

let tmp: string;

beforeAll(async () => {
  tmp = await makeTempDir('node-check');
  await mkdir(path.join(tmp, 'a'));
  await mkdir(path.join(tmp, 'b'));
  await writeFile(path.join(tmp, 'a', 'node'), 'not executable');
  await writeFile(path.join(tmp, 'b', 'node'), '#!/bin/sh\n');
  await chmod(path.join(tmp, 'b', 'node'), 0o755);
});

afterAll(async () => {
  await removeTempDir(tmp);
});

describe('findOnPath', () => {
  // Real files on disk; the X_OK bit this test depends on does not exist on Windows (PATHEXT decides there, the next test).
  it.runIf(process.platform !== 'win32')('takes the first executable file on PATH, skipping non-executables and relative folders', async () => {
    const env = { PATH: ['relative/bin', path.join(tmp, 'missing'), path.join(tmp, 'a'), path.join(tmp, 'b')].join(':') };
    expect(await findOnPath('node', { env, platform: process.platform })).toBe(path.join(tmp, 'b', 'node'));
    expect(await findOnPath('node', { env: { PATH: path.join(tmp, 'a') }, platform: process.platform })).toBeNull();
    expect(await findOnPath('node', { env: {}, platform: process.platform })).toBeNull();
  });

  it('on Windows tries every PATHEXT extension in order and reads Path case-insensitively', async () => {
    const seen: string[] = [];
    const found = await findOnPath('node', {
      env: { Path: 'C:\\tools;"C:\\Program Files\\nodejs";relative', PATHEXT: '.COM;.EXE;.CMD' },
      platform: 'win32',
      isExecutable: async (file) => {
        seen.push(file);
        return file === 'C:\\Program Files\\nodejs\\node.exe';
      },
    });
    expect(found).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(seen).toEqual(['C:\\tools\\node.com', 'C:\\tools\\node.exe', 'C:\\tools\\node.cmd', 'C:\\Program Files\\nodejs\\node.com', 'C:\\Program Files\\nodejs\\node.exe']);
  });
});

describe('checkNode', () => {
  it('accepts Node 24 and later', async () => {
    // A simulated Linux PATH, so POSIX paths on every host (a Windows temp folder is not absolute for Linux).
    const calls: string[][] = [];
    const node = await checkNode({
      env: { PATH: '/opt/a:/opt/b' },
      platform: 'linux',
      cwd: tmp,
      isExecutable: async (file) => file === '/opt/b/node',
      run: async (command, args) => {
        calls.push([...command, ...args]);
        return answer('v24.0.0\n');
      },
    });
    expect(node).toEqual({ path: '/opt/b/node', version: 'v24.0.0' });
    expect(calls).toEqual([['/opt/b/node', '--version']]);
  });

  it('refuses an older node, no node, and a node that does not answer', async () => {
    const base = { env: { PATH: '/opt/bin' }, platform: 'linux' as const, cwd: '/', isExecutable: async () => true };
    await expect(checkNode({ ...base, run: async () => answer('v22.9.0') })).rejects.toMatchObject({ code: 'node-too-old', message: 'Node.js ≥ 24 is required on PATH; /opt/bin/node is v22.9.0.' });
    await expect(checkNode({ ...base, isExecutable: async () => false, run: async () => answer('v24.0.0') })).rejects.toMatchObject({
      code: 'node-missing',
      message: 'Node.js ≥ 24 must be on PATH: no node was found there.',
    });
    await expect(checkNode({ ...base, run: async () => answer('', 1) })).rejects.toMatchObject({ code: 'node-missing' });
    await expect(checkNode({ ...base, run: async () => answer('hello') })).rejects.toBeInstanceOf(ServiceError);
  });

  it('finds this machine\'s node on the real PATH (a real `node --version`)', async () => {
    const node = await checkNode({ env: process.env, platform: process.platform, cwd: tmp });
    expect(path.isAbsolute(node.path)).toBe(true);
    expect(Number(/^v(\d+)/.exec(node.version)?.[1])).toBeGreaterThanOrEqual(24);
  });
});
