import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem, Session, SessionDetail, TerminalSession } from '../../../src/core/api.ts';
import { HOOK_MARKER } from '../../../src/core/hooks.ts';
import { parseRemoteId } from '../../../src/core/peers.ts';
import { HOOK_TOKEN_FILE } from '../../../src/server/token.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';
import { assistantTextLine, lastUuid, terminalUserLine, writeTranscript } from '../../helpers/transcripts.ts';

/**
 * D48 P4 end to end on two real Switchboard processes: machine B hooks into a
 * terminal session running on machine A (a fake: `<A's CLAUDE_CONFIG_DIR>/sessions/<pid>.json`
 * with a live pid + its transcript; fake-claude's `agents --json` lists it) through
 * A's peer API, and **the real hook script** (`src/hook/sb-hook.ts`, run with
 * node) makes the calls the CLI would: install, events, the waiter (exit 2 with
 * the message on stderr), a permission request answered from B.
 */

const SCRIPT = path.join(REPO_ROOT, 'src', 'hook', 'sb-hook.ts');
const CS = '7b6d7a38-aaaa-4bbb-8ccc-0123456789ab';

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('remote-hooks');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

/** Runs the hook script like the CLI would (stdin = the hook input), against `port` with `tokenFile`. */
function runHook(kind: string, port: number, tokenFile: string, input: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, HOOK_MARKER, kind, String(port), tokenFile], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: String(process.pid) } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

/** A hand-started terminal session on `node`: its registry entry (a live pid) and its transcript. */
async function fakeTerminal(node: PeerNode): Promise<{ cwd: string; transcript: string }> {
  const cwd = node.repo as string;
  await mkdir(path.join(node.configDir, 'sessions'), { recursive: true });
  await writeFile(
    path.join(node.configDir, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: CS, cwd, kind: 'interactive', entrypoint: 'cli', startedAt: Date.now() - 60_000, name: 'pc-terminal', status: 'idle' }),
  );
  const lines = [terminalUserLine({ sessionId: CS, cwd, content: 'Refactor the parser.', parentUuid: null, timestamp: '2026-09-29T10:00:00.000Z' })];
  lines.push(assistantTextLine({ sessionId: CS, cwd, text: 'Done: parser split in two.', parentUuid: lastUuid(lines), timestamp: '2026-09-29T10:00:30.000Z' }));
  return { cwd, transcript: await writeTranscript(node.configDir, cwd, CS, lines) };
}

describe('D48 P4 across machines, with the real hook script', () => {
  it('B installs A\'s hooks, hooks into A\'s terminal session, chats and answers a permission; the script wakes the session once', async () => {
    const world = await pairedNodes(tmp);
    nodes.push(world.a, world.b);
    const { a, b, aId } = world;
    const { cwd, transcript } = await fakeTerminal(a);
    const tokenFile = path.join(a.dataDir, HOOK_TOKEN_FILE);
    const port = a.server.port;

    // Install on A from B: only the temp config dir's settings.json changes; the hook token is private.
    const installed = await b.call('POST', `/api/machines/${aId}/api/hooks/install`);
    expect(installed.status).toBe(200);
    expect(installed.body).toMatchObject({ state: 'installed', settingsPath: path.join(a.configDir, 'settings.json') });
    const settings = JSON.parse(await readFile(path.join(a.configDir, 'settings.json'), 'utf8')) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(settings.hooks).sort()).toEqual(['PermissionRequest', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(JSON.stringify(settings)).toContain(SCRIPT.replaceAll('\\', '\\\\'));
    const { stat } = await import('node:fs/promises');
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);

    // The script's first calls (SessionStart): the session reports its transcript.
    expect((await runHook('event', port, tokenFile, { session_id: CS, hook_event_name: 'SessionStart', source: 'startup', cwd, transcript_path: transcript })).code).toBe(0);

    // B lists A's terminal sessions and hooks into this one.
    const listed = await b.call('GET', `/api/machines/${aId}/api/terminal-sessions`);
    expect(listed.status).toBe(200);
    expect((listed.body as TerminalSession[]).map((row) => [row.id, row.name, row.hookSeen])).toEqual([[CS, 'pc-terminal', true]]);
    const hooked = await b.call('POST', `/api/machines/${aId}/api/terminal-sessions/${CS}/hook`);
    expect(hooked.status).toBe(201);
    const session = hooked.body as Session;
    expect(parseRemoteId(session.id)?.machineId).toBe(aId);
    expect(session).toMatchObject({ hooked: true, machine: { id: aId } });
    const detail = (await b.call('GET', `/api/sessions/${encodeURIComponent(session.id)}`)).body as SessionDetail;
    expect(detail.events.map((event) => (event.payload as { text?: string }).text)).toEqual(['Refactor the parser.', 'Done: parser split in two.']);
    await waitFor('B lists it', async () => ((await b.call('GET', '/api/sessions')).body as Session[]).some((entry) => entry.id === session.id));

    // A message from B; A's waiter (the script) takes it once and exits 2 with it on stderr.
    expect((await b.call('POST', `/api/sessions/${encodeURIComponent(session.id)}/messages`, { text: 'Also add a test for empty input.' })).status).toBe(202);
    const woke = await runHook('waiter', port, tokenFile, { session_id: CS, hook_event_name: 'Stop', cwd, transcript_path: transcript });
    expect(woke.code).toBe(2);
    expect(woke.stderr).toContain('Also add a test for empty input.');
    expect(woke.stdout).toBe('');

    // A permission request in A's terminal: B's Inbox has it (Deny with a message offered); B denies with a message.
    const asked = runHook('permission', port, tokenFile, { session_id: CS, hook_event_name: 'PermissionRequest', cwd, transcript_path: transcript, tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
    const item = await waitFor('the permission in B\'s Inbox', async () => ((await b.call('GET', '/api/inbox')).body as InboxItem[]).find((entry) => entry.kind === 'permission') ?? null);
    expect(item.machine?.id).toBe(aId);
    expect(item.permission?.hook).toEqual({ denyMessage: true, alwaysAllow: false });
    expect((await b.call('POST', `/api/inbox/${encodeURIComponent(item.id)}/actions/deny`, { message: 'Keep dist, it is the release.' })).status).toBe(204);
    const answer = await asked;
    expect(answer.code).toBe(0);
    expect(JSON.parse(answer.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Keep dist, it is the release.' } } });

    // Fail-open: a wrong token file or a Switchboard that is down → exit 0, no output (the terminal decides alone).
    const wrong = path.join(tmp, 'wrong-token');
    await writeFile(wrong, 'x'.repeat(43));
    expect(await runHook('permission', port, wrong, { session_id: CS, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} })).toEqual({ code: 0, stdout: '', stderr: '' });
    await a.server.stop();
    expect(await runHook('waiter', port, tokenFile, { session_id: CS, hook_event_name: 'Stop' })).toEqual({ code: 0, stdout: '', stderr: '' });
  });
});
