import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { CHAT_DISALLOWED_TOOLS, chatTitleFromMessage } from '../../../src/core/chats.ts';
import { buildApp } from '../../../src/server/app.ts';
import { chatScratchDir } from '../../../src/server/chats/start.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { SessionRecord } from '../../../src/server/db/repos/sessions.ts';
import { PEER_API_ALLOW } from '../../../src/server/peers/service.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { computeSuggestions } from '../../../src/server/team/suggestions.ts';
import { generateToken } from '../../../src/server/token.ts';
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

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
});

async function setup(): Promise<{ w: SupervisorWorld; folderId: string }> {
  world = await makeSupervisorWorld({ standingInstruction: true });
  const w = world;
  token = generateToken();
  // The workspace folder has an AGENTS.md router: a chat never sees it (its cwd is its scratch folder).
  await writeFile(path.join(w.workspace, 'AGENTS.md'), '# Router\nAsk the session-start questions first.\n');
  const folder = await seedFolder(w.store, w.workspace);
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: w.store, webRoot: w.root, supervisor: w.supervisor });
  await app.ready();
  return { w, folderId: folder.id };
}

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: `127.0.0.1:${PORT}`, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
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
    expect(flag(argv, '--disallowedTools')[0]?.split(',')).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit', 'ExitPlanMode']));
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
    // A Bash permission request: Switchboard denies it with the chat's reason; the fake plays the denied turn.
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
    const adopt = await call('POST', '/api/team/members', { sessionId: chat.id, role: 'Planner' });
    expect([404, 409]).toContain(adopt.statusCode);
    // Plans on: a chat is refused as a plan's source.
    expect((await call('PUT', '/api/settings', { 'experimental.plans': true })).statusCode).toBe(200);
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

  it('routes are classified: peers and devices may use the chat routes', () => {
    for (const [method, url] of [
      ['POST', '/api/chats'],
      ['PUT', '/api/chats/abc/look-at'],
      ['DELETE', '/api/chats/abc'],
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
