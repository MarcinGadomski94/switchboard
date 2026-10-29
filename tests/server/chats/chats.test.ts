import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { CHAT_DISALLOWED_TOOLS, chatTitleFromMessage } from '../../../src/core/chats.ts';
import type { SearchAnswer } from '../../../src/core/search.ts';
import { buildApp } from '../../../src/server/app.ts';
import { chatScratchDir } from '../../../src/server/chats/start.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { type HubMessage, HubBus } from '../../../src/server/hub/bus.ts';
import type { SessionRecord } from '../../../src/server/db/repos/sessions.ts';
import { PEER_API_ALLOW } from '../../../src/server/peers/service.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { computeSuggestions } from '../../../src/server/team/suggestions.ts';
import { generateToken } from '../../../src/server/token.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { AGENT_SESSION_HEADER } from '../../../src/core/todos.ts';
import { freeTestPorts } from '../../helpers/net.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, spawnedArgv, stdinOf, until, waitForEvent, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D106 · chats (`docs/chats.md`): a chat starts in its own scratch folder in plan
 * mode with its own instruction (no workspace AGENTS.md, no router questions), its
 * edits are not offered / refused, it stays in plan mode, reads the folders it
 * looks at, keeps the switchboard MCP tools, is titled from its first message, is
 * left out of Team suggestions / Plans / Solutions, is deleted with its scratch
 * folder and is continued as a session. Through the real routes and fake-claude.
 */

const PORT = 4962; // inject() opens no socket; the port feeds the Host check only

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';
/** The port of a listening app (the D106 follow-up's tests); the others inject on {@link PORT}. */
let currentPort = PORT;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
/** What the hub published (the rename test reads `sessionUpdated`). */
let published: HubMessage[] = [];

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
  currentPort = PORT;
});

async function setup(): Promise<{ w: SupervisorWorld; folderId: string }> {
  world = await makeSupervisorWorld({ standingInstruction: true });
  const w = world;
  token = generateToken();
  // The workspace folder has an AGENTS.md router: a chat never sees it (its cwd is its scratch folder).
  await writeFile(path.join(w.workspace, 'AGENTS.md'), '# Router\nAsk the session-start questions first.\n');
  const folder = await seedFolder(w.store, w.workspace);
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  const bus = new HubBus();
  published = [];
  bus.subscribe((message) => published.push(message));
  app = await buildApp({ config: { ...base, port: PORT }, token, store: w.store, webRoot: w.root, supervisor: w.supervisor, bus });
  await app.ready();
  return { w, folderId: folder.id };
}

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: `127.0.0.1:${currentPort}`, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function startChat(body: Record<string, unknown>): Promise<Session> {
  const answer = await call('POST', '/api/chats', body);
  expect(answer.statusCode, answer.body).toBe(201);
  return answer.json() as Session;
}

function flag(argv: readonly string[], name: string): string[] {
  return argv.flatMap((arg, i) => (arg === name && argv[i + 1] !== undefined ? [argv[i + 1] as string] : []));
}

