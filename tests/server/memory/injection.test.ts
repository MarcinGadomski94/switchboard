import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_BLOCK_END, MEMORY_BLOCK_START, MEMORY_SETTING, type MemoryEntry } from '../../../src/core/memory.ts';
import { DEFAULT_STANDING_INSTRUCTION } from '../../../src/core/settings.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { MemoryService } from '../../../src/server/memory/service.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D107 · the review gate end to end against the fake CLIs: a proposal never reaches a session;
 * an approved entry reaches the next session of its folder (fake-claude's `--append-system-prompt`,
 * fake-codex's `developerInstructions`, fake-opencode's `system`), a resumed one, and an open idle
 * one (D91's `--resume` restart); an edit made while approving is what arrives; a rejected entry
 * never does; with the switch off nothing does.
 */

const FLAG = '--append-system-prompt';

interface Rig {
  readonly world: SupervisorWorld;
  readonly memory: MemoryService;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.memory.close();
  await rig?.world.cleanup();
  rig = undefined;
});

async function setup(options: { readonly on?: boolean; readonly standingInstruction?: boolean } = {}): Promise<Rig> {
  const world = await makeSupervisorWorld({ standingInstruction: options.standingInstruction ?? false });
  const memory = new MemoryService({ dataDir: world.root, store: world.store, bus: new HubBus(), supervisor: world.supervisor, reloadDelayMs: 10 });
  if (options.on !== false) await world.store.settings.set(MEMORY_SETTING, true);
  await memory.start();
  rig = { world, memory };
  return rig;
}

async function claudeSpawns(w: SupervisorWorld) {
  return (await spawnedArgv(w.logFile)).filter((line) => line.argv?.includes('-p'));
}

