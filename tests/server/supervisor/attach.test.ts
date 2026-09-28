import { utimes } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolPayload, UserPayload } from '../../../src/core/event-payload.ts';
import { ATTACH_RECENT_MS, attachWarnings, claudeConfigDir, findTranscriptFile } from '../../../src/server/supervisor/attach.ts';
import { AttachWarningError } from '../../../src/server/supervisor/supervisor.ts';
import { BASELINE, type FakeRun, listTranscripts, runFake, spawnFake } from '../../helpers/fake-claude.ts';
import {
  type SupervisorWorld,
  makeSupervisorWorld,
  newSession,
  payloadType,
  spawnedArgv,
  stdinOf,
  until,
  waitForStatus,
} from '../../helpers/supervisor.ts';

/**
 * "Attach here" (M4.1): the terminal warning and the sync back of the terminal's
 * turns, against fake-claude with a temp CLAUDE_CONFIG_DIR. The "terminal" is a
 * text-mode `claude -p --resume <id> "<prompt>"` run (M0.4 step 2).
 */

let world: SupervisorWorld | undefined;
const extra: FakeRun[] = [];

afterEach(async () => {
  for (const run of extra.splice(0)) {
    run.kill('SIGKILL');
    await run.exited;
  }
  await world?.cleanup();
  world = undefined;
});

const TERMINAL_PROMPT = 'Please also remember a second code word: kestrel. What was the first code word I gave you? Reply with just that word.';

/** The world's env as plain strings (for the fake runs this test starts itself). */
function envOf(w: SupervisorWorld, extraEnv: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(w.env)) if (value !== undefined) out[key] = value;
  return { ...out, ...extraEnv };
}

/** A session that ran one turn and was detached ("Continue in terminal"). */
async function detachedSession(options: Parameters<typeof makeSupervisorWorld>[0] = {}) {
  world = await makeSupervisorWorld(options);
  const w = world;
  const session = await w.supervisor.start(newSession({ task: 'Remember the code word: tangerine. Reply with just OK.' }), w.place);
  await waitForStatus(w.store, session.id, ['done']);
  const { resumeCommand } = await w.supervisor.detach(session.id);
  expect(resumeCommand).toBe(`claude --resume ${session.claudeSessionId}`);
  const detached = await w.store.sessions.get(session.id);
  expect(detached).toMatchObject({ attached: false, status: 'paused', pid: null });
  return { w, session, syncPoint: detached?.lastTranscriptUuid ?? null };
}

/** The terminal turn (text mode, M0.4 step 2); `handoff-reattach` replies "tangerine, kestrel". */
async function terminalTurn(w: SupervisorWorld, claudeSessionId: string, prompt = TERMINAL_PROMPT): Promise<string> {
  const result = await runFake(['-p', '--resume', claudeSessionId, prompt], {
    cwd: w.workspace,
    env: envOf(w, { FAKE_CLAUDE_SCENARIO: 'handoff-reattach' }),
  });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

/** Makes the transcript look untouched for longer than the warning window. */
async function ageTranscript(w: SupervisorWorld): Promise<void> {
  const [file] = await listTranscripts(w.configDir);
  const old = new Date(Date.now() - ATTACH_RECENT_MS - 60_000);
  await utimes(file as string, old, old);
}

/** The supervisor's spawns (always with `--name`), not `agents --json` nor this test's terminal runs. */
async function sessionSpawns(w: SupervisorWorld) {
  return (await spawnedArgv(w.logFile)).filter((line) => line.argv?.includes('--name'));
}

describe('Attach here · warning (gap #5, M0.4)', () => {
  it('the transcript changed less than 2 minutes ago → AttachWarningError, nothing spawned; confirm attaches', async () => {
    const { w, session } = await detachedSession();
    await terminalTurn(w, session.claudeSessionId);
    const error = await w.supervisor.attach(session.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AttachWarningError);
    const reasons = (error as AttachWarningError).reasons;
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.kind).toBe('transcript-recent');
    expect((error as AttachWarningError).message).toMatch(/forks the conversation/);
    expect(await sessionSpawns(w)).toHaveLength(1);
    expect(await w.store.sessions.get(session.id)).toMatchObject({ attached: false, pid: null });

    await w.supervisor.attach(session.id, { confirm: true });
    const idle = await waitForStatus(w.store, session.id, ['idle']);
    expect(idle.attached).toBe(true);
  });

  it('`claude agents --json` lists the id (an open, idle terminal) → terminal-live with its pid, even with an old transcript', async () => {
    const { w, session } = await detachedSession();
    await ageTranscript(w);
    // The open terminal: an idle `--resume` process holding the id (it writes nothing until a message, M0.4).
    const terminal = spawnFake([...BASELINE, '--resume', session.claudeSessionId], { cwd: w.workspace, env: envOf(w) });
    extra.push(terminal);
    await terminal.waitFor((line) => line['type'] === 'system');
    const listed = await until(async () => {
      const error = await w.supervisor.attach(session.id).catch((caught: unknown) => caught);
      return error instanceof AttachWarningError && error.reasons.some((r) => r.kind === 'terminal-live') ? error : undefined;
    }, 'the live terminal in claude agents --json');
    expect(listed.reasons).toEqual([{ kind: 'terminal-live', pid: terminal.child.pid }]);
    expect(await sessionSpawns(w)).toHaveLength(1);
  });

  it('no live-process list → liveness-unknown; an old transcript and an empty list → no warning', async () => {
    const { w, session } = await detachedSession({ listLive: null });
    await ageTranscript(w);
    const error = await w.supervisor.attach(session.id).catch((caught: unknown) => caught);
    expect((error as AttachWarningError).reasons).toEqual([{ kind: 'liveness-unknown' }]);

    const file = await findTranscriptFile(claudeConfigDir(w.env), session.claudeSessionId);
    expect(file).not.toBeNull();
    expect(await attachWarnings({ transcript: file, claudeSessionId: session.claudeSessionId, listLive: async () => [], now: Date.now() })).toEqual([]);
    expect(await attachWarnings({ transcript: null, claudeSessionId: 'x', listLive: async () => [{ pid: 7, sessionId: 'x' }], now: Date.now() })).toEqual([
      { kind: 'terminal-live', pid: 7 },
    ]);
  });

  it('claudeConfigDir: CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }, '/home/dev')).toBe('/tmp/cfg');
    expect(claudeConfigDir({}, '/home/dev')).toBe('/home/dev/.claude');
  });
});

