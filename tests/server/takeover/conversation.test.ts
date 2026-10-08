import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import type { TakeoverPreview, TakeoverRun } from '../../../src/core/takeover.ts';
import { slugForCwd } from '../../../src/core/transcript.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { type PeerNode, waitFor } from '../../helpers/peers.ts';
import { assistantTextLine, lastUuid, terminalUserLine, writeTranscript } from '../../helpers/transcripts.ts';
import { type TakeoverWorld, fakeLog, listFiles, startRepoSession, takeoverWorld , removeWorld } from '../../helpers/takeover.ts';

/**
 * D65: the conversation's four ways over (two real Switchboards, fake CLIs): a
 * hooked terminal session (stopped after the capture, only with the confirmation),
 * Codex (its rollout copied, `thread/resume`; the D62 handover when it is gone),
 * OpenCode (the handover) and the transfer's integrity (checksum, order, names).
 */

let tmp: string;
let world: TakeoverWorld | null = null;
let children: ChildProcess[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('takeover-conversation');
});
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children = [];
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeWorld(tmp);
});

async function run(node: PeerNode, body: Record<string, unknown>): Promise<TakeoverRun> {
  const started = await node.call('POST', '/api/takeover', body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = (started.body as TakeoverRun).id;
  return waitFor('the take-over to end', async () => {
    const current = (await node.call('GET', `/api/takeover/runs/${id}`)).body as TakeoverRun;
    return current.state === 'running' ? null : current;
  }, 90_000);
}

async function remoteHeads(w: TakeoverWorld, remote: string): Promise<string[]> {
  return (await w.git(w.root, 'ls-remote', '--heads', remote)).split('\n').filter((line) => line !== '').map((line) => line.split('\t')[1] as string);
}

async function sessionsOf(node: PeerNode): Promise<Session[]> {
  return (await node.call('GET', '/api/sessions?closed=include')).body as Session[];
}

const CS = '5d3a7a38-aaaa-4bbb-8ccc-0123456789ab';

describe('D65: a hooked terminal session', () => {
  it('asks for the confirmation, then stops the terminal\'s claude after the capture and continues the conversation in Switchboard', async () => {
    const w = (world = await takeoverWorld(tmp));
    const cwd = w.paths.a.alpha;
    // A's hand-started terminal session: a live process (the registry entry names its pid) and a transcript with a finished turn.
    const terminal = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', shell: false });
    children.push(terminal);
    const exited = new Promise<string>((resolve) => terminal.once('exit', (code, signal) => resolve(signal ?? String(code))));
    await mkdir(path.join(w.a.configDir, 'sessions'), { recursive: true });
    await writeFile(
      path.join(w.a.configDir, 'sessions', `${terminal.pid}.json`),
      JSON.stringify({ pid: terminal.pid, sessionId: CS, cwd, kind: 'interactive', entrypoint: 'cli', startedAt: Date.now() - 60_000, name: 'pc-terminal', status: 'idle' }),
    );
    const lines = [terminalUserLine({ sessionId: CS, cwd, content: 'Refactor the parser.', parentUuid: null, timestamp: new Date(Date.now() - 50_000).toISOString() })];
    lines.push(assistantTextLine({ sessionId: CS, cwd, text: 'Parser split in two.', parentUuid: lastUuid(lines), timestamp: new Date(Date.now() - 40_000).toISOString() }));
    await writeTranscript(w.a.configDir, cwd, CS, lines);
    const hooked = await w.a.call('POST', `/api/terminal-sessions/${CS}/hook`);
    expect(hooked.status, JSON.stringify(hooked.body)).toBe(201);
    const id = (hooked.body as Session).id;
    await writeFile(path.join(cwd, 'tracked.txt'), 'edited in the terminal session\n');

    // The preview says the terminal is stopped (the dialog asks for the confirmation).
    const preview = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, id) })).body as TakeoverPreview;
    expect(preview.ok, JSON.stringify(preview.blockers)).toBe(true);
    expect(preview).toMatchObject({ stopsTerminal: true, source: { hooked: true, terminalPid: terminal.pid, provider: 'claude' } });
    // Without the confirmation nothing happens: no push, the terminal is untouched.
    const refused = await run(w.b, { sessionId: remoteId(w.aId, id) });
    expect(refused).toMatchObject({ state: 'failed', error: { step: 'checks' }, rolledBack: null });
    expect(refused.error?.message).toContain('confirm');
    expect(await remoteHeads(w, w.remotes.alpha)).toEqual(['refs/heads/main']);
    expect(terminal.exitCode).toBeNull();

    const finished = await run(w.b, { sessionId: remoteId(w.aId, id), confirmStopTerminal: true });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    expect(finished.state).toBe('done');
    // The terminal's process was stopped (SIGTERM), after the capture's push.
    expect(await exited).toBe('SIGTERM');
    const log = finished.log.join('\n');
    expect(log.indexOf('commit-tree')).toBeGreaterThan(-1);
    expect(log.indexOf("stopped the terminal's claude")).toBeGreaterThan(log.indexOf('push origin +'));
    // Continued here as a Switchboard-run session of the same conversation, with the work restored.
    const created = (await sessionsOf(w.b)).find((session) => session.movedFrom?.sessionId === id) as Session;
    expect(created).toMatchObject({ claudeSessionId: CS, hooked: false, origin: 'terminal', cwd: w.paths.b.alpha });
    expect(await readFile(path.join(w.paths.b.alpha, 'tracked.txt'), 'utf8')).toBe('edited in the terminal session\n');
    const transcript = path.join(w.b.configDir, 'projects', slugForCwd(w.paths.b.alpha), `${CS}.jsonl`);
    expect((await stat(transcript)).size).toBeGreaterThan(0);
    const detail = (await w.b.call('GET', `/api/sessions/${created.id}/events`)).body as Array<{ payload: { text?: string } | null }>;
    expect(detail.map((event) => event.payload?.text).filter(Boolean)).toEqual(expect.arrayContaining(['Refactor the parser.', 'Parser split in two.']));
    // The old (hooked) session is closed and marked moved.
    const old = (await w.a.call('GET', `/api/sessions/${id}`)).body as Session;
    expect(old).toMatchObject({ hooked: true, movedTo: { machineId: w.bId, sessionId: created.id } });
    expect(old.closedAt).not.toBeNull();
  }, 120_000);
});

