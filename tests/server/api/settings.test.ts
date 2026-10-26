import { EXAMPLE_PRICES } from '../../../src/core/insights.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { defaultPowerEstimate } from '../../../src/core/power.ts';
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

/** The stored settings rows without this machine's identity (`peers.self`, written at start since D132: Team, always on, reads it). */
async function storedPreferences(): Promise<Record<string, unknown>> {
  // D137: the archive's grace and sweep record are written by the service itself at start.
  const { 'peers.self': _self, 'sessions.archiveSince': _since, 'sessions.archiveSweep': _sweep, ...rest } = await store!.settings.getAll();
  return rest;
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
      'sessions.checkpoints': true,
      'sessions.todoEnrich': true,
      'usage.warnAtPct': 90,
      'ui.sidebarHidden': false,
      'ui.rightPanelHidden': false,
      // D101: the sidebar's TOOLS section, expanded by default.
      'ui.toolsCollapsed': false,
      'ui.sessionsCollapsed': false,
      'ui.chatsCollapsed': false,
      // D131: the v2 UI unless the service or the browser says otherwise.
      'ui.theme': 'v2',
      'newSession.mode': 'simple',
      'agents.standingInstruction': DEFAULT_STANDING_INSTRUCTION,
      'agents.standingInstruction.enabled': true,
      'sessions.modelRules': [],
      'sessions.freshOffer': true,
      'sessions.freshOfferPct': 80,
      // D108: Insights' prices, Switchboard's examples until saved.
      'insights.prices': EXAMPLE_PRICES,
      // D109: the CI / PR feedback loop.
      'ci.sendFailures': true,
      'ci.pendingPollMinutes': 2,
      'ci.idlePollMinutes': 10,
      'ci.maxAttempts': 3,
      'ci.logTailLines': 150,
      'ci.mergeMethod': 'repo',
      // D125: the power estimate, every part at this machine's default (by its cores).
      'power.estimate': { cpuIdleW: null, cpuMaxW: null, baseW: null },
      // D127: the idle stop of a session's leftover processes (minutes; 0 = off).
      'processes.idleStopMinutes': 10,
      // D137: the archive's period (days; 0 = never) and its sweep's record.
      'sessions.archiveDays': 14,
      'sessions.archiveSweep': expect.objectContaining({ lastDeleted: null }) as unknown as KnownSettings['sessions.archiveSweep'],
      'power.estimateDefaults': defaultPowerEstimate(os.cpus().length, process.platform, process.arch),
      'service.startAtLogin': false,
      'service.address': `127.0.0.1:${PORT}`,
      'workspace.root': workspace,
      'workspace.router': 'AGENTS.md (Workspace Router)',
      'github.prPollMinutes': 5,
    });
    // Nothing is stored until something is set (docs/database.md).
    expect(await storedPreferences()).toEqual({});
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
    expect(await storedPreferences()).toEqual({ 'sessions.worktrees': false, 'sessions.ultracode': true, 'usage.warnAtPct': 75 });
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
    expect(await storedPreferences()).toEqual({});
    expect((await call('GET', '/api/settings')).json()).toMatchObject(SETTING_DEFAULTS);
  });

  it('PUT with an empty object stores nothing and answers the current settings', async () => {
    await setup();
    const response = await call('PUT', '/api/settings', {});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(SETTING_DEFAULTS);
    expect(await storedPreferences()).toEqual({});
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
    expect(await storedPreferences()).toEqual({ 'ui.sidebarHidden': true, 'ui.rightPanelHidden': true });

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
    expect(await storedPreferences()).toEqual({ 'newSession.mode': 'full' });
    await store!.settings.setMany({ 'newSession.mode': 'wizard' });
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'newSession.mode': 'simple' });
  });

  it('D82 · Model by task: rules are stored in order; the model must exist for the CLI, the account must be its enabled profile; bad shapes 422', async () => {
    await setup();
    // A model list Claude Code reported (with effort levels), so the check is the CLI's own.
    await store!.settings.set('models.options', [
      { value: 'default', label: 'Default', efforts: ['low', 'medium', 'high'] },
      { value: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] },
      { value: 'haiku', label: 'Haiku' },
    ]);
    const rules = [
      { id: 'r1', priority: 'low', estimate: { kind: 'at-most', minutes: 30 }, provider: 'claude', model: 'sonnet', effort: 'low', profileId: 'default-claude' },
      { id: 'r2', priority: 'any', estimate: { kind: 'unknown' }, provider: 'codex' },
    ];
    const put = await call('PUT', '/api/settings', { 'sessions.modelRules': rules });
    expect(put.statusCode).toBe(200);
    expect(put.json()['sessions.modelRules']).toEqual(rules);
    expect((await call('GET', '/api/settings')).json()['sessions.modelRules']).toEqual(rules);

    // A model the CLI does not offer, an effort the model lacks, a profile of another CLI, a disabled one: 422 with the field.
    const refused = async (rule: Record<string, unknown>, field: string, text: RegExp): Promise<void> => {
      const response = await call('PUT', '/api/settings', { 'sessions.modelRules': [rule] });
      expect(response.statusCode).toBe(422);
      expect(response.json().errors).toEqual([{ field: `sessions.modelRules[0].${field}`, message: expect.stringMatching(text) }]);
    };
    const base = { id: 'x', priority: 'high', estimate: { kind: 'any' }, provider: 'claude' };
    await refused({ ...base, model: 'gpt-5' }, 'model', /does not offer the model "gpt-5"/);
    await refused({ ...base, model: 'haiku', effort: 'high' }, 'effort', /Haiku has no effort levels/);
    await refused({ ...base, profileId: 'default-codex' }, 'profileId', /belongs to Codex CLI, not Claude Code/);
    await refused({ ...base, profileId: 'nope' }, 'profileId', /no such account profile/);
    await store!.profiles.update('default-claude', { enabled: false });
    await refused({ ...base, profileId: 'default-claude' }, 'profileId', /is disabled for Claude Code/);
    // A CLI that never reported models offers its default only.
    await refused({ ...base, provider: 'opencode', model: 'sonnet' }, 'model', /OpenCode does not offer the model "sonnet": pick one of default/);
    // Shape: a model without its CLI, a rule that sets nothing, a bad estimate.
    await refused({ id: 'x', priority: 'low', estimate: { kind: 'any' }, model: 'sonnet' }, 'model', /also sets the CLI/);
    const nothing = await call('PUT', '/api/settings', { 'sessions.modelRules': [{ id: 'x', priority: 'low', estimate: { kind: 'any' } }] });
    expect(nothing.json().errors).toEqual([{ field: 'sessions.modelRules[0]', message: 'a rule sets at least one of CLI, model, effort or account' }]);
    await refused({ ...base, estimate: { kind: 'at-most', minutes: 0 } }, 'estimate', /minutes must be a whole number/);
    // Nothing of a refused body was stored.
    expect((await call('GET', '/api/settings')).json()['sessions.modelRules']).toEqual(rules);
    // Clearing the list turns routing off.
    expect((await call('PUT', '/api/settings', { 'sessions.modelRules': [] })).json()['sessions.modelRules']).toEqual([]);
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

  it('D125 · power.estimate: watts (null = default) are stored; the defaults are read-only; bad values 422', async () => {
    await setup();
    const saved = await call('PUT', '/api/settings', { 'power.estimate': { cpuIdleW: 10, cpuMaxW: 95, baseW: null } });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as KnownSettings)['power.estimate']).toEqual({ cpuIdleW: 10, cpuMaxW: 95, baseW: null });
    expect(await store!.settings.get('power.estimate')).toEqual({ cpuIdleW: 10, cpuMaxW: 95, baseW: null });
    for (const bad of [{ cpuIdleW: 100, cpuMaxW: 50 }, { baseW: -5 }, { baseW: 'x' }, 40]) {
      expect((await call('PUT', '/api/settings', { 'power.estimate': bad })).statusCode, JSON.stringify(bad)).toBe(422);
    }
    const readOnly = await call('PUT', '/api/settings', { 'power.estimateDefaults': { cpuIdleW: 1, cpuMaxW: 2, baseW: 3 } });
    expect(readOnly.statusCode).toBe(422);
  });

  it('D137 · sessions.archiveDays: 14 by default, 0 (Never) to 3650 stored; the sweep record is read-only; bad values 422', async () => {
    await setup();
    expect(((await call('GET', '/api/settings')).json() as KnownSettings)['sessions.archiveDays']).toBe(14);
    for (const days of [0, 7, 3650]) {
      const saved = await call('PUT', '/api/settings', { 'sessions.archiveDays': days });
      expect(saved.statusCode).toBe(200);
      expect((saved.json() as KnownSettings)['sessions.archiveDays']).toBe(days);
    }
    for (const bad of [-1, 3651, 1.5, '14', null]) expect((await call('PUT', '/api/settings', { 'sessions.archiveDays': bad })).statusCode, JSON.stringify(bad)).toBe(422);
    expect((await call('PUT', '/api/settings', { 'sessions.archiveSweep': { lastRunAt: null, lastDeleted: null } })).statusCode).toBe(422);
    await store!.settings.set('sessions.archiveSweep', { lastRunAt: '2026-10-26T12:00:00.000Z', lastDeleted: { at: '2026-10-26T12:00:00.000Z', sessions: 2, worktrees: 1, keptWorktrees: [] } });
    expect(((await call('GET', '/api/settings')).json() as KnownSettings)['sessions.archiveSweep']).toEqual({ lastRunAt: '2026-10-26T12:00:00.000Z', lastDeleted: { at: '2026-10-26T12:00:00.000Z', sessions: 2, worktrees: 1, keptWorktrees: [] } });
  });

  it('D131 · ui.theme: v2 by default, the service default from SWITCHBOARD_UI_THEME_DEFAULT until stored, only v2 / classic accepted', async () => {
    await setup();
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'ui.theme': 'v2' });
    const saved = await call('PUT', '/api/settings', { 'ui.theme': 'classic' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ 'ui.theme': 'classic' });
    // Only ui.theme is stored by the PUT (D132's always-on services keep their own rows, e.g. peers.self).
    expect(await store!.settings.get('ui.theme')).toBe('classic');
    const bad = await call('PUT', '/api/settings', { 'ui.theme': 'dark' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'ui.theme' }] });
    expect(readKnownSettings({ 'ui.theme': 'nope' })['ui.theme']).toBe('v2');
    expect(readKnownSettings({ 'ui.theme': 'classic' })['ui.theme']).toBe('classic');
  });

  it('D131 · SWITCHBOARD_UI_THEME_DEFAULT sets the default until ui.theme is stored; anything else is a config error', async () => {
    tmp = await makeTempDir('api-settings-theme');
    store = await openTempStore(path.join(tmp, 'data'));
    token = generateToken();
    const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), SWITCHBOARD_UI_THEME_DEFAULT: 'Classic' }, platform: 'linux', home: tmp, cwd: tmp });
    expect(base.uiThemeDefault).toBe('classic');
    app = await buildApp({ config: { ...base, port: PORT }, token, store, webRoot: tmp });
    await app.ready();
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'ui.theme': 'classic' });
    await call('PUT', '/api/settings', { 'ui.theme': 'v2' });
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'ui.theme': 'v2' });
    expect(loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }).uiThemeDefault).toBeUndefined();
    expect(() => loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp, SWITCHBOARD_UI_THEME_DEFAULT: 'dark' }, platform: 'linux', home: tmp, cwd: tmp })).toThrow(/SWITCHBOARD_UI_THEME_DEFAULT/);
  });

  it('readKnownSettings (UI side) falls back to defaults / unknown for missing or mistyped values', () => {
    expect(readKnownSettings(null)).toEqual({
      ...SETTING_DEFAULTS,
      'service.startAtLogin': false,
      'service.address': '',
      'workspace.root': null,
      'workspace.router': null,
      'github.prPollMinutes': 0,
      // D125: no defaults reported → zeros (the UI shows none).
      'power.estimateDefaults': { cpuIdleW: 0, cpuMaxW: 0, baseW: 0 },
      // D137: no sweep yet.
      'sessions.archiveSweep': { lastRunAt: null, lastDeleted: null },
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
    // D89: the artifact sentence added; the bound moved up by that much only. D94: the loop sentence (826), likewise. D124: the turn_status sentence (904), likewise. D133: the question-card sentence (1022), likewise.
    expect(DEFAULT_STANDING_INSTRUCTION.length).toBeLessThan(1030);
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

  it('D91 · Apply to open sessions: answers the summary (nothing open: all zero); a session reload of an unknown id is 404', async () => {
    await setup();
    const applied = await call('POST', '/api/settings/standing-instruction/apply', {});
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toEqual({ restarted: [], notRunning: 0, pending: [], current: 0, skipped: 0, failed: [] });
    const missing = await call('POST', '/api/sessions/nope/reload-instruction', {});
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'not-found' });
  });

  it('D64 · effectiveStandingInstruction and readKnownSettings (UI side)', () => {
    const on = { 'agents.standingInstruction': ' text ', 'agents.standingInstruction.enabled': true } as const;
    expect(effectiveStandingInstruction(on)).toBe('text');
    expect(effectiveStandingInstruction({ ...on, 'agents.standingInstruction.enabled': false })).toBeNull();
    expect(effectiveStandingInstruction({ ...on, 'agents.standingInstruction': '' })).toBeNull();
    expect(readKnownSettings({ 'agents.standingInstruction': 7 })).toMatchObject({ 'agents.standingInstruction': DEFAULT_STANDING_INSTRUCTION, 'agents.standingInstruction.enabled': true });
  });
});
