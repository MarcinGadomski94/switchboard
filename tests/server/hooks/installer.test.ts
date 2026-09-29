import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HookCommand } from '../../../src/core/hooks.ts';
import { HookInstallError, hooksState, installHooks, removeHooks } from '../../../src/server/hooks/installer.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/** D48 P4: the hook installer on temp config dirs only (never the real ~/.claude). */

let dir: string;
const COMMAND: HookCommand = { nodePath: '/n/node', scriptPath: '/s/sb-hook.ts', port: 4961, tokenFile: '/d/hook-token', platform: 'darwin', rewake: true };

beforeEach(async () => {
  dir = path.join(await makeTempDir('hook-installer'), 'claude-config');
});
afterEach(async () => {
  await removeTempDir(path.dirname(dir));
});

async function files(): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe('D48 P4 installing hooks', () => {
  it('creates a missing settings file (0600), with no backup', async () => {
    const change = await installHooks(dir, COMMAND, new Date(2026, 8, 29, 12, 0, 0));
    expect(change).toMatchObject({ changed: true, backup: null });
    expect(await files()).toEqual(['settings.json']);
    expect((await stat(path.join(dir, 'settings.json'))).mode & 0o777).toBe(0o600);
    expect((await hooksState(dir, COMMAND)).state).toBe('installed');
  });

  it('backs up first, keeps everything else, is idempotent, and Remove restores the rest', async () => {
    await mkdir(dir, { recursive: true });
    const original = { model: 'sonnet', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, env: { FOO: '1' } };
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify(original, null, 2), { mode: 0o644 });
    const first = await installHooks(dir, COMMAND, new Date(2026, 8, 29, 12, 0, 0));
    expect(first.backup).toBe(path.join(dir, 'settings.json.switchboard-backup-20260929-120000'));
    expect(JSON.parse(await readFile(first.backup as string, 'utf8'))).toEqual(original);
    const installed = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(installed['model']).toBe('sonnet');
    expect(installed['env']).toEqual({ FOO: '1' });
    expect((await stat(path.join(dir, 'settings.json'))).mode & 0o777).toBe(0o644);
    // Again: nothing to do, no second backup.
    expect(await installHooks(dir, COMMAND, new Date(2026, 8, 29, 12, 5, 0))).toMatchObject({ changed: false, backup: null });
    expect(await files()).toEqual(['settings.json', 'settings.json.switchboard-backup-20260929-120000']);
    // A moved port: the entries are outdated and replaced (with a backup).
    expect((await hooksState(dir, { ...COMMAND, port: 4962 })).state).toBe('outdated');
    const removed = await removeHooks(dir, new Date(2026, 8, 29, 12, 10, 0));
    expect(removed.changed).toBe(true);
    expect(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'))).toEqual(original);
    expect(await removeHooks(dir)).toMatchObject({ changed: false, backup: null });
  });

  it('never changes a file that is not a JSON object', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'settings.json'), '{ "model": "opus", // a comment\n}');
    await expect(installHooks(dir, COMMAND)).rejects.toThrow(HookInstallError);
    await expect(removeHooks(dir)).rejects.toThrow(HookInstallError);
    expect(await readFile(path.join(dir, 'settings.json'), 'utf8')).toBe('{ "model": "opus", // a comment\n}');
    expect((await hooksState(dir, COMMAND)).state).toBe('unreadable');
    expect(await files()).toEqual(['settings.json']);
  });
});