/** The thread id a Codex session on `node` is on (its rollout file's name), via the fake's log of `thread/start`. */
async function rolloutsOf(home: string): Promise<string[]> {
  return (await listFiles(path.join(home, 'sessions'))).filter((file) => file.includes('rollout-'));
}

describe('D65: Codex and OpenCode sessions', () => {
  it('Codex: the rollout is copied into the target\'s CODEX_HOME and the thread is resumed there', async () => {
    const w = (world = await takeoverWorld(tmp));
    const created = await w.a.call('POST', '/api/sessions', { name: 'codex-work', task: 'Reply with just OK.', folder: w.folders.a.alpha, worktrees: false, ultracode: false, provider: 'codex' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const started = created.body as Session;
    await waitFor('the Codex turn', async () => ['idle', 'done'].includes(((await w.a.call('GET', `/api/sessions/${started.id}`)).body as Session).status));
    const homeA = path.join(w.root, 'a', 'codex-home');
    const homeB = path.join(w.root, 'b', 'codex-home');
    const rolloutA = await waitFor('the rollout', async () => (await rolloutsOf(homeA))[0]);
    expect(await rolloutsOf(homeB)).toEqual([]);
    await writeFile(path.join(w.paths.a.alpha, 'tracked.txt'), 'codex edit\n');

    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    expect(await rolloutsOf(homeB)).toEqual([rolloutA]);
    // The copy starts with the rollout as it was (the resumed thread appended to it since).
    expect((await readFile(path.join(homeB, 'sessions', rolloutA), 'utf8')).startsWith(await readFile(path.join(homeA, 'sessions', rolloutA), 'utf8'))).toBe(true);
    const moved = (await sessionsOf(w.b)).find((session) => session.movedFrom?.sessionId === started.id) as Session;
    expect(moved).toMatchObject({ provider: 'codex', cwd: w.paths.b.alpha });
    // The fake Codex on the mac reopened the thread (thread/resume) instead of starting a new one.
    const threadId = rolloutA.slice(rolloutA.lastIndexOf('-') + 1).replace(/\.jsonl$/, '');
    const rpc = await waitFor('the first message reached Codex', async () => {
      const text = (await fakeLog(path.join(w.root, 'b-fake-codex.log'))).map((entry) => JSON.stringify(entry)).join('\n');
      return text.includes('This session moved from') ? text : null;
    });
    expect(rpc).toContain('thread/resume');
    expect(rpc).toContain(threadId);
    expect(await readFile(path.join(w.paths.b.alpha, 'tracked.txt'), 'utf8')).toBe('codex edit\n');
  }, 120_000);

  it('Codex without its rollout falls back to the D62 handover: the chat is exported and the new agent reads it', async () => {
    const w = (world = await takeoverWorld(tmp));
    const created = await w.a.call('POST', '/api/sessions', { name: 'codex-gone', task: 'Reply with just OK.', folder: w.folders.a.alpha, worktrees: false, ultracode: false, provider: 'codex' });
    const started = created.body as Session;
    await waitFor('the Codex turn', async () => ['idle', 'done'].includes(((await w.a.call('GET', `/api/sessions/${started.id}`)).body as Session).status));
    const homeA = path.join(w.root, 'a', 'codex-home');
    const rolloutA = await waitFor('the rollout', async () => (await rolloutsOf(homeA))[0]);
    const { rm } = await import('node:fs/promises');
    await rm(path.join(homeA, 'sessions', rolloutA));
    const preview = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, started.id) })).body as TakeoverPreview;
    expect(preview.source.conversation.kind).toBe('handover');

    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    // The old thread's rollout was gone, so nothing was copied (a new thread's own rollout may exist by now).
    expect(await rolloutsOf(path.join(w.root, 'b', 'codex-home'))).not.toContain(rolloutA);
    const handovers = path.join(w.b.dataDir, 'handovers');
    const exports = await listFiles(handovers);
    expect(exports).toHaveLength(1);
    expect(await readFile(path.join(handovers, exports[0] as string), 'utf8')).toContain('the chat so far');
    const rpc = await waitFor('the first message reached Codex', async () => {
      const text = (await fakeLog(path.join(w.root, 'b-fake-codex.log'))).map((entry) => JSON.stringify(entry)).join('\n');
      return text.includes('could not be carried over') ? text : null;
    });
    expect(rpc).not.toContain('thread/resume');
    // The chat so far was imported as the new session's events.
    const moved = (await sessionsOf(w.b)).find((session) => session.movedFrom?.sessionId === started.id) as Session;
    const events = (await w.b.call('GET', `/api/sessions/${moved.id}/events`)).body as Array<{ payload: { text?: string } | null }>;
    expect(events.some((event) => event.payload?.text === 'Reply with just OK.')).toBe(true);
  }, 120_000);

  it('OpenCode: the D62 handover (its storage cannot be copied)', async () => {
    const w = (world = await takeoverWorld(tmp));
    const created = await w.a.call('POST', '/api/sessions', { name: 'opencode-work', task: 'Reply with just OK.', folder: w.folders.a.alpha, worktrees: false, ultracode: false, provider: 'opencode' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const started = created.body as Session;
    await waitFor('the OpenCode turn', async () => ['idle', 'done'].includes(((await w.a.call('GET', `/api/sessions/${started.id}`)).body as Session).status));
    const preview = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, started.id) })).body as TakeoverPreview;
    expect(preview.source.conversation).toMatchObject({ kind: 'handover', files: [] });
    expect(preview.source.conversation.note).toContain('cannot be copied');

    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    const moved = (await sessionsOf(w.b)).find((session) => session.movedFrom?.sessionId === started.id) as Session;
    expect(moved).toMatchObject({ provider: 'opencode', cwd: w.paths.b.alpha });
    expect((await listFiles(path.join(w.b.dataDir, 'handovers'))).length).toBe(1);
    const old = (await w.a.call('GET', `/api/sessions/${started.id}`)).body as Session;
    expect(old.movedTo).toMatchObject({ machineId: w.bId, sessionId: moved.id });
  }, 120_000);
});