describe('D106 · chats', () => {
  it('starts in its own scratch folder, in plan mode, with the chat instruction (no AGENTS.md, no router questions), the editors disallowed, the MCP tools and a title from the first message', async () => {
    const { w } = await setup();
    const chat = await startChat({ message: '## How should we split the billing module?\nSome context.' });
    expect(chat.kind).toBe('chat');
    expect(chat.title).toBe('How should we split the billing module?');
    expect(chat.lookAt).toEqual([]);
    const scratch = chatScratchDir(w.root, chat.id);
    expect(chat.cwd).toBe(scratch);
    expect(await readdir(scratch)).toEqual([]);
    expect(chat.folder).toBeNull();
    expect(chat.solutions).toEqual([]);
    await waitForStatus(w.store, chat.id, ['done']);

    const record = (await w.store.sessions.get(chat.id)) as SessionRecord;
    expect(record).toMatchObject({ kind: 'chat', requestedPermissionMode: 'plan', observedPermissionMode: 'plan', worktrees: false, folderId: null });
    const spawn = (await spawnedArgv(w.logFile)).find((line) => line.argv?.includes(record.claudeSessionId));
    const argv = spawn?.argv ?? [];
    expect(flag(argv, '--permission-mode')).toEqual(['plan']);
    expect(flag(argv, '--disallowedTools')).toEqual([CHAT_DISALLOWED_TOOLS.join(',')]);
    expect(flag(argv, '--disallowedTools')[0]?.split(',')).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit', 'ExitPlanMode', 'Bash', 'BashOutput', 'KillShell', 'PowerShell', 'REPL']));
    expect(flag(argv, '--add-dir')).toEqual([]);
    // The switchboard MCP server stays (todos, artifacts, plans when on), with the web tools allowed next to it.
    expect(flag(argv, '--mcp-config')).toHaveLength(1);
    expect(flag(argv, '--allowedTools')).toEqual(['mcp__switchboard,WebFetch,WebSearch']);
    // Its own instruction, not the standing instruction (which is on in this world) nor the workspace's router.
    const instruction = flag(argv, '--append-system-prompt')[0] ?? '';
    expect(instruction).toContain('This is a Switchboard chat');
    expect(instruction).toContain('You run in plan mode and stay there');
    expect(instruction).toContain('artifact_save');
    expect(instruction).not.toContain('loop_create');
    expect(instruction).toContain('You have no shell');
    expect(instruction).not.toContain('session-start questions');
    // The first message is the developer's text only (no router answers block, no worktree note).
    const first = (await stdinOf(w.logFile, spawn?.pid ?? -1)).find((line) => line['type'] === 'user');
    expect(JSON.stringify(first)).toContain('How should we split the billing module?');
    expect(JSON.stringify(first)).not.toContain('Session start');
  });

  it('edits are not offered, and anything that asks permission is refused at once (never reaches the Inbox)', async () => {
    const { w } = await setup();
    const chat = await startChat({ message: 'Write it down. [fake:write notes.md]' });
    await waitForStatus(w.store, chat.id, ['done']);
    // The fake honours --disallowedTools Write: nothing is written in the scratch folder.
    await expect(stat(path.join(chatScratchDir(w.root, chat.id), 'notes.md'))).rejects.toThrow();
    // D106 ruling: no Bash at all: the CLI is not offered it (fake-claude honours --disallowedTools Bash), so no Bash step is recorded.
    await call('POST', `/api/sessions/${chat.id}/messages`, { text: '[fake:tool Bash {"command":"ls"}] List the files.' });
    await waitForEvent(w.store, chat.id, (event) => event.label.includes('Bash is not available'));
    expect((await w.store.events.list(chat.id)).some((event) => (event.payload as { type?: string; name?: string }).type === 'tool' && (event.payload as { name?: string }).name === 'Bash')).toBe(false);
    await waitForStatus(w.store, chat.id, ['done']);
    // A Bash permission request (should one still come): Switchboard denies it with the chat's reason; the fake plays the denied turn.
    await call('POST', `/api/sessions/${chat.id}/messages`, { text: '[fake:perm-allow] Run the tests.' });
    const refused = await waitForEvent(w.store, chat.id, (event) => event.label.startsWith('Refused in a chat: Bash'));
    expect(refused.kind).toBe('text');
    await waitForStatus(w.store, chat.id, ['done']);
    const record = (await w.store.sessions.get(chat.id)) as SessionRecord;
    const stdin = JSON.stringify(await stdinOf(w.logFile, record.pid ?? -1, { all: true }));
    expect(stdin).toContain('"behavior":"deny"');
    expect(stdin).toContain('this is a Switchboard chat, which can read and plan but never edit files');
    expect(await w.store.permissions.list({ sessionId: chat.id })).toEqual([]);
  });

  it('stays in plan mode: a turn that reports another mode is set back to plan; the terminal and Remote Control are refused', async () => {
    const { w } = await setup();
    const chat = await startChat({ message: 'Plan the migration.' });
    await waitForStatus(w.store, chat.id, ['done']);
    // perm-auto's turn reports the recorded `default` mode, as if something took the CLI out of plan mode.
    await call('POST', `/api/sessions/${chat.id}/messages`, { text: '[fake:perm-auto] Go on.' });
    await waitForEvent(w.store, chat.id, (event) => event.label.startsWith('The chat left plan mode'));
    const record = (await w.store.sessions.get(chat.id)) as SessionRecord;
    await until(async () => JSON.stringify(await stdinOf(w.logFile, record.pid ?? -1, { all: true })).includes('"subtype":"set_permission_mode","mode":"plan"'), 'set_permission_mode plan');
    expect((await w.store.sessions.get(chat.id))?.requestedPermissionMode).toBe('plan');
    const detach = await call('POST', `/api/sessions/${chat.id}/detach`);
    expect(detach.statusCode).toBe(409);
    expect(detach.json()).toMatchObject({ error: 'chat' });
    const remote = await call('PUT', `/api/sessions/${chat.id}/remote`, { enabled: true });
    expect(remote.statusCode).toBe(409);
    expect(remote.json()).toMatchObject({ error: 'chat' });
  });

  it('looks at folders read-only: --add-dir per folder at the start and after a change (the process restarts); bad folders are refused', async () => {
    const { w } = await setup();
    const repoA = path.join(w.root, 'repo-a');
    const repoB = path.join(w.root, 'repo-b');
    await mkdir(repoA);
    await mkdir(repoB);
    expect((await call('POST', '/api/chats', { message: 'x', lookAt: ['relative/path'] })).statusCode).toBe(422);
    expect((await call('POST', '/api/chats', { message: 'x', lookAt: [path.join(w.root, 'missing')] })).statusCode).toBe(422);
    expect((await call('POST', '/api/chats', { message: '   ' })).statusCode).toBe(422);
    const chat = await startChat({ message: 'Compare the two repos.', lookAt: [repoA] });
    expect(chat.lookAt).toEqual([repoA]);
    await waitForStatus(w.store, chat.id, ['done']);
    const record = (await w.store.sessions.get(chat.id)) as SessionRecord;
    const first = (await spawnedArgv(w.logFile)).find((line) => line.argv?.includes(record.claudeSessionId));
    expect(flag(first?.argv ?? [], '--add-dir')).toEqual([repoA]);
    expect(flag(first?.argv ?? [], '--append-system-prompt')[0]).toContain(`You may read these folders for planning (read-only): ${repoA}.`);

    const changed = await call('PUT', `/api/chats/${chat.id}/look-at`, { lookAt: [repoA, repoB] });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((changed.json() as Session).lookAt).toEqual([repoA, repoB]);
    await waitForEvent(w.store, chat.id, (event) => event.label === 'Folders to look at updated');
    const last = await until(async () => {
      const spawns = (await spawnedArgv(w.logFile)).filter((line) => line.argv?.includes(record.claudeSessionId));
      return spawns.length >= 2 ? (spawns.at(-1)?.argv ?? []) : undefined;
    }, 'the restart with the new folders');
    expect(flag(last, '--resume')).toEqual([record.claudeSessionId]);
    expect(flag(last, '--add-dir')).toEqual([repoA, repoB]);
    expect(flag(last, '--permission-mode')).toEqual(['plan']);
    // A session has no folders to look at.
    const session = (await w.store.sessions.create({ name: 'plain-session', claudeSessionId: 'cid-plain', task: '', cwd: w.workspace } as never)) as SessionRecord;
    expect((await call('PUT', `/api/chats/${session.id}/look-at`, { lookAt: [] })).statusCode).toBe(409);
  });

  it('is left out of Team suggestions, Plans sources and Solutions; refused as a team member and a plan source', async () => {
    const { w } = await setup();
    const chat = await startChat({ message: 'Think about the roadmap.' });
    await waitForStatus(w.store, chat.id, ['done']);
    // The same history and title on a session and on a chat: only the session is suggested.
    const twin = await w.store.sessions.create({ name: 'code-review-twin', title: 'Code reviewer', claudeSessionId: 'cid-twin', task: '', cwd: w.workspace });
    await w.store.sessions.update(chat.id, { title: 'Code reviewer' });
    for (const id of [twin.id, chat.id]) {
      for (let i = 0; i < 60; i++) await w.store.events.append({ sessionId: id, kind: 'text', label: `step ${i}`, payload: { type: 'tool', name: 'Read', input: {} } as never });
    }
    const suggestions = await computeSuggestions({ store: w.store, loops: { list: async () => [] } as never, exclude: new Set(), now: Date.now() });
    const suggested = suggestions.map((s) => s.sessionId);
    expect(suggested).toContain(twin.id);
    expect(suggested).not.toContain(chat.id);
    // D132: Team is always on, so the refusal is the chat's own (409), not a missing Team.
    const adopt = await call('POST', '/api/team/members', { sessionId: chat.id, name: 'Planner' });
    expect(adopt.statusCode, adopt.body).toBe(409);
    // Plans on: a chat is refused as a plan's source.
    const plan = await call('POST', '/api/plans', { sourceSessionId: chat.id, title: 'Roadmap', targetBranch: 'epic/roadmap' });
    expect(plan.statusCode, plan.body).toBe(409);
    expect(plan.json()).toMatchObject({ error: 'chat' });
    const solutions = await call('GET', '/api/solutions');
    expect(solutions.body).not.toContain(chat.id);
  });

  it('Delete closes the chat and removes it with its scratch folder; a session is not deleted here', async () => {
    const { w } = await setup();
    const chat = await startChat({ message: 'A short question.' });
    await waitForStatus(w.store, chat.id, ['done']);
    const scratch = chatScratchDir(w.root, chat.id);
    await writeFile(path.join(scratch, 'left.txt'), 'x');
    const deleted = await call('DELETE', `/api/chats/${chat.id}`, { confirm: true });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await w.store.sessions.get(chat.id)).toBeNull();
    await expect(stat(scratch)).rejects.toThrow();
    const session = (await w.store.sessions.create({ name: 'keep-me', claudeSessionId: 'cid-keep', task: '', cwd: w.workspace } as never)) as SessionRecord;
    expect((await call('DELETE', `/api/chats/${session.id}`)).statusCode).toBe(409);
  });

  it('Continue as session: a new session in the chosen folder starts with the chat carried over (the history export) and the developer\'s message; linked both ways; the chat stays open', async () => {
    const { w, folderId } = await setup();
    const chat = await startChat({ message: 'Plan the login rework.' });
    await waitForStatus(w.store, chat.id, ['done']);
    const answer = await call('POST', '/api/sessions', { simple: true, name: 'login-rework', title: 'Login rework', task: 'Implement the plan.', folder: folderId, fromChat: chat.id });
    expect(answer.statusCode, answer.body).toBe(201);
    const session = answer.json() as Session;
    expect(session.kind).toBeUndefined();
    expect(session.continuedFrom).toEqual({ sessionId: chat.id, title: 'Plan the login rework.' });
    await waitForStatus(w.store, session.id, ['done']);
    const record = (await w.store.sessions.get(session.id)) as SessionRecord;
    const spawn = (await spawnedArgv(w.logFile)).find((line) => line.argv?.includes(record.claudeSessionId));
    // A development session: D6's mode, no chat flags, in the workspace folder.
    expect(flag(spawn?.argv ?? [], '--permission-mode')).toEqual(['auto']);
    expect(flag(spawn?.argv ?? [], '--disallowedTools')).toEqual([]);
    expect(record.cwd).toBe(w.workspace);
    const first = JSON.stringify((await stdinOf(w.logFile, spawn?.pid ?? -1)).find((line) => line['type'] === 'user'));
    expect(first).toContain('This session continues the Switchboard chat \\"Plan the login rework.\\"');
    expect(first).toContain('Developer');
    expect(first).toContain('Plan the login rework.');
    expect(first).toContain('Implement the plan.');
    expect(first).toMatch(/continued-as-session\.md/);
    // Linked both ways; the chat is not closed.
    const chatAfter = (await w.store.sessions.get(chat.id)) as SessionRecord;
    expect(chatAfter.continuedTo).toBe(session.id);
    expect(chatAfter.closedAt).toBeNull();
    const chatEvents = await w.store.events.list(chat.id);
    expect(chatEvents.find((event) => event.label === 'Continued as Login rework')?.payload).toMatchObject({ action: 'continued-in', linkedSessionId: session.id });
    const sessionEvents = await w.store.events.list(session.id);
    expect(sessionEvents.find((event) => event.label === 'Continued from the chat Plan the login rework.')?.payload).toMatchObject({ action: 'continued-from', linkedSessionId: chat.id });
    // fromChat must name a chat.
    const bad = await call('POST', '/api/sessions', { simple: true, name: 'other-one', task: 'x', folder: folderId, fromChat: session.id });
    expect(bad.statusCode).toBe(422);
  });

  it('Rename (2026-10-22): a chat is renamed through the session title route, publishes sessionUpdated, keeps the title over later turns and a restart, is found by it, and a continued session links to it by the new title', async () => {
    const { w, folderId } = await setup();
    const chat = await startChat({ message: 'Plan the Acme invoice export.' });
    expect(chat.title).toBe('Plan the Acme invoice export.');
    await waitForStatus(w.store, chat.id, ['done']);

    // Trimmed; the session rule's cap (80) applies; an empty title clears to the name, like a session.
    const renamed = await call('PUT', `/api/sessions/${chat.id}/title`, { title: '  Acme ledger plan  ' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ id: chat.id, kind: 'chat', title: 'Acme ledger plan', displayTitle: 'Acme ledger plan' });
    expect(published.some((m) => m.name === 'sessionUpdated' && (m.payload as Session).id === chat.id && (m.payload as Session).title === 'Acme ledger plan')).toBe(true);
    expect((await call('PUT', `/api/sessions/${chat.id}/title`, { title: 'x'.repeat(81) })).statusCode).toBe(422);

    // No auto-title: a later turn and a restart of its process keep the developer's title.
    await call('POST', `/api/sessions/${chat.id}/messages`, { text: 'Go deeper on the ledger.' });
    await waitForStatus(w.store, chat.id, ['done']);
    await call('PUT', `/api/chats/${chat.id}/look-at`, { lookAt: [w.workspace] });
    await waitForStatus(w.store, chat.id, ['done', 'idle']);
    expect(((await w.store.sessions.get(chat.id)) as SessionRecord).title).toBe('Acme ledger plan');
    const listed = (await call('GET', '/api/sessions')).json() as Session[];
    expect(listed.find((s) => s.id === chat.id)?.displayTitle).toBe('Acme ledger plan');

    // Search (D97) finds it by the new title.
    const found = (await call('GET', '/api/search?q=ledger&scope=conversations')).json() as SearchAnswer;
    const titleHit = found.groups.flatMap((g) => g.results).find((r) => r.chat && r.title.map((part) => part.text).join('') === 'Acme ledger plan');
    expect(titleHit, JSON.stringify(found)).toBeDefined();

    // Continue as session: the link and its divider carry the renamed title.
    const answer = await call('POST', '/api/sessions', { simple: true, name: 'ledger-work', title: 'Ledger work', task: 'Implement it.', folder: folderId, fromChat: chat.id });
    expect(answer.statusCode, answer.body).toBe(201);
    const session = answer.json() as Session;
    expect(session.continuedFrom).toEqual({ sessionId: chat.id, title: 'Acme ledger plan' });
    expect((await w.store.events.list(session.id)).some((event) => event.label === 'Continued from the chat Acme ledger plan')).toBe(true);
    await waitForStatus(w.store, session.id, ['done']);

    // Cleared: the chat shows its name again (as a session does).
    const cleared = await call('PUT', `/api/sessions/${chat.id}/title`, { title: '' });
    expect(cleared.json()).toMatchObject({ title: null, displayTitle: chat.name });
  });

  it('routes are classified: peers and devices may use the chat routes', () => {
    for (const [method, url] of [
      ['POST', '/api/chats'],
      ['PUT', '/api/chats/abc/look-at'],
      ['DELETE', '/api/chats/abc'],
      // Rename: the session title route (a peer's chat is renamed on its machine).
      ['PUT', '/api/sessions/abc/title'],
    ] as const) {
      expect(PEER_API_ALLOW.some(([m, pattern]) => m === method && pattern.test(url)), `${method} ${url}`).toBe(true);
      expect(isLocalOnly(method, url), `${method} ${url}`).toBe(false);
    }
  });

  it('titles come from the first message', () => {
    expect(chatTitleFromMessage('  \n# Heading here\nmore')).toBe('Heading here');
    expect(chatTitleFromMessage('- [a link](http://x) and `code`')).toBe('a link and code');
    expect(chatTitleFromMessage('!!!')).toBe('New chat');
    const long = chatTitleFromMessage('word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('D106 · chats on Codex CLI and OpenCode (their read-only modes)', () => {
  async function readLog(file: string): Promise<Array<Record<string, unknown>>> {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(file, 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  async function chatOn(w: SupervisorWorld, provider: 'codex' | 'opencode'): Promise<SessionRecord> {
    const id = `chat-${provider}`;
    const cwd = chatScratchDir(w.root, id);
    await mkdir(cwd, { recursive: true });
    return w.supervisor.startChat({ name: id, title: 'Plan it', message: 'Plan it.', cwd, provider, lookAt: [] });
  }

  it('Codex: the thread runs in the read-only sandbox and never asks for approval', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const chat = await chatOn(w, 'codex');
    await waitForStatus(w.store, chat.id, ['done']);
    const sent = (await readLog(w.codexLog)).filter((line) => line['kind'] === 'stdin' && typeof line['line'] === 'string').map((line) => JSON.parse(line['line'] as string) as Record<string, unknown>);
    const start = sent.find((message) => message['method'] === 'thread/start');
    expect(start?.['params']).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only' });
    // D106 ruling: no shell tools in a chat's app-server.
    const argv = (await readLog(w.codexLog)).find((line) => line['kind'] === 'argv')?.['argv'] as string[] | undefined;
    expect(argv).toEqual(['-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', 'app-server']);
    expect((start?.['params'] as Record<string, unknown>)['developerInstructions']).toContain('This is a Switchboard chat');
  });

  it("OpenCode: edits and shell commands denied in the server's config, prompts to the plan agent", async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const chat = await chatOn(w, 'opencode');
    await waitForStatus(w.store, chat.id, ['done']);
    const log = await readLog(w.opencodeLog);
    const env = (log.find((line) => line['kind'] === 'argv')?.['env'] ?? {}) as Record<string, string>;
    // D106 ruling: no shell (bash denied), no edits.
    expect(JSON.parse(env['OPENCODE_CONFIG_CONTENT'] ?? '{}')['permission']).toEqual({ edit: 'deny', bash: 'deny', webfetch: 'allow', external_directory: 'allow' });
    const prompt = log.find((line) => line['kind'] === 'prompt')?.['body'] as Record<string, unknown> | undefined;
    expect(prompt?.['agent']).toBe('plan');
    expect(String(prompt?.['system'])).toContain('This is a Switchboard chat');
  });
});

/**
 * D106 follow-up (2026-10-28, "chats should have access to write artifacts"): a chat's agent
 * saves artifacts through Switchboard's own MCP server. fake-claude runs the real `switchboard`
 * helper (`FAKE_CLAUDE_MCP_RUN=1`) against this app, listening on a test port; in plan mode the
 * fake asks the host before an MCP tool no `--allowedTools` rule covers (and, with
 * `FAKE_CLAUDE_PLAN_ASK_MCP=1`, before every MCP tool): Switchboard allows its own tools at once
 * and still refuses everything else.
 */
describe('D106 follow-up · a chat saves artifacts', () => {
  async function listening(env: Record<string, string>): Promise<{ w: SupervisorWorld; port: number }> {
    world = await makeSupervisorWorld({ parentEnv: { FAKE_CLAUDE_MCP_RUN: '1', ...env } });
    const w = world;
    token = generateToken();
    const bus = new HubBus();
    published = [];
    bus.subscribe((message) => published.push(message));
    for (const port of await freeTestPorts()) {
      const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
      const candidate = await buildApp({ config: { ...base, port }, token, store: w.store, webRoot: w.root, supervisor: w.supervisor, bus });
      try {
        await candidate.listen({ host: '127.0.0.1', port });
        app = candidate;
        currentPort = port;
        return { w, port };
      } catch {
        await candidate.close();
      }
    }
    throw new Error('no free test port');
  }

  async function artifactsOf(id: string): Promise<Array<{ id: string; title: string; kind: string }>> {
    const answer = await call('GET', `/api/sessions/${id}/artifacts`);
    expect(answer.statusCode, answer.body).toBe(200);
    return answer.json() as Array<{ id: string; title: string; kind: string }>;
  }

  it('artifact_save with content: the call goes through (pre-approved, no ask), the artifact is in the chat\'s Artifacts and nothing is written in the scratch folder', async () => {
    const { w } = await listening({});
    const chat = await startChat({ message: 'Plan the billing split. [fake:tool mcp__switchboard__artifact_save {"title":"Billing split plan","kind":"markdown","content":"# Plan\\n\\n1. Split the module"}]' });
    await waitForStatus(w.store, chat.id, ['done']);
    const record = (await w.store.sessions.get(chat.id)) as SessionRecord;
    const argv = (await spawnedArgv(w.logFile)).find((line) => line.argv?.includes(record.claudeSessionId))?.argv ?? [];
    expect(flag(argv, '--allowedTools')).toEqual(['mcp__switchboard,WebFetch,WebSearch']);
    expect(flag(argv, '--permission-mode')).toEqual(['plan']);
    const artifacts = await until(async () => {
      const list = await artifactsOf(chat.id);
      return list.length > 0 ? list : undefined;
    }, 'the chat artifact');
    expect(artifacts).toMatchObject([{ title: 'Billing split plan', kind: 'markdown' }]);
    expect(await readdir(chatScratchDir(w.root, chat.id))).toEqual([]);
    // Not asked, not refused, nothing in the Inbox.
    const stdin = JSON.stringify(await stdinOf(w.logFile, record.pid ?? -1, { all: true }));
    expect(stdin).not.toContain('"behavior":"deny"');
    expect((await w.store.events.list(chat.id)).some((event) => event.label.startsWith('Refused in a chat'))).toBe(false);
    expect(await w.store.permissions.list({ sessionId: chat.id })).toEqual([]);
  });

  it("plan mode asks for MCP tools: Switchboard's own (artifact_save, todo_add) are allowed at once, another server's tool is still refused", async () => {
    const { w } = await listening({ FAKE_CLAUDE_PLAN_ASK_MCP: '1' });
    const chat = await startChat({ message: 'Keep a note. [fake:tool mcp__switchboard__artifact_save {"title":"Notes","kind":"markdown","content":"- one"}]' });
    await waitForStatus(w.store, chat.id, ['done']);
    await until(async () => ((await artifactsOf(chat.id)).length === 1 ? true : undefined), 'the artifact after the allowed ask');
    await call('POST', `/api/sessions/${chat.id}/messages`, { text: 'Add a todo. [fake:tool mcp__switchboard__todo_add {"title":"Split billing","description":"Split it","plan":"No plan: test","priority":"medium","estimate_minutes":10}]' });
    await until(async () => ((await w.store.todos.list(chat.id)).length === 1 ? true : undefined), 'the todo after the allowed ask');
    await waitForStatus(w.store, chat.id, ['done']);
    await call('POST', `/api/sessions/${chat.id}/messages`, { text: 'Use the other tool. [fake:tool mcp__other__save {"x":1}]' });
    await waitForEvent(w.store, chat.id, (event) => event.label.startsWith('Refused in a chat: mcp__other__save'));
    await waitForEvent(w.store, chat.id, (event) => event.label.includes('mcp__other__save was not used (permission denied'));
    await waitForStatus(w.store, chat.id, ['done']);
    const record = (await w.store.sessions.get(chat.id)) as SessionRecord;
    const stdin = (await stdinOf(w.logFile, record.pid ?? -1, { all: true })).map((line) => JSON.stringify(line));
    expect(stdin.filter((line) => line.includes('"behavior":"allow"'))).toHaveLength(2);
    expect(stdin.filter((line) => line.includes('"behavior":"deny"'))).toHaveLength(1);
    expect((await w.store.events.list(chat.id)).filter((event) => event.label.startsWith('Refused in a chat')).map((event) => event.label)).toEqual(['Refused in a chat: mcp__other__save (chats can plan but not edit)']);
    expect(await w.store.permissions.list({ sessionId: chat.id })).toEqual([]);
  });

  it('an image by path: from a folder it looks at or its attachments (copied); from anywhere else refused', async () => {
    const { w, port } = await listening({});
    const look = path.join(w.root, 'look');
    await mkdir(look, { recursive: true });
    await writeFile(path.join(look, 'shot.png'), PNG);
    const chat = await startChat({ message: 'Hello.', lookAt: [look] });
    await waitForStatus(w.store, chat.id, ['done']);
    const attachments = path.join(w.root, 'attachments', chat.id);
    await mkdir(attachments, { recursive: true });
    await writeFile(path.join(attachments, 'a1-pasted.png'), PNG);
    const outside = path.join(w.root, 'elsewhere');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'shot.png'), PNG);
    const agent = async (body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/agent/v1/artifacts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${agentTokenFor(token, chat.id)}`, [AGENT_SESSION_HEADER]: chat.id },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as { message?: string } };
    };
    expect((await agent({ title: 'Looked at', kind: 'image', path: path.join(look, 'shot.png') })).status).toBe(201);
    expect((await agent({ title: 'Attached', kind: 'image', path: path.join(attachments, 'a1-pasted.png') })).status).toBe(201);
    const refused = await agent({ title: 'Elsewhere', kind: 'image', path: path.join(outside, 'shot.png') });
    expect(refused.status).toBe(422);
    expect(refused.body.message).toContain("outside the session's working folders");
    expect((await artifactsOf(chat.id)).map((artifact) => artifact.title).sort()).toEqual(['Attached', 'Looked at']);
    // Copied, never moved.
    expect(await readdir(look)).toEqual(['shot.png']);
    expect(await readdir(attachments)).toEqual(['a1-pasted.png']);
  });
});