describe('Attach here · sync back of the terminal turns (M0.4)', () => {
  it('imports the terminal prompt and reply as events, then spawns --resume (same id, same flags, no message)', async () => {
    const { w, session, syncPoint } = await detachedSession();
    expect(syncPoint).not.toBeNull();
    const reply = await terminalTurn(w, session.claudeSessionId);
    expect(reply).toBe('tangerine, kestrel');
    await ageTranscript(w);

    await w.supervisor.attach(session.id);
    const attached = await waitForStatus(w.store, session.id, ['idle']);
    const events = await w.store.events.list(session.id);
    const terminal = events.filter((e) => payloadType(e) === 'user' && (e.payload as UserPayload).origin === 'terminal');
    expect(terminal.map((e) => [e.kind, e.label, (e.payload as UserPayload).delivered])).toEqual([['text', TERMINAL_PROMPT, true]]);
    const after = events.slice(events.indexOf(terminal[0] as (typeof events)[0]));
    expect(after.map((e) => [payloadType(e), e.label])).toEqual([
      ['user', TERMINAL_PROMPT],
      ['assistant', 'tangerine, kestrel'],
      ['lifecycle', 'Attached'],
    ]);
    // Ordered by the transcript's time: after the detach, before the attach.
    const detachedAt = events.find((e) => e.label === 'Continued in a terminal');
    expect((detachedAt?.ts ?? '') <= (terminal[0]?.ts ?? '')).toBe(true);
    expect(attached.lastTranscriptUuid).not.toBe(syncPoint);
    expect(attached.lastActivityAt).not.toBeNull();

    const spawns = await until(async () => {
      const logged = await sessionSpawns(w);
      return logged.length === 2 ? logged : undefined;
    }, 'the attach spawn');
    expect(spawns[1]?.argv).toEqual([...BASELINE, '--resume', session.claudeSessionId, '--name', session.name, '--forward-subagent-text', '--replay-user-messages']);
    expect(spawns[1]?.pid).toBe(attached.pid);
    expect(await stdinOf(w.logFile, spawns[1]?.pid ?? -1)).toEqual([]);

    // Attach again while live: nothing happens. Detach + attach again: nothing new to import.
    await w.supervisor.attach(session.id);
    await w.supervisor.detach(session.id);
    await ageTranscript(w);
    await w.supervisor.attach(session.id);
    await waitForStatus(w.store, session.id, ['idle']);
    const again = await w.store.events.list(session.id);
    expect(again.filter((e) => payloadType(e) === 'user' && (e.payload as UserPayload).origin === 'terminal')).toHaveLength(1);
    expect(again.filter((e) => payloadType(e) === 'assistant').map((e) => e.label)).toEqual(['OK', 'tangerine, kestrel']);
    expect(w.errors).toEqual([]);
  });

  it('a terminal tool call is imported as a tool event closed by its result', async () => {
    const { w, session } = await detachedSession();
    const result = await runFake(['-p', '--resume', session.claudeSessionId, 'Write the file. [fake:write notes/terminal.md]'], {
      cwd: w.workspace,
      env: envOf(w),
    });
    expect(result.code, result.stderr).toBe(0);
    await w.supervisor.attach(session.id, { confirm: true });
    await waitForStatus(w.store, session.id, ['idle']);
    const tools = (await w.store.events.list(session.id)).filter((e) => payloadType(e) === 'tool');
    expect(tools).toHaveLength(1);
    const tool = tools[0] as (typeof tools)[0];
    expect(tool.kind).toBe('impl');
    expect(tool.label).toBe('Write · terminal.md');
    expect(tool.endTs).not.toBeNull();
    expect((tool.payload as ToolPayload).isError).toBe(false);
  });

  it('two concurrent attaches spawn one process', async () => {
    const { w, session } = await detachedSession();
    await Promise.all([w.supervisor.attach(session.id, { confirm: true }), w.supervisor.attach(session.id, { confirm: true })]);
    await waitForStatus(w.store, session.id, ['idle']);
    await until(async () => (await sessionSpawns(w)).length === 2, 'the attach spawn in the fake log');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await sessionSpawns(w)).toHaveLength(2);
  });
});