describe('D65: the conversation transfer', () => {
  it('checks the size and the checksum, keeps chunks in order and refuses names that leave the folder', async () => {
    const w = (world = await takeoverWorld(tmp));
    const op = 'op-test-1';
    const payload = Buffer.from('line one\nline two\n');
    const sha = createHash('sha256').update(payload).digest('hex');
    const send = (body: Record<string, unknown>) => w.b.call('POST', '/api/takeover/target/chunk', { opId: op, name: 'file.jsonl', size: payload.length, sha256: sha, offset: 0, data: payload.toString('base64'), ...body });
    // Valid: one chunk, checksum matches.
    expect(await send({})).toMatchObject({ status: 200, body: { received: payload.length, done: true } });
    const staged = path.join(w.b.dataDir, 'takeover', op, 'files', 'file.jsonl');
    expect(await readFile(staged, 'utf8')).toBe('line one\nline two\n');
    // A damaged file is refused and nothing is kept.
    const damaged = await send({ name: 'bad.jsonl', sha256: '0'.repeat(64) });
    expect(damaged).toMatchObject({ status: 422, body: { error: 'checksum' } });
    await expect(stat(path.join(w.b.dataDir, 'takeover', op, 'files', 'bad.jsonl'))).rejects.toThrow();
    // Names that leave the folder, absolute names, Windows drive names.
    for (const name of ['../escape.jsonl', '/etc/passwd', 'a/../../b', 'C:\\x', 'a\\b', '', 'a//b']) {
      expect((await send({ name })).status, name).toBe(422);
    }
    // Chunks must arrive in order and not exceed the announced size.
    const big = Buffer.alloc(10, 1);
    const bigSha = createHash('sha256').update(big).digest('hex');
    expect((await w.b.call('POST', '/api/takeover/target/chunk', { opId: op, name: 'two.bin', size: 10, sha256: bigSha, offset: 4, data: big.subarray(0, 4).toString('base64') })).status).toBe(409);
    expect((await w.b.call('POST', '/api/takeover/target/chunk', { opId: op, name: 'two.bin', size: 5, sha256: bigSha, offset: 0, data: big.toString('base64') })).status).toBe(422);
    const first = await w.b.call('POST', '/api/takeover/target/chunk', { opId: op, name: 'two.bin', size: 10, sha256: bigSha, offset: 0, data: big.subarray(0, 4).toString('base64') });
    expect(first.body).toMatchObject({ received: 4, done: false });
    const second = await w.b.call('POST', '/api/takeover/target/chunk', { opId: op, name: 'two.bin', size: 10, sha256: bigSha, offset: 4, data: big.subarray(4).toString('base64') });
    expect(second.body).toMatchObject({ received: 10, done: true });
    // The size cap (200 MB) is announced up front.
    expect((await w.b.call('POST', '/api/takeover/target/chunk', { opId: op, name: 'huge.bin', size: 201 * 1024 * 1024, sha256: sha, offset: 0, data: '' })).status).toBe(413);
    // The staging folder goes with the operation.
    expect((await w.b.call('POST', '/api/takeover/target/abort', { opId: op })).status).toBe(200);
    expect(await readdir(path.join(w.b.dataDir, 'takeover')).catch(() => [])).toEqual([]);
    // Source side: no such operation / file.
    expect((await w.a.call('POST', '/api/takeover/source/chunk', { opId: op, name: 'x', offset: 0 })).status).toBe(404);
  }, 60_000);

  it('copies a transcript with its subagents folder, byte for byte, in more than one chunk', async () => {
    const w = (world = await takeoverWorld(tmp));
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'big-transcript');
    // Pad the transcript past one chunk and give it a subagents folder.
    const transcript = path.join(w.a.configDir, 'projects', slugForCwd(w.paths.a.alpha), `${started.claudeSessionId}.jsonl`);
    const original = await readFile(transcript, 'utf8');
    const filler = `${JSON.stringify({ type: 'summary', summary: 'x'.repeat(1000), leafUuid: 'padding' })}\n`.repeat(700);
    await writeFile(transcript, original + filler);
    const sub = path.join(path.dirname(transcript), started.claudeSessionId, 'subagents');
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, 'agent-1.jsonl'), '{"type":"summary","summary":"sub","leafUuid":"s"}\n');
    expect((await stat(transcript)).size).toBeGreaterThan(512 * 1024);

    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    const target = path.join(w.b.configDir, 'projects', slugForCwd(w.paths.b.alpha));
    const sha = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex');
    // Byte for byte: the copy starts with the whole source transcript (the session resumed on the target may
    // already have appended its own lines after the copied ones: a race D80's timing change made visible).
    const copied = await readFile(path.join(target, `${started.claudeSessionId}.jsonl`));
    const source = await readFile(transcript);
    expect(copied.length).toBeGreaterThanOrEqual(source.length);
    expect(createHash('sha256').update(copied.subarray(0, source.length)).digest('hex')).toBe(await sha(transcript));
    expect(await readFile(path.join(target, started.claudeSessionId, 'subagents', 'agent-1.jsonl'), 'utf8')).toBe('{"type":"summary","summary":"sub","leafUuid":"s"}\n');
    expect(finished.steps.find((step) => step.id === 'transfer')?.detail).toMatch(/2 files/);
    // The source's own transcript is still there (it is copied, never moved).
    expect((await stat(transcript)).size).toBeGreaterThan(Buffer.byteLength(original + filler) - 1);
  }, 120_000);
});
