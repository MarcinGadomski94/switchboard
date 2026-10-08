import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_STANDING_INSTRUCTION, type KnownSettings, SETTING_DEFAULTS, effectiveStandingInstruction, readKnownSettings } from '../../../src/core/settings.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { routerTitle, standingInstructionFor, validateSettingsPatch } from '../../../src/server/settings/settings.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

const PORT = 4875; // inject() opens no socket; the port feeds the Host check and service.address only
const HOST = `127.0.0.1:${PORT}`;

let tmp: string | undefined;
let store: Store | undefined;
let app: FastifyInstance | undefined;
let token = '';

async function setup(options: { workspace?: 'router' | 'plain' | 'none' | 'missing' } = {}): Promise<{ dir: string; workspace: string | null }> {
  tmp = await makeTempDir('api-settings');
  const dir = tmp;
  let workspace: string | null = null;
  if (options.workspace !== 'none') {
    workspace = path.join(dir, 'work space');
    if (options.workspace !== 'missing') await mkdir(workspace, { recursive: true });
    if (options.workspace === 'router' || options.workspace === undefined) {
      await writeFile(path.join(workspace, 'AGENTS.md'), '# AGENTS.md (Workspace Router)\n\nThis is a multi-solution workspace.\n');
    }
  }
  await open(dir, workspace);
  return { dir, workspace };
}

async function open(dir: string, workspace: string | null): Promise<void> {
  store = await openTempStore(path.join(dir, 'data'));
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: path.join(dir, 'data') }, platform: 'linux', home: dir, cwd: dir });
  // D14: `workspace.root` / `workspace.router` report the default saved folder.
  if (workspace) await seedFolder(store, workspace);
  app = await buildApp({ config: { ...base, port: PORT }, token, store, webRoot: dir });
  await app.ready();
}

async function close(): Promise<void> {
  await app?.close();
  await store?.close();
  app = undefined;
  store = undefined;
}

afterEach(async () => {
  await close();
  if (tmp) await removeTempDir(tmp);
  tmp = undefined;
});

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

