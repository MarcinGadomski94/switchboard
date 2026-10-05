import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, SessionEvent } from '../../../src/core/api.ts';
import { CONTINUED_DIVIDER } from '../../../src/core/hooked-continue.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { HOOK_TOKEN_FILE } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, startPeerNode, waitFor } from '../../helpers/peers.ts';
import { fakeLog } from '../../helpers/takeover.ts';
import { assistantTextLine, lastUuid, terminalUserLine, writeTranscript } from '../../helpers/transcripts.ts';

/**
 * D72 "Continue in Switchboard" for hooked sessions, over real Switchboard
 * processes (fake CLIs): a stand-in terminal `claude` (a node process whose
 * registry entry `<config>/sessions/<pid>.json` names the conversation, as the
 * fake's `agents --json` reads it), a transcript, hook calls with the hook token.
 * Gone terminal → converted in place; running → 409 until confirmed, then stopped
 * and continued (waiter and held permission released); the mailbox → sent to the
 * new process; a message handed to the terminal that never reached it → not sent,
 * with Resend; a closed hooked session → reopened, then converted; not hooked →
 * 409; a paired machine's hooked session continued through the peer API.
 */

const CS = '7c1d2e3f-aaaa-4bbb-8ccc-0123456789ab';

let tmp: string;
let nodes: PeerNode[] = [];
let children: ChildProcess[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('hooked-continue');
});
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

/** A hand-started terminal session on `node`: a live stand-in process, its registry entry and a transcript with one finished turn. */
async function terminalOn(node: PeerNode): Promise<{ readonly terminal: ChildProcess; readonly exited: Promise<string>; readonly cwd: string; readonly transcript: string }> {
  const cwd = node.repo as string;
  const terminal = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', shell: false });
  children.push(terminal);
  const exited = new Promise<string>((resolve) => terminal.once('exit', (code, signal) => resolve(signal ?? String(code))));
  await mkdir(path.join(node.configDir, 'sessions'), { recursive: true });
  await writeFile(
    path.join(node.configDir, 'sessions', `${terminal.pid}.json`),
    JSON.stringify({ pid: terminal.pid, sessionId: CS, cwd, kind: 'interactive', entrypoint: 'cli', startedAt: Date.now() - 60_000, name: 'pc-terminal', status: 'idle' }),
  );
  const lines = [terminalUserLine({ sessionId: CS, cwd, content: 'Refactor the parser.', parentUuid: null, timestamp: new Date(Date.now() - 50_000).toISOString() })];
  lines.push(assistantTextLine({ sessionId: CS, cwd, text: 'Parser split in two.', parentUuid: lastUuid(lines), timestamp: new Date(Date.now() - 40_000).toISOString() }));
  const transcript = await writeTranscript(node.configDir, cwd, CS, lines);
  return { terminal, exited, cwd, transcript };
}

async function hookIn(node: PeerNode): Promise<Session> {
  const hooked = await node.call('POST', `/api/terminal-sessions/${CS}/hook`);
  expect(hooked.status, JSON.stringify(hooked.body)).toBe(201);
  return hooked.body as Session;
}

