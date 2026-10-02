import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_STANDING_INSTRUCTION } from '../../../src/core/settings.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D64 oracle: the standing instruction reaches every CLI at every spawn (new, resumed,
 * account switch, CLI switch), read at the spawn so a change applies afterwards; it is
 * absent when disabled or empty. Against fake-claude (argv), fake-codex (thread params)
 * and fake-opencode (prompt body).
 */
let world: SupervisorWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

const FLAG = '--append-system-prompt';

async function sessionSpawns(w: SupervisorWorld) {
  return (await spawnedArgv(w.logFile)).filter((line) => line.argv?.includes('-p'));
}

function textAfterFlag(argv: readonly string[] | undefined): string | undefined {
  const at = argv?.indexOf(FLAG) ?? -1;
  return at >= 0 ? argv?.[at + 1] : undefined;
}

async function jsonLines(file: string): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe('D64 · standing instruction · Claude Code (--append-system-prompt)', () => {
  it('on by default: the default text goes on a new session and on a resume', async () => {
    world = await makeSupervisorWorld({ standingInstruction: true });
    const w = world;
    const session = await w.supervisor.start(newSession({ task: 'first' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    await w.supervisor.resume(session.id);
    await waitForStatus(w.store, session.id, ['done']);
    const spawns = await until(async () => {
      const found = await sessionSpawns(w);
      return found.length >= 2 ? found : undefined;
    }, 'two spawns');
    expect(spawns[0]?.argv).toContain('--session-id');
    expect(spawns[1]?.argv).toContain('--resume');
    for (const spawn of spawns) {
      expect(textAfterFlag(spawn.argv)).toBe(DEFAULT_STANDING_INSTRUCTION);
      // one flag, and it is a single argv entry (no shell, no splitting)
      expect(spawn.argv?.filter((arg) => arg === FLAG)).toHaveLength(1);
    }
  });

  it('a changed text applies to the next spawn; disabled or empty: no flag', async () => {
    world = await makeSupervisorWorld({ standingInstruction: true });
    const w = world;
    await w.store.settings.set('agents.standingInstruction', '  Custom rule.  ');
    const session = await w.supervisor.start(newSession({ task: 'first' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    await w.store.settings.set('agents.standingInstruction.enabled', false);
    await w.supervisor.resume(session.id);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    await w.store.settings.setMany({ 'agents.standingInstruction.enabled': true, 'agents.standingInstruction': '   ' });
    await w.supervisor.resume(session.id);
    await waitForStatus(w.store, session.id, ['done']);
    const spawns = await until(async () => {
      const found = await sessionSpawns(w);
      return found.length >= 3 ? found : undefined;
    }, 'three spawns');
    expect(textAfterFlag(spawns[0]?.argv)).toBe('Custom rule.');
    expect(spawns[1]?.argv).not.toContain(FLAG);
    expect(spawns[2]?.argv).not.toContain(FLAG);
  });

  it('an account switch (D63) resumes with it', async () => {
    world = await makeSupervisorWorld({ standingInstruction: true });
    const w = world;
    const other = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const session = await w.supervisor.start(newSession({ task: 'first' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.switchAccount(session.id, other.id, { reason: 'test', handoverDir: path.join(w.root, 'handovers') });
    await waitForStatus(w.store, session.id, ['idle', 'done']);
    const spawns = await until(async () => {
      const found = await sessionSpawns(w);
      return found.length >= 2 ? found : undefined;
    }, 'two spawns');
    expect(spawns[1]?.argv).toContain('--resume');
    expect(textAfterFlag(spawns[1]?.argv)).toBe(DEFAULT_STANDING_INSTRUCTION);
  });

  it('a CLI switch (D62) to Claude Code starts it with it; to Codex gives Codex the thread instruction', async () => {
    world = await makeSupervisorWorld({ standingInstruction: true });
    const w = world;
    const session = await w.supervisor.start({ ...newSession({ task: 'first' }), provider: 'codex' }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const toClaude = await w.supervisor.switchProvider(session.id, 'claude', { capacity: { ok: false, reason: 'test' }, handoverDir: path.join(w.root, 'handovers') });
    await toClaude.done;
    await waitForStatus(w.store, session.id, ['done']);
    const spawns = await sessionSpawns(w);
    expect(spawns.length).toBeGreaterThanOrEqual(1);
    expect(textAfterFlag(spawns[spawns.length - 1]?.argv)).toBe(DEFAULT_STANDING_INSTRUCTION);
    const threads = (await jsonLines(w.codexLog)).filter((line) => line['kind'] === 'thread-params');
    expect(threads[0]).toMatchObject({ method: 'thread/start', developerInstructions: DEFAULT_STANDING_INSTRUCTION });
  });
});

describe('D64 · standing instruction · Codex (developerInstructions) and OpenCode (system)', () => {
  it('Codex: thread/start and thread/resume carry developerInstructions; off: the field is absent', async () => {
    world = await makeSupervisorWorld({ standingInstruction: true });
    const w = world;
    const session = await w.supervisor.start({ ...newSession({ task: 'first' }), provider: 'codex' }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    await w.supervisor.resume(session.id);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    await w.store.settings.set('agents.standingInstruction.enabled', false);
    await w.supervisor.resume(session.id);
    await waitForStatus(w.store, session.id, ['done']);
    const threads = (await jsonLines(w.codexLog)).filter((line) => line['kind'] === 'thread-params');
    expect(threads.map((line) => [line['method'], line['developerInstructions']])).toEqual([
      ['thread/start', DEFAULT_STANDING_INSTRUCTION],
      ['thread/resume', DEFAULT_STANDING_INSTRUCTION],
      ['thread/resume', null],
    ]);
  });

  it('OpenCode: every prompt carries `system`, resumed sessions too; off: absent', async () => {
    world = await makeSupervisorWorld({ standingInstruction: true });
    const w = world;
    const session = await w.supervisor.start({ ...newSession({ task: 'first' }), provider: 'opencode' }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    await w.supervisor.resume(session.id);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    await w.store.settings.set('agents.standingInstruction.enabled', false);
    await w.supervisor.resume(session.id);
    await waitForStatus(w.store, session.id, ['done']);
    const prompts = (await jsonLines(w.opencodeLog)).filter((line) => line['kind'] === 'prompt').map((line) => (line['body'] ?? {}) as Record<string, unknown>);
    expect(prompts.map((body) => body['system'] ?? null)).toEqual([DEFAULT_STANDING_INSTRUCTION, DEFAULT_STANDING_INSTRUCTION, null]);
  });
});