describe('GET/PUT /api/settings (M8.2)', () => {
  it('a fresh install answers the defaults plus what the service reports about itself', async () => {
    const { workspace } = await setup();
    const response = await call('GET', '/api/settings');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual<KnownSettings>({
      'sessions.worktrees': true,
      'sessions.ultracode': false,
      'sessions.todoReminder': true,
      'sessions.reviewCards': true,
      'sessions.checkpoints': true,
      'usage.warnAtPct': 90,
      'ui.sidebarHidden': false,
      'ui.rightPanelHidden': false,
      'newSession.mode': 'simple',
      'agents.standingInstruction': DEFAULT_STANDING_INSTRUCTION,
      'agents.standingInstruction.enabled': true,
      'service.startAtLogin': false,
      'service.address': `127.0.0.1:${PORT}`,
      'workspace.root': workspace,
      'workspace.router': 'AGENTS.md (Workspace Router)',
      'github.prPollMinutes': 5,
    });
    // Nothing is stored until something is set (docs/database.md).
    expect(await store!.settings.getAll()).toEqual({});
  });

  it('PUT stores a subset of the editable keys and answers the whole object; the values survive a restart', async () => {
    const { dir, workspace } = await setup();
    const put = await call('PUT', '/api/settings', { 'sessions.ultracode': true, 'usage.warnAtPct': 75 });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ 'sessions.worktrees': true, 'sessions.ultracode': true, 'usage.warnAtPct': 75, 'workspace.root': workspace });
    const second = await call('PUT', '/api/settings', { 'sessions.worktrees': false });
    expect(second.json()).toMatchObject({ 'sessions.worktrees': false, 'sessions.ultracode': true, 'usage.warnAtPct': 75 });

    // A new process on the same database (SQLite, the `settings` table).
    await close();
    await open(dir, workspace);
    expect((await call('GET', '/api/settings')).json()).toMatchObject({
      'sessions.worktrees': false,
      'sessions.ultracode': true,
      'usage.warnAtPct': 75,
    });
    expect(await store!.settings.getAll()).toEqual({ 'sessions.worktrees': false, 'sessions.ultracode': true, 'usage.warnAtPct': 75 });
  });

  it('PUT refuses read-only and unknown keys and wrong values with 422; nothing changes', async () => {
    await setup();
    const cases: Array<[unknown, string[]]> = [
      [{ 'service.address': '0.0.0.0:80' }, ['service.address']],
      [{ 'workspace.root': '/tmp' }, ['workspace.root']],
      [{ 'service.startAtLogin': true }, ['service.startAtLogin']],
      [{ 'github.prPollMinutes': 1 }, ['github.prPollMinutes']],
      [{ theme: 'light' }, ['theme']],
      [{ 'sessions.worktrees': 'yes' }, ['sessions.worktrees']],
      [{ 'sessions.ultracode': 1 }, ['sessions.ultracode']],
      [{ 'usage.warnAtPct': 0 }, ['usage.warnAtPct']],
      [{ 'usage.warnAtPct': 101 }, ['usage.warnAtPct']],
      [{ 'usage.warnAtPct': 90.5 }, ['usage.warnAtPct']],
      [{ 'usage.warnAtPct': '90' }, ['usage.warnAtPct']],
      [{ 'sessions.ultracode': true, 'workspace.router': 'x' }, ['workspace.router']],
      [[], ['']],
      ['on', ['']],
      [null, ['']],
    ];
    for (const [body, fields] of cases) {
      const response = await call('PUT', '/api/settings', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
      const json = response.json() as { error: string; errors: Array<{ field: string; message: string }> };
      expect(json.error).toBe('invalid');
      expect(json.errors.map((e) => e.field), JSON.stringify(body)).toEqual(fields);
    }
    expect(await store!.settings.getAll()).toEqual({});
    expect((await call('GET', '/api/settings')).json()).toMatchObject(SETTING_DEFAULTS);
  });

  it('PUT with an empty object stores nothing and answers the current settings', async () => {
    await setup();
    const response = await call('PUT', '/api/settings', {});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(SETTING_DEFAULTS);
    expect(await store!.settings.getAll()).toEqual({});
  });

  it('reports the workspace root and router as they are: none, missing folder, no AGENTS.md, no heading', async () => {
    await setup({ workspace: 'none' });
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'workspace.root': null, 'workspace.router': null });
    await close();
    await removeTempDir(tmp!);

    const missing = await setup({ workspace: 'missing' });
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'workspace.root': missing.workspace, 'workspace.router': null });
    await close();
    await removeTempDir(tmp!);

    const plain = await setup({ workspace: 'plain' });
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'workspace.root': plain.workspace, 'workspace.router': null });
    await writeFile(path.join(plain.workspace!, 'AGENTS.md'), 'no heading here\n## only a second-level one\n');
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'workspace.router': 'AGENTS.md' });

    // D14: a repo as the default folder has no router, whatever AGENTS.md it holds.
    const repo = path.join(tmp!, 'repo');
    await mkdir(path.join(repo, '.git'), { recursive: true });
    await writeFile(path.join(repo, 'AGENTS.md'), '# Repo rules\n');
    await seedFolder(store!, repo, { kind: 'repo', isDefault: true });
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'workspace.root': repo, 'workspace.router': null });
  });

  it('keeps a stored start-at-login value (M9.1 writes it) and ignores stored values of the wrong type', async () => {
    await setup();
    await store!.settings.setMany({ 'service.startAtLogin': true, 'usage.warnAtPct': 'ninety', 'sessions.worktrees': null });
    expect((await call('GET', '/api/settings')).json()).toMatchObject({
      'service.startAtLogin': true,
      'usage.warnAtPct': 90,
      'sessions.worktrees': true,
    });
  });

  it('D41: stores which panes are hidden (sidebar, right panel); the choice survives a restart and a mistyped value is refused', async () => {
    const { dir, workspace } = await setup();
    const hide = await call('PUT', '/api/settings', { 'ui.sidebarHidden': true });
    expect(hide.statusCode).toBe(200);
    expect(hide.json()).toMatchObject({ 'ui.sidebarHidden': true, 'ui.rightPanelHidden': false, 'sessions.worktrees': true });
    const panel = await call('PUT', '/api/settings', { 'ui.rightPanelHidden': true });
    expect(panel.json()).toMatchObject({ 'ui.sidebarHidden': true, 'ui.rightPanelHidden': true });

    // A new process on the same database (SQLite, the `settings` table).
    await close();
    await open(dir, workspace);
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'ui.sidebarHidden': true, 'ui.rightPanelHidden': true });
    expect(await store!.settings.getAll()).toEqual({ 'ui.sidebarHidden': true, 'ui.rightPanelHidden': true });

    // Shown again: stored as false, not removed.
    const shown = await call('PUT', '/api/settings', { 'ui.sidebarHidden': false });
    expect(shown.json()).toMatchObject({ 'ui.sidebarHidden': false, 'ui.rightPanelHidden': true });

    for (const body of [{ 'ui.sidebarHidden': 'yes' }, { 'ui.rightPanelHidden': 1 }, { 'ui.rightPanelHidden': null }]) {
      const refused = await call('PUT', '/api/settings', body);
      expect(refused.statusCode, JSON.stringify(body)).toBe(422);
      expect((refused.json() as { errors: Array<{ field: string; message: string }> }).errors).toEqual([
        { field: Object.keys(body)[0], message: `${Object.keys(body)[0]} must be true or false` },
      ]);
    }
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'ui.sidebarHidden': false, 'ui.rightPanelHidden': true });

    // A stored value of the wrong type reads as the default (shown).
    await store!.settings.setMany({ 'ui.rightPanelHidden': 'hidden' });
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'ui.rightPanelHidden': false });
  });

  it('D56: remembers the New-session mode (simple on a fresh install); only "simple" or "full" is taken; a stored oddity reads as simple', async () => {
    const { dir, workspace } = await setup();
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'newSession.mode': 'simple' });
    const full = await call('PUT', '/api/settings', { 'newSession.mode': 'full' });
    expect(full.statusCode).toBe(200);
    expect(full.json()).toMatchObject({ 'newSession.mode': 'full', 'sessions.worktrees': true });
    await close();
    await open(dir, workspace);
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'newSession.mode': 'full' });
    for (const body of [{ 'newSession.mode': 'Simple' }, { 'newSession.mode': true }, { 'newSession.mode': null }]) {
      const refused = await call('PUT', '/api/settings', body);
      expect(refused.statusCode, JSON.stringify(body)).toBe(422);
      expect((refused.json() as { errors: unknown }).errors).toEqual([{ field: 'newSession.mode', message: 'newSession.mode must be "simple" or "full"' }]);
    }
    expect(await store!.settings.getAll()).toEqual({ 'newSession.mode': 'full' });
    await store!.settings.setMany({ 'newSession.mode': 'wizard' });
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'newSession.mode': 'simple' });
  });

  it('stays behind the cookie guard', async () => {
    await setup();
    expect((await app!.inject({ method: 'GET', url: '/api/settings', headers: { host: HOST } })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'PUT', url: '/api/settings', headers: { host: HOST } })).statusCode).toBe(401);
  });
});