/** A hook script's call to `node` for the terminal session (`kind`), with `event` as the hook input. */
async function hookCall(node: PeerNode, kind: 'event' | 'permission' | 'waiter', event: Record<string, unknown>, claudePid: number): Promise<{ status: number; body: unknown }> {
  const token = (await readFile(path.join(node.dataDir, HOOK_TOKEN_FILE), 'utf8')).trim();
  const response = await fetch(`${node.baseUrl}/hook/v1/${kind}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event: { session_id: CS, ...event }, claudePid, entrypoint: 'cli' }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

async function events(node: PeerNode, id: string): Promise<SessionEvent[]> {
  return (await node.call('GET', `/api/sessions/${id}/events`)).body as SessionEvent[];
}

function lifecycle(list: readonly SessionEvent[], action: string): SessionEvent[] {
  return list.filter((event) => (event.payload as { type?: string; action?: string } | null)?.type === 'lifecycle' && (event.payload as { action?: string }).action === action);
}

/** The fake claude's runs on `node` that resumed the conversation: their argv and stdin lines. */
async function resumedRuns(log: string): Promise<{ readonly argv: string[][]; readonly stdin: string[] }> {
  const entries = await fakeLog(log);
  return {
    argv: entries.filter((entry) => entry['kind'] === 'argv' && (entry['argv'] as string[]).includes('--resume')).map((entry) => entry['argv'] as string[]),
    stdin: entries.filter((entry) => entry['kind'] === 'stdin').map((entry) => String(entry['line'])),
  };
}

describe('D72: Continue in Switchboard of a hooked session (this machine)', () => {
  it('terminal gone: the same session becomes a Switchboard-run one (--resume with the injections, todos kept, divider); the queued message goes to the new process; then it is not hooked any more', async () => {
    const log = path.join(tmp, 'fake-claude.log');
    const node = await startPeerNode(tmp, 'a', { repo: true, env: { FAKE_CLAUDE_LOG: log } });
    nodes.push(node);
    const { terminal, exited, cwd } = await terminalOn(node);
    const hooked = await hookIn(node);
    expect(hooked).toMatchObject({ hooked: true, origin: 'terminal' });
    const todo = await node.call('POST', `/api/sessions/${hooked.id}/todos`, { title: 'Write the parser tests', plan: 'No plan: a one-line follow-up' });
    expect(todo.status, JSON.stringify(todo.body)).toBe(201);
    // A message from Switchboard waits in the mailbox (no waiter is armed).
    const sent = await node.call('POST', `/api/sessions/${hooked.id}/messages`, { text: 'Also rename the module.' });
    expect(sent.status).toBe(202);

    // The developer closed the terminal window: the process is gone.
    terminal.kill('SIGKILL');
    await exited;
    await waitFor('the registry to drop it', async () => ((await node.call('GET', '/api/terminal-sessions')).body as unknown[]).length === 0);

    const continued = await node.call('POST', `/api/sessions/${hooked.id}/continue-in-switchboard`, {});
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    const session = continued.body as Session;
    expect(session).toMatchObject({ id: hooked.id, name: hooked.name, title: hooked.title, claudeSessionId: CS, hooked: false, attached: true, origin: 'terminal', cwd });
    expect(session.hookStatus).toBeUndefined();

    // The fake claude was started with --resume <id> in its cwd, with the standing instruction and the todo MCP tools.
    const runs = await waitFor('the resumed process and its message', async () => {
      const read = await resumedRuns(log);
      return read.argv.length > 0 && read.stdin.some((line) => line.includes('Also rename the module.')) ? read : null;
    });
    expect(runs.argv).toHaveLength(1);
    const argv = runs.argv[0] as string[];
    expect(argv[argv.indexOf('--resume') + 1]).toBe(CS);
    expect(argv).toContain('--append-system-prompt');
    expect(argv).toContain('--mcp-config');
    expect((await fakeLog(log)).find((entry) => entry['kind'] === 'argv' && (entry['argv'] as string[]).includes('--resume'))?.['cwd']).toBe(cwd);

    // Same chat with the divider; the old waiting bubble gave way to the one the new process got.
    const list = await events(node, hooked.id);
    expect(lifecycle(list, 'continued').map((event) => event.label)).toEqual([CONTINUED_DIVIDER]);
    const texts = list.filter((event) => (event.payload as { type?: string } | null)?.type === 'user');
    expect(texts.map((event) => (event.payload as { text: string }).text)).toEqual(['Refactor the parser.', 'Also rename the module.', 'Also rename the module.']);
    const [, old, fresh] = texts;
    expect(old?.payload).toMatchObject({ withdrawn: true });
    expect((fresh?.id ?? 0) > (lifecycle(list, 'continued')[0]?.id ?? Infinity)).toBe(true);
    expect(fresh?.payload).not.toHaveProperty('withdrawn');
    // Its todo list is the same list.
    const todos = (await node.call('GET', `/api/sessions/${hooked.id}/todos`)).body as { todos: Array<{ title: string }> };
    expect(todos.todos.map((item) => item.title)).toEqual(['Write the parser tests']);

    // A Switchboard-run session now: Pause works, a second continue is refused.
    await waitFor('the turn to end', async () => ['idle', 'done'].includes(((await node.call('GET', `/api/sessions/${hooked.id}`)).body as Session).status));
    const again = await node.call('POST', `/api/sessions/${hooked.id}/continue-in-switchboard`, {});
    expect(again).toMatchObject({ status: 409, body: { error: 'not-hooked' } });
    const paused = await node.call('POST', `/api/sessions/${hooked.id}/pause`);
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
  }, 90_000);

  it('terminal running: 409 terminal-running without the confirmation (nothing changes); confirmed: the terminal is stopped, its waiter and held permission are released, then it continues', async () => {
    const log = path.join(tmp, 'fake-claude.log');
    const node = await startPeerNode(tmp, 'a', { repo: true, env: { FAKE_CLAUDE_LOG: log } });
    nodes.push(node);
    const { terminal, exited, cwd, transcript } = await terminalOn(node);
    const pid = terminal.pid as number;
    const hooked = await hookIn(node);
    // The terminal's hooks: a turn ended (a waiter is armed) and a permission request is held.
    expect((await hookCall(node, 'event', { hook_event_name: 'Stop', cwd, transcript_path: transcript }, pid)).status).toBe(204);
    const waiter = hookCall(node, 'waiter', { hook_event_name: 'Stop', cwd, transcript_path: transcript }, pid);
    const permission = hookCall(node, 'permission', { hook_event_name: 'PermissionRequest', cwd, transcript_path: transcript, tool_name: 'Bash', tool_input: { command: 'ls' } }, pid);
    await waitFor('the held permission in the Inbox', async () => ((await node.call('GET', '/api/inbox')).body as Array<{ sessionId?: string }>).some((item) => item.sessionId === hooked.id));

    const refused = await node.call('POST', `/api/sessions/${hooked.id}/continue-in-switchboard`, {});
    expect(refused).toMatchObject({ status: 409, body: { error: 'terminal-running', pid } });
    expect(terminal.exitCode).toBeNull();
    expect(((await node.call('GET', `/api/sessions/${hooked.id}`)).body as Session).hooked).toBe(true);

    const continued = await node.call('POST', `/api/sessions/${hooked.id}/continue-in-switchboard`, { confirmStopTerminal: true });
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    expect(await exited).toBe('SIGTERM');
    expect(continued.body).toMatchObject({ id: hooked.id, hooked: false, attached: true });
    // The waiter got the explicit stop, the held permission no decision.
    expect(await waiter).toMatchObject({ status: 204 });
    expect(await permission).toMatchObject({ status: 204 });
    await waitFor('the resumed process', async () => (await resumedRuns(log)).argv.length === 1);
    expect(lifecycle(await events(node, hooked.id), 'continued')).toHaveLength(1);
  }, 90_000);

  it('a message handed to the terminal that never reached it shows as not sent (not re-sent by itself); Resend queues it to the now Switchboard-run session', async () => {
    const log = path.join(tmp, 'fake-claude.log');
    const node = await startPeerNode(tmp, 'a', { repo: true, env: { FAKE_CLAUDE_LOG: log } });
    nodes.push(node);
    const { terminal, exited, cwd, transcript } = await terminalOn(node);
    const pid = terminal.pid as number;
    const hooked = await hookIn(node);
    // A turn ended, a waiter is armed: the message is handed to it at once (the CLI would wake on it).
    expect((await hookCall(node, 'event', { hook_event_name: 'Stop', cwd, transcript_path: transcript }, pid)).status).toBe(204);
    const waiter = hookCall(node, 'waiter', { hook_event_name: 'Stop', cwd, transcript_path: transcript }, pid);
    expect((await node.call('POST', `/api/sessions/${hooked.id}/messages`, { text: 'Handed over, never seen.' })).status).toBe(202);
    expect(await waiter).toMatchObject({ status: 200 });
    // …but the terminal ends before it takes it up (no transcript copy).
    terminal.kill('SIGKILL');
    await exited;
    await waitFor('the registry to drop it', async () => ((await node.call('GET', '/api/terminal-sessions')).body as unknown[]).length === 0);

    const continued = await node.call('POST', `/api/sessions/${hooked.id}/continue-in-switchboard`, {});
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    await waitFor('the resumed process', async () => (await resumedRuns(log)).argv.length === 1);
    const handed = (await events(node, hooked.id)).find((event) => (event.payload as { text?: string } | null)?.text === 'Handed over, never seen.') as SessionEvent;
    expect(handed.payload).toMatchObject({ notSent: true, delivered: false });
    expect(handed.payload).not.toHaveProperty('queued');
    expect(handed.payload).not.toHaveProperty('withdrawn');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await resumedRuns(log)).stdin.some((line) => line.includes('Handed over, never seen.'))).toBe(false);

    // Resend: queued to the session; the old bubble gives way to the new one; a second Resend is refused.
    expect((await node.call('POST', `/api/sessions/${hooked.id}/events/${handed.id}/resend`, {})).status).toBe(202);
    await waitFor('the resent message at the process', async () => (await resumedRuns(log)).stdin.some((line) => line.includes('Handed over, never seen.')));
    const after = (await events(node, hooked.id)).filter((event) => (event.payload as { text?: string } | null)?.text === 'Handed over, never seen.');
    expect(after.map((event) => [(event.payload as { withdrawn?: boolean }).withdrawn ?? false, (event.payload as { notSent?: boolean }).notSent ?? false])).toEqual([[true, false], [false, false]]);
    expect(await node.call('POST', `/api/sessions/${hooked.id}/events/${handed.id}/resend`, {})).toMatchObject({ status: 409, body: { error: 'not-resendable' } });
  }, 90_000);

  it('a closed (unhooked) hooked session: continuing reopens it (D33), then converts it', async () => {
    const node = await startPeerNode(tmp, 'a', { repo: true });
    nodes.push(node);
    const { terminal, exited } = await terminalOn(node);
    const hooked = await hookIn(node);
    const closed = await node.call('POST', `/api/sessions/${hooked.id}/close`, { confirm: true });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((closed.body as Session).closedAt).not.toBeNull();
    terminal.kill('SIGKILL');
    await exited;
    await waitFor('the registry to drop it', async () => ((await node.call('GET', '/api/terminal-sessions')).body as unknown[]).length === 0);

    const continued = await node.call('POST', `/api/sessions/${hooked.id}/continue-in-switchboard`, {});
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    expect(continued.body).toMatchObject({ id: hooked.id, hooked: false, attached: true, closedAt: null });
    const list = await events(node, hooked.id);
    expect(lifecycle(list, 'reopened')).toHaveLength(1);
    expect(lifecycle(list, 'continued')).toHaveLength(1);
    expect((lifecycle(list, 'reopened')[0]?.id ?? 0) < (lifecycle(list, 'continued')[0]?.id ?? 0)).toBe(true);
  }, 60_000);

  it('a session that is not hooked: 409 not-hooked; an invalid body: 422', async () => {
    const node = await startPeerNode(tmp, 'a', { repo: true });
    nodes.push(node);
    const started = await node.call('POST', '/api/sessions', { name: 'plain', task: 'Reply with just OK.', folder: node.folderId, worktrees: false, ultracode: false });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const id = (started.body as Session).id;
    expect(await node.call('POST', `/api/sessions/${id}/continue-in-switchboard`, {})).toMatchObject({ status: 409, body: { error: 'not-hooked' } });
    expect(await node.call('POST', `/api/sessions/${id}/continue-in-switchboard`, { confirmStopTerminal: 'yes' })).toMatchObject({ status: 422 });
    expect(await node.call('POST', '/api/sessions/nope/continue-in-switchboard', {})).toMatchObject({ status: 404 });
  }, 60_000);
});

describe('D72: a paired machine\'s hooked session', () => {
  it('runs on that machine through the peer API (remote id): confirmation, stop, continue', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const { exited } = await terminalOn(a);
    const hooked = await hookIn(a);
    const remote = remoteId(aId, hooked.id);
    const refused = await b.call('POST', `/api/sessions/${remote}/continue-in-switchboard`, {});
    expect(refused).toMatchObject({ status: 409, body: { error: 'terminal-running' } });
    const continued = await b.call('POST', `/api/sessions/${remote}/continue-in-switchboard`, { confirmStopTerminal: true });
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    expect(continued.body).toMatchObject({ id: remote, hooked: false, machine: { id: aId } });
    expect(await exited).toBe('SIGTERM');
    // It runs on A, as A's own session.
    const onA = (await a.call('GET', `/api/sessions/${hooked.id}`)).body as Session;
    expect(onA).toMatchObject({ hooked: false, attached: true });
    expect(lifecycle(await events(a, hooked.id), 'continued')).toHaveLength(1);
  }, 120_000);
});