function instructionOf(argv: readonly string[] | undefined): string | undefined {
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

/** A session of the world's folder proposing (the agent route's service call). */
async function propose(r: Rig, sessionId: string, title: string, text: string): Promise<MemoryEntry> {
  return r.memory.propose(sessionId, { title, text });
}

async function startDone(r: Rig, name: string, provider?: 'codex' | 'opencode') {
  const session = await r.world.supervisor.start({ ...newSession({ name, task: 'first' }), ...(provider ? { provider } : {}) }, r.world.place);
  await waitForStatus(r.world.store, session.id, ['done', 'idle']);
  return session;
}

describe('D107 · the review gate at the spawn (Claude Code)', () => {
  it('proposed: not injected; approved: a new session gets it; rejected: never; edited: the edit', async () => {
    const r = await setup();
    const w = r.world;
    const proposer = await startDone(r, 'proposer');
    const a = await propose(r, proposer.id, 'Run the tests with the test ports', 'SWITCHBOARD_TEST_PORTS=4900-4909 npx vitest run <file>');
    const b = await propose(r, proposer.id, 'Acme secret shortcut', 'UNREVIEWED-TEXT-THAT-MUST-NOT-LEAK');
    const c = await propose(r, proposer.id, 'Where the migrations live', 'AGENT-WORDING src/server/db/migrations');

    // Proposed only: a new session in the folder gets no block (no flag at all: the standing instruction is off here).
    const s1 = await startDone(r, 'before-approval');
    let spawns = await claudeSpawns(w);
    expect(spawns.map((spawn) => instructionOf(spawn.argv))).toEqual([undefined, undefined]);
    expect(await r.memory.blockFor(s1)).toBeNull();

    await r.memory.approve(a.id, {});
    await r.memory.reject(b.id);
    await r.memory.approve(c.id, { text: 'DEVELOPER-EDIT: migrations are in src/server/db/migrations; never edit an applied one.' });
    await r.memory.settled();

    await startDone(r, 'after-approval');
    spawns = await until(async () => {
      const found = await claudeSpawns(w);
      return found.some((spawn) => spawn.argv?.includes('--session-id') && instructionOf(spawn.argv)?.includes('SWITCHBOARD_TEST_PORTS')) ? found : undefined;
    }, 'the new session with memory');
    const block = instructionOf(spawns[spawns.length - 1]?.argv) as string;
    expect(block.startsWith(MEMORY_BLOCK_START)).toBe(true);
    expect(block.endsWith(MEMORY_BLOCK_END)).toBe(true);
    expect(block).toContain('- Run the tests with the test ports\n  SWITCHBOARD_TEST_PORTS=4900-4909 npx vitest run <file>');
    expect(block).toContain('DEVELOPER-EDIT: migrations are in src/server/db/migrations');
    // Rejected and the agent's pre-edit words never arrive, in any spawn.
    for (const spawn of await claudeSpawns(w)) {
      expect(spawn.argv?.join('\n')).not.toContain('UNREVIEWED-TEXT-THAT-MUST-NOT-LEAK');
      expect(spawn.argv?.join('\n')).not.toContain('AGENT-WORDING');
    }
  });

  it('next to the standing instruction: the default text first, then the block', async () => {
    const r = await setup({ standingInstruction: true });
    const developer = await r.memory.add({ scope: r.world.workspace, title: 'Acme build', text: 'npm ci && npm run build' });
    expect(developer.status).toBe('approved');
    await startDone(r, 'with-both');
    const spawns = await claudeSpawns(r.world);
    const text = instructionOf(spawns[0]?.argv) as string;
    expect(text.startsWith(`${DEFAULT_STANDING_INSTRUCTION}\n\n${MEMORY_BLOCK_START}`)).toBe(true);
    expect(spawns[0]?.argv?.filter((arg) => arg === FLAG)).toHaveLength(1);
  });

  it('a resumed session gets it; an open idle session is reloaded once (D91 --resume) after an approval', async () => {
    const r = await setup();
    const w = r.world;
    const paused = await startDone(r, 'paused-one');
    await w.supervisor.pause(paused.id);
    const idle = await startDone(r, 'idle-one');
    await until(async () => (w.supervisor.isLive(idle.id) && !w.supervisor.turnRunning(idle.id)) || undefined, 'idle');
    const proposal = await propose(r, idle.id, 'Acme lint rule', 'Run npm run lint before a commit.');
    await r.memory.settled();
    // A proposal changes nothing for the open session.
    expect((await claudeSpawns(w)).length).toBe(2);

    await r.memory.approve(proposal.id, {});
    await r.memory.settled();
    // The idle session restarted with --resume, carrying the block.
    const reloaded = await until(async () => {
      const found = (await claudeSpawns(w)).filter((spawn) => spawn.argv?.includes('--resume') && instructionOf(spawn.argv)?.includes('Acme lint rule'));
      return found.length >= 1 ? found : undefined;
    }, 'the idle session reloaded');
    expect(reloaded).toHaveLength(1);
    expect((await w.store.events.list(idle.id)).some((event) => JSON.stringify(event).includes('Standing instruction updated'))).toBe(true);

    // The paused one gets it when it resumes.
    await w.supervisor.resume(paused.id);
    await waitForStatus(w.store, paused.id, ['done', 'idle']);
    const resumed = (await claudeSpawns(w)).filter((spawn) => spawn.argv?.includes('--resume'));
    expect(resumed.length).toBe(2);
    for (const spawn of resumed) expect(instructionOf(spawn.argv)).toContain('Run npm run lint before a commit.');
  });

  it('off: approved entries are not injected (and the sessions are given back their plain instruction)', async () => {
    const r = await setup();
    await r.memory.add({ scope: r.world.workspace, title: 'Acme build', text: 'npm ci' });
    await r.world.store.settings.set(MEMORY_SETTING, false);
    await r.memory.switchChanged();
    await startDone(r, 'off-one');
    expect((await claudeSpawns(r.world)).map((spawn) => instructionOf(spawn.argv))).toEqual([undefined]);
  });
});

describe('D107 · Codex (developerInstructions) and OpenCode (system)', () => {
  it('Codex: thread/start carries the approved block, not the proposal', async () => {
    const r = await setup();
    await r.memory.add({ scope: r.world.workspace, title: 'Acme codex fact', text: 'APPROVED-FOR-CODEX' });
    const s = await startDone(r, 'codex-one', 'codex');
    await r.memory.propose(s.id, { title: 'Acme pending fact', text: 'PENDING-FOR-CODEX' });
    const threads = (await jsonLines(r.world.codexLog)).filter((line) => line['kind'] === 'thread-params');
    expect(threads[0]?.['method']).toBe('thread/start');
    expect(String(threads[0]?.['developerInstructions'])).toContain('APPROVED-FOR-CODEX');
    expect(JSON.stringify(threads)).not.toContain('PENDING-FOR-CODEX');
  });

  it('OpenCode: every prompt carries the approved block as `system`', async () => {
    const r = await setup();
    await r.memory.add({ scope: r.world.workspace, title: 'Acme opencode fact', text: 'APPROVED-FOR-OPENCODE' });
    await startDone(r, 'opencode-one', 'opencode');
    const prompts = (await jsonLines(r.world.opencodeLog)).filter((line) => line['kind'] === 'prompt').map((line) => (line['body'] ?? {}) as Record<string, unknown>);
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    for (const body of prompts) expect(String(body['system'])).toContain('APPROVED-FOR-OPENCODE');
  });
});