describe('settings helpers (M8.2)', () => {
  it('routerTitle reads the first "# " heading (BOM, CRLF, closing hashes)', async () => {
    tmp = await makeTempDir('settings-router');
    await writeFile(path.join(tmp, 'AGENTS.md'), '﻿\r\n# AGENTS.md (Workspace Router) ##\r\nbody\r\n# Later\r\n');
    expect(await routerTitle(tmp)).toBe('AGENTS.md (Workspace Router)');
    await mkdir(path.join(tmp, 'dir', 'AGENTS.md'), { recursive: true });
    expect(await routerTitle(path.join(tmp, 'dir'))).toBeNull(); // a folder named AGENTS.md is no router
    expect(await routerTitle(null)).toBeNull();
  });

  it('validateSettingsPatch keeps only valid editable keys', () => {
    expect(validateSettingsPatch({ 'sessions.worktrees': false, 'usage.warnAtPct': 100 })).toEqual({
      ok: true,
      value: { 'sessions.worktrees': false, 'usage.warnAtPct': 100 },
    });
    expect(validateSettingsPatch({ 'usage.warnAtPct': 1 }).ok).toBe(true);
  });

  it('readKnownSettings (UI side) falls back to defaults / unknown for missing or mistyped values', () => {
    expect(readKnownSettings(null)).toEqual({
      ...SETTING_DEFAULTS,
      'service.startAtLogin': false,
      'service.address': '',
      'workspace.root': null,
      'workspace.router': null,
      'github.prPollMinutes': 0,
    });
    expect(readKnownSettings({ 'sessions.ultracode': 'yes', 'workspace.root': '/w', 'usage.warnAtPct': 80 })).toMatchObject({
      'sessions.ultracode': false,
      'workspace.root': '/w',
      'usage.warnAtPct': 80,
    });
  });

  it('D64 · the standing instruction: on by default with the default text; edit, toggle and reset are stored; bad values 422', async () => {
    await setup();
    // D68: the todo-list sentence made it longer (still short: it costs tokens in every session); D70: priority and estimate (502); D75: in progress when started, done when finished, always (550).
    expect(DEFAULT_STANDING_INSTRUCTION.length).toBeLessThan(560);
    expect(await standingInstructionFor(store!.settings)).toBe(DEFAULT_STANDING_INSTRUCTION);
    const edited = await call('PUT', '/api/settings', { 'agents.standingInstruction': 'Be brief.' });
    expect(edited.json()).toMatchObject({ 'agents.standingInstruction': 'Be brief.', 'agents.standingInstruction.enabled': true });
    expect(await standingInstructionFor(store!.settings)).toBe('Be brief.');
    await call('PUT', '/api/settings', { 'agents.standingInstruction.enabled': false });
    expect(await standingInstructionFor(store!.settings)).toBeNull();
    // The text is kept while off; "Reset to default" stores the default text.
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'agents.standingInstruction': 'Be brief.', 'agents.standingInstruction.enabled': false });
    await call('PUT', '/api/settings', { 'agents.standingInstruction': DEFAULT_STANDING_INSTRUCTION, 'agents.standingInstruction.enabled': true });
    expect(await standingInstructionFor(store!.settings)).toBe(DEFAULT_STANDING_INSTRUCTION);
    // Empty text is allowed and passes nothing.
    await call('PUT', '/api/settings', { 'agents.standingInstruction': '  ' });
    expect(await standingInstructionFor(store!.settings)).toBeNull();
    for (const body of [{ 'agents.standingInstruction': 5 }, { 'agents.standingInstruction': 'x'.repeat(4_001) }, { 'agents.standingInstruction.enabled': 'yes' }]) {
      const refused = await call('PUT', '/api/settings', body);
      expect(refused.statusCode, JSON.stringify(Object.keys(body))).toBe(422);
    }
  });

  it('D64 · effectiveStandingInstruction and readKnownSettings (UI side)', () => {
    const on = { 'agents.standingInstruction': ' text ', 'agents.standingInstruction.enabled': true } as const;
    expect(effectiveStandingInstruction(on)).toBe('text');
    expect(effectiveStandingInstruction({ ...on, 'agents.standingInstruction.enabled': false })).toBeNull();
    expect(effectiveStandingInstruction({ ...on, 'agents.standingInstruction': '' })).toBeNull();
    expect(readKnownSettings({ 'agents.standingInstruction': 7 })).toMatchObject({ 'agents.standingInstruction': DEFAULT_STANDING_INSTRUCTION, 'agents.standingInstruction.enabled': true });
  });
});
