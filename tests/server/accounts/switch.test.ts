import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTINUE_AFTER_SWITCH } from '../../../src/core/accounts.ts';
import type { LifecyclePayload } from '../../../src/core/event-payload.ts';
import { findCodexRollout } from '../../../src/server/cli/handover.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, readFakeLog, spawnedArgv, stdinOf, until, waitForEvent, waitForStatus } from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

function handovers(w: SupervisorWorld): string {
  return path.join(w.root, 'handovers');
}

async function claudeSpawns(w: SupervisorWorld) {
  return (await spawnedArgv(w.logFile)).filter((line) => line.argv?.[0] !== 'agents' && line.argv?.[0] !== 'auth');
}

/** The fake logs a process's argv a moment after it starts: wait for `count` of them. */
async function spawnsReaching(w: SupervisorWorld, count: number) {
  return until(async () => {
    const spawns = await claudeSpawns(w);
    return spawns.length >= count ? spawns : undefined;
  }, `${count} claude spawns`);
}

function userTexts(lines: Array<Record<string, unknown>>): string[] {
  return lines.filter((l) => l['type'] === 'user').map((l) => JSON.stringify(l));
}

describe('D63 · switching a Claude Code session to another account', () => {
  it('copies the transcript (the original stays) and resumes with the new profile\'s CLAUDE_CONFIG_DIR; the divider; no message after an idle session', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const session = await w.supervisor.start(newSession({ task: 'first task' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const before = await w.supervisor.findTranscript(session.claudeSessionId);
    expect(before?.startsWith(w.configDir)).toBe(true);

    const switched = await w.supervisor.switchAccount(session.id, b.id, { reason: 'session limit, resets 14:05', handoverDir: handovers(w) });
    expect(switched).toMatchObject({ profileId: b.id });
    await waitForStatus(w.store, session.id, ['idle', 'done']);

    // The transcript is in the new folder at the same project path; the old one is still there.
    const copied = path.join(b.dir as string, path.relative(w.configDir, before as string));
    expect((await stat(copied)).isFile()).toBe(true);
    expect((await stat(before as string)).isFile()).toBe(true);
    expect(await readFile(copied, 'utf8')).toBe(await readFile(before as string, 'utf8'));
    // The second process: --resume <id> with the new folder; the first one ran on the Default's.
    const spawns = await spawnsReaching(w, 2);
    expect(spawns).toHaveLength(2);
    expect(spawns[0]?.env?.['CLAUDE_CONFIG_DIR']).toBe(w.configDir);
    expect(spawns[1]?.argv).toEqual(expect.arrayContaining(['--resume', session.claudeSessionId]));
    expect(spawns[1]?.env?.['CLAUDE_CONFIG_DIR']).toBe(b.dir);
    // An idle session needs no "continue" message.
    expect(userTexts(await stdinOf(w.logFile, spawns[1]?.pid ?? -1))).toHaveLength(0);
    const divider = (await w.store.events.list(session.id)).find((e) => (e.payload as LifecyclePayload | null)?.action === 'account-switched');
    expect(divider?.label).toBe('Switched account: Default → Private (session limit, resets 14:05)');
    expect(divider?.payload).toMatchObject({ fromProfile: 'Default', toProfile: 'Private', reason: 'session limit, resets 14:05' });
    expect(w.errors).toEqual([]);
    // The conversation goes on there: a message resumes with the carried context (the fake finds the transcript in B's folder).
    await w.supervisor.sendMessage(session.id, 'and now?');
    await until(async () => ((await w.store.events.list(session.id)).filter((e) => (e.payload as { type?: string })?.type === 'result').length >= 2) || undefined, 'the second turn');
  });

  it('a turn the switch interrupted is picked up with a short "continue" message', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const session = await w.supervisor.start(newSession({ task: 'first task' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.sendMessage(session.id, '[fake:hold 30] think for a long time');
    await waitForStatus(w.store, session.id, ['run']);
    await w.supervisor.switchAccount(session.id, b.id, { reason: 'switched by you', handoverDir: handovers(w) });
    const spawns = await spawnsReaching(w, 2);
    expect(spawns).toHaveLength(2);
    const texts = await until(async () => {
      const found = userTexts(await stdinOf(w.logFile, spawns[1]?.pid ?? -1));
      return found.length > 0 ? found : undefined;
    }, 'the continue message');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(CONTINUE_AFTER_SWITCH);
  });

  it('a conversation that cannot be copied: the new account starts a fresh conversation and reads the exported chat', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const session = await w.supervisor.start(newSession({ task: 'work on it' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    // The new profile's folder cannot take the conversation (a file where its projects/ folder should be).
    await writeFile(path.join(b.dir as string, 'projects'), 'in the way');
    await w.supervisor.switchAccount(session.id, b.id, { reason: 'session limit', handoverDir: handovers(w) });
    const spawns = await spawnsReaching(w, 2);
    expect(spawns[1]?.argv).toEqual(expect.arrayContaining(['--session-id', session.claudeSessionId]));
    expect(spawns[1]?.argv).not.toContain('--resume');
    const text = await until(async () => {
      const found = userTexts(await stdinOf(w.logFile, spawns[1]?.pid ?? -1)).join('');
      return found !== '' ? found : undefined;
    }, 'the exported-chat message');
    expect(text).toContain('Switchboard moved it from the account \\"Default\\" to \\"Private\\"');
    const exported = (await readdir(path.join(handovers(w), session.id)))[0] ?? '';
    expect(exported).toMatch(/-claude-to-claude\.md$/);
    expect(await readFile(path.join(handovers(w), session.id, exported), 'utf8')).toContain('work on it');
  });

  it('refuses what cannot switch: the same profile, another CLI\'s, a disabled one, an unknown one; a paused session only changes profile', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const off = await w.accounts.create({ cli: 'claude', name: 'Off' });
    await w.accounts.update(off.id, { enabled: false });
    const codex = await w.accounts.create({ cli: 'codex', name: 'Other' });
    const session = await w.supervisor.start(newSession({ task: 'first task' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await expect(w.supervisor.switchAccount(session.id, 'default-claude', { reason: 'x', handoverDir: handovers(w) })).rejects.toMatchObject({ code: 'switching' });
    await expect(w.supervisor.switchAccount(session.id, codex.id, { reason: 'x', handoverDir: handovers(w) })).rejects.toMatchObject({ code: 'not-available' });
    await expect(w.supervisor.switchAccount(session.id, off.id, { reason: 'x', handoverDir: handovers(w) })).rejects.toMatchObject({ code: 'not-available' });
    await expect(w.supervisor.switchAccount(session.id, 'nope', { reason: 'x', handoverDir: handovers(w) })).rejects.toMatchObject({ code: 'not-available' });
    await w.supervisor.pause(session.id);
    const before = (await claudeSpawns(w)).length;
    const paused = await w.supervisor.switchAccount(session.id, b.id, { reason: 'switched by you', handoverDir: handovers(w) });
    expect(paused.profileId).toBe(b.id);
    // Nothing started; the divider is the chat's record; the next resume runs on the new profile.
    expect(await claudeSpawns(w)).toHaveLength(before);
    expect((await w.store.events.list(session.id)).some((e) => e.label === 'Switched account: Default → Private (switched by you)')).toBe(true);
    await w.supervisor.resume(session.id);
    const last = (await spawnsReaching(w, before + 1)).at(-1);
    expect(last?.env?.['CLAUDE_CONFIG_DIR']).toBe(b.dir);
  });

  it('messages are refused while a switch runs; a failed switch keeps the session on its account and says so', async () => {
    // A CLI that ignores the interrupt makes the stop take its timeouts: the switch runs long enough to be seen.
    world = await makeSupervisorWorld({ parentEnv: { FAKE_CLAUDE_IGNORE_INTERRUPT: '1' }, timeouts: { ack: 500, result: 500, exit: 500, signal: 500 } });
    const w = world;
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const session = await w.supervisor.start(newSession({ task: 'first task' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const running = w.supervisor.switchAccount(session.id, b.id, { reason: 'x', handoverDir: handovers(w) });
    await until(async () => w.supervisor.accountSwitching(session.id) || undefined, 'the switch to start');
    expect((await w.store.sessions.get(session.id))?.profileId).toBe('default-claude');
    await expect(w.supervisor.sendMessage(session.id, 'meanwhile')).rejects.toMatchObject({ code: 'switching' });
    await expect(w.supervisor.switchAccount(session.id, b.id, { reason: 'x', handoverDir: handovers(w) })).rejects.toMatchObject({ code: 'switching' });
    await running;
    expect((await w.store.sessions.get(session.id))?.profileId).toBe(b.id);
    // Back to the Default with a folder that cannot take the conversation and an export folder that cannot be made.
    await rm(path.join(w.configDir, 'projects'), { recursive: true, force: true });
    await writeFile(path.join(w.configDir, 'projects'), 'in the way');
    const blocker = path.join(w.root, 'blocked');
    await writeFile(blocker, 'a file where a folder should be');
    await expect(w.supervisor.switchAccount(session.id, 'default-claude', { reason: 'x', handoverDir: path.join(blocker, 'sub') })).rejects.toMatchObject({ code: 'switch-failed' });
    expect((await w.store.sessions.get(session.id))?.profileId).toBe(b.id);
    expect((await w.store.events.list(session.id)).some((e) => e.kind === 'error' && e.label.startsWith('Could not switch to the account Default'))).toBe(true);
    // It is back up on the account it had.
    await until(async () => w.supervisor.isLive(session.id) || undefined, 'the session running again');
    w.errors.length = 0;
  });
});

describe('D63 · Codex: the rollout is copied; the handover inside Codex is the fallback', () => {
  it('copies the thread\'s rollout into the new CODEX_HOME and resumes the thread there', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const b = await w.accounts.create({ cli: 'codex', name: 'Second' });
    const session = await w.supervisor.start({ ...newSession({ task: 'codex work' }), provider: 'codex' }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const thread = (await w.store.providers.nativeId(session.id, 'codex')) as string;
    const source = (await findCodexRollout({ CODEX_HOME: w.codexHome }, thread)) as string;
    await w.supervisor.switchAccount(session.id, b.id, { reason: 'usage limit', handoverDir: handovers(w) });
    await waitForStatus(w.store, session.id, ['idle', 'done']);
    const target = path.join(b.dir as string, path.relative(w.codexHome, source));
    expect(await readFile(target, 'utf8')).toBe(await readFile(source, 'utf8'));
    expect((await stat(source)).isFile()).toBe(true);
    // The thread is resumed (not a new one), by an app-server on the new home.
    const entries = await until(async () => {
      const all = (await readFile(w.codexLog, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; argv?: string[]; env?: Record<string, string>; line?: string });
      const servers = all.filter((e) => e.kind === 'argv' && e.argv?.[0] === 'app-server');
      const resumes = all.filter((e) => e.kind === 'stdin' && e.line?.includes('"method":"thread/resume"'));
      return servers.length >= 2 && resumes.length >= 1 ? { servers, resumes } : undefined;
    }, 'the second app-server and its thread/resume');
    expect(entries.servers.at(-1)?.env?.['CODEX_HOME']).toBe(b.dir);
    expect(entries.resumes.at(-1)?.line).toContain(thread);
    expect(await w.store.providers.nativeId(session.id, 'codex')).toBe(thread);
    expect((await w.store.events.list(session.id)).some((e) => e.label === 'Switched account: Default → Second (usage limit)')).toBe(true);
  });

  it('a rollout that cannot be copied: a new thread on the new account, with the exported chat', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const b = await w.accounts.create({ cli: 'codex', name: 'Second' });
    const session = await w.supervisor.start({ ...newSession({ task: 'codex work' }), provider: 'codex' }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const thread = (await w.store.providers.nativeId(session.id, 'codex')) as string;
    await rm(path.join(w.codexHome, 'sessions'), { recursive: true, force: true });
    await w.supervisor.switchAccount(session.id, b.id, { reason: 'usage limit', handoverDir: handovers(w) });
    await waitForStatus(w.store, session.id, ['idle', 'done']);
    await until(async () => (await w.store.providers.nativeId(session.id, 'codex')) !== thread || undefined, 'a new thread');
    const log = await readFile(w.codexLog, 'utf8');
    expect(log).toContain('Switchboard moved it from the account');
    expect((await readdir(path.join(handovers(w), session.id)))[0]).toMatch(/-codex-to-codex\.md$/);
  });
});

describe('D63 · OpenCode: the D62 handover into a session on the new profile', () => {
  it('starts a new session on the new data folder; its first message points at the exported chat', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const b = await w.accounts.create({ cli: 'opencode', name: 'Second' });
    const session = await w.supervisor.start({ ...newSession({ task: 'opencode work' }), provider: 'opencode' }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const first = (await w.store.providers.nativeId(session.id, 'opencode')) as string;
    await w.supervisor.switchAccount(session.id, b.id, { reason: 'rate limit', handoverDir: handovers(w) });
    await until(async () => {
      const id = await w.store.providers.nativeId(session.id, 'opencode');
      return id !== null && id !== first ? id : undefined;
    }, 'a new OpenCode session');
    const log = (await readFile(w.opencodeLog, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; argv?: string[]; env?: Record<string, string>; body?: { parts?: Array<{ text?: string }> } });
    const serves = log.filter((e) => e.kind === 'argv' && e.argv?.[0] === 'serve');
    expect(serves.at(-1)?.env?.['XDG_DATA_HOME']).toBe(b.dir);
    expect(serves[0]?.env?.['XDG_DATA_HOME']).toBe(w.opencodeData);
    const prompts = log.filter((e) => e.kind === 'prompt');
    expect(prompts.at(-1)?.body?.parts?.[0]?.text).toContain('Switchboard moved it from the account "Default" to "Second"');
    expect((await readdir(path.join(handovers(w), session.id)))[0]).toMatch(/-opencode-to-opencode\.md$/);
    await waitForEvent(w.store, session.id, (e) => e.label === 'Switched account: Default → Second (rate limit)');
  });
});
