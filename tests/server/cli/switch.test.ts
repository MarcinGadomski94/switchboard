import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LifecyclePayload } from '../../../src/core/event-payload.ts';
import { outgoingCapacity } from '../../../src/server/cli/capacity.ts';
import { chatMarkdown, handoverRequest } from '../../../src/server/cli/handover.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, stdinOf, until, waitForStatus } from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

async function codexTurns(file: string): Promise<string[]> {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { kind: string; line?: string })
    .filter((entry) => entry.kind === 'stdin' && entry.line)
    .map((entry) => JSON.parse(entry.line as string) as { method?: string; params?: { input?: Array<{ text?: string }> } })
    .filter((message) => message.method === 'turn/start')
    .map((message) => message.params?.input?.[0]?.text ?? '');
}

const OK = { ok: true, reason: null } as const;

describe('D62 P5 · switching a session to another CLI', () => {
  it('Claude Code → Codex with capacity: the outgoing agent writes the handover; Codex starts in the same cwd with it; the divider; the record', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await w.supervisor.start(newSession({ task: 'first task' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const started = await w.supervisor.switchProvider(session.id, 'codex', { capacity: OK, handoverDir: path.join(w.root, 'handovers') });
    expect(started.switchRecord).toMatchObject({ from: 'claude', to: 'codex', status: 'running' });
    expect(w.supervisor.currentSwitch(session.id)).toMatchObject({ from: 'claude', to: 'codex', step: 'handover' });
    // Messages wait for nothing while it switches: refused.
    await expect(w.supervisor.sendMessage(session.id, 'meanwhile')).rejects.toMatchObject({ code: 'switching' });
    const done = await started.done;
    expect(done).toMatchObject({ status: 'done', handoverBy: 'outgoing', exportPath: null });
    expect(w.supervisor.currentSwitch(session.id)).toBeNull();
    // Claude Code got the request (a service message), answered, and was stopped.
    const claudeStdin = await stdinOf(w.logFile, session.pid ?? -1, { all: true });
    expect(claudeStdin.some((line) => JSON.stringify(line).includes('Switchboard is handing this session over to Codex CLI now.'))).toBe(true);
    const stored = await waitForStatus(w.store, session.id, ['done']);
    expect(stored).toMatchObject({ provider: 'codex', model: null, effort: null, cwd: w.workspace });
    const turns = await codexTurns(w.codexLog);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain('You are continuing a session that Claude Code worked on until now');
    expect(turns[0]).toContain(`in this folder: ${w.workspace}`);
    expect(turns[0]).toMatch(/---\nOK\n---/);
    const events = await w.store.events.list(session.id);
    const divider = events.find((event) => (event.payload as LifecyclePayload | null)?.action === 'switched');
    expect(divider?.label).toBe('Switched from Claude Code to Codex CLI · handover by Claude Code (outgoing agent)');
    expect(divider?.payload).toMatchObject({ from: 'claude', to: 'codex', handoverBy: 'outgoing' });
    expect(await w.store.providers.listSwitches(session.id)).toHaveLength(1);
  });

  it('Codex out of capacity → the incoming agent reads the exported history (and the Codex rollout); Claude Code starts new (it never ran this session)', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await w.supervisor.start({ ...newSession({ task: '[fake:cmd ls] look around' }), provider: 'codex' }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const thread = await w.store.providers.nativeId(session.id, 'codex');
    const started = await w.supervisor.switchProvider(session.id, 'claude', { capacity: { ok: false, reason: 'Codex CLI is out of usage (a 5-hour limit is at 100%)' }, handoverDir: path.join(w.root, 'handovers') });
    const done = await started.done;
    expect(done).toMatchObject({ status: 'done', handoverBy: 'history' });
    const exported = done.exportPath ?? '';
    expect(exported.startsWith(path.join(w.root, 'handovers', session.id))).toBe(true);
    expect(exported).toMatch(/-codex-to-claude\.md$/);
    expect(((await stat(exported)).mode & 0o777).toString(8)).toBe('600');
    const markdown = await readFile(exported, 'utf8');
    expect(markdown).toContain('the chat so far');
    expect(markdown).toContain('look around');
    expect(markdown).toContain('- Bash: ls → done');
    // No handover was asked of Codex (it had no capacity).
    expect((await codexTurns(w.codexLog)).some((text) => text.includes('handing this session over'))).toBe(false);
    // Claude Code: a new conversation with the session's id; its first message points at the files.
    await waitForStatus(w.store, session.id, ['done']);
    const spawned = (await spawnedArgv(w.logFile)).filter((line) => line.argv?.[0] !== 'agents');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.argv).toContain('--session-id');
    const first = (await stdinOf(w.logFile, spawned[0]?.pid ?? -1)).find((line) => line['type'] === 'user');
    const text = JSON.stringify(first);
    expect(text).toContain('could not write a handover (Codex CLI is out of usage (a 5-hour limit is at 100%))');
    expect(text).toContain(exported);
    expect(text).toContain(`rollout-`);
    expect(text).toContain(String(thread));
    expect((await w.store.events.list(session.id)).some((event) => event.label === 'Switched from Codex CLI to Claude Code · handover by Claude Code from the history')).toBe(true);
    expect((await w.store.sessions.get(session.id))?.provider).toBe('claude');
  });

  it('a handover turn that fails (usage limit) falls back to the history; switching back resumes the CLI\'s own conversation', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await w.supervisor.start(newSession({ task: 'start on claude' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const toCodex = await w.supervisor.switchProvider(session.id, 'codex', { capacity: OK, handoverDir: path.join(w.root, 'handovers') });
    expect(await toCodex.done).toMatchObject({ status: 'done', handoverBy: 'outgoing' });
    await waitForStatus(w.store, session.id, ['done']);
    // Codex hits its usage limit: its handover turn fails, so Claude Code reads the history.
    w.env['FAKE_CODEX_RATE_LIMITS'] = '100,40';
    await w.supervisor.pause(session.id);
    const back = await w.supervisor.switchProvider(session.id, 'claude', { capacity: OK, handoverDir: path.join(w.root, 'handovers') });
    const done = await back.done;
    expect(done).toMatchObject({ status: 'done', handoverBy: 'history' });
    // Claude Code resumes its own earlier conversation (--resume <its id>).
    await waitForStatus(w.store, session.id, ['done']);
    const claudeSpawns = (await spawnedArgv(w.logFile)).filter((line) => line.argv?.[0] !== 'agents');
    expect(claudeSpawns).toHaveLength(2);
    expect(claudeSpawns[1]?.argv).toEqual(expect.arrayContaining(['--resume', session.claudeSessionId]));
    const first = JSON.stringify((await stdinOf(w.logFile, claudeSpawns[1]?.pid ?? -1)).find((line) => line['type'] === 'user'));
    expect(first).toContain("Codex: You've hit your usage limit");
    expect((await w.store.providers.listSwitches(session.id)).map((entry) => [entry.from, entry.to, entry.handoverBy])).toEqual([
      ['claude', 'codex', 'outgoing'],
      ['codex', 'claude', 'history'],
    ]);
  });

  it('refusals: the same CLI, a closed session, a detached one, one already switching', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await w.supervisor.start(newSession({ task: '[fake:hold 1]' }), w.place);
    await expect(w.supervisor.switchProvider(session.id, 'claude', { capacity: OK, handoverDir: w.root })).rejects.toMatchObject({ code: 'switching' });
    const started = await w.supervisor.switchProvider(session.id, 'opencode', { capacity: OK, handoverDir: w.root });
    await expect(w.supervisor.switchProvider(session.id, 'codex', { capacity: OK, handoverDir: w.root })).rejects.toMatchObject({ code: 'switching' });
    expect(await started.done).toMatchObject({ status: 'done', handoverBy: 'outgoing' });
    await until(async () => (await w.store.sessions.get(session.id))?.status === 'done', 'OpenCode answered');
    await w.supervisor.detach(session.id);
    await expect(w.supervisor.switchProvider(session.id, 'claude', { capacity: OK, handoverDir: w.root })).rejects.toMatchObject({ code: 'detached' });
  });

  it('capacity: installed and signed in, and no spent usage window', async () => {
    const clis = (installed: boolean, signedIn: boolean | null) => ({ info: async () => ({ installed, signedIn }) as never });
    expect(await outgoingCapacity({ provider: 'codex', clis: clis(true, true), supported: true, claudeUsage: null, providerUsage: null })).toEqual({ ok: true, reason: null });
    expect(await outgoingCapacity({ provider: 'codex', clis: clis(false, null), supported: true, claudeUsage: null, providerUsage: null })).toEqual({ ok: false, reason: 'Codex CLI is not installed' });
    expect(await outgoingCapacity({ provider: 'opencode', clis: clis(true, false), supported: true, claudeUsage: null, providerUsage: null })).toEqual({ ok: false, reason: 'OpenCode is signed out' });
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    const later = '2026-10-01T14:00:00.000Z';
    const claudeUsage = { id: 1, receivedAt: '', source: 'stream', sessionId: null, fiveHourPct: 100, fiveHourResetsAt: later, sevenDayPct: 40, sevenDayResetsAt: later, raw: null } as never;
    expect(await outgoingCapacity({ provider: 'claude', clis: clis(true, true), supported: true, claudeUsage, providerUsage: null, now })).toEqual({ ok: false, reason: 'Claude Code is out of usage (the 5-hour limit is at 100%)' });
    const providerUsage = { provider: 'codex' as const, windows: [{ pct: 100, minutes: 300, resetsAt: later }], at: '' };
    expect(await outgoingCapacity({ provider: 'codex', clis: clis(true, true), supported: true, claudeUsage: null, providerUsage, now })).toEqual({ ok: false, reason: 'Codex CLI is out of usage (a 5-hour limit is at 100%)' });
    // A window that has reset counts no more.
    expect(await outgoingCapacity({ provider: 'codex', clis: clis(true, true), supported: true, claudeUsage: null, providerUsage, now: Date.parse('2026-10-02T00:00:00.000Z') })).toEqual({ ok: true, reason: null });
  });

  it('the export reads like a chat; the request names the incoming CLI', () => {
    expect(handoverRequest('opencode')).toContain('handing this session over to OpenCode now');
    const markdown = chatMarkdown({
      title: 'Fix login',
      cwd: '/w',
      from: 'claude',
      to: 'codex',
      at: new Date('2026-10-01T00:00:00.000Z'),
      mainAgentId: 'm',
      events: [
        { id: 1, sessionId: 's', ts: 't1', kind: 'text', label: 'hi', agentId: null, payload: { type: 'user', text: 'Fix the login', origin: 'user', delivered: true } },
        { id: 2, sessionId: 's', ts: 't2', kind: 'text', label: 'x', agentId: 'm', payload: { type: 'assistant', text: 'On it.' } },
        { id: 3, sessionId: 's', ts: 't3', kind: 'impl', label: 'x', agentId: 'sub', payload: { type: 'tool', name: 'Edit', toolUseId: 'u', input: { file_path: '/w/a.ts' }, result: 'ok' } },
      ] as never,
    });
    expect(markdown).toContain('# Fix login — the chat so far');
    expect(markdown).toContain('## t1 · Developer\n\nFix the login');
    expect(markdown).toContain('## t2 · Agent\n\nOn it.');
    expect(markdown).toContain('- Edit: /w/a.ts → done');
  });
});
