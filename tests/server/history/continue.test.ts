import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContinueRefusal, HistoryItem, Session } from '../../../src/core/api.ts';
import type { LifecyclePayload, ToolPayload, UserPayload } from '../../../src/core/event-payload.ts';
import { buildApp } from '../../../src/server/app.ts';
import { conversationTitle } from '../../../src/server/history/continue.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { generateToken } from '../../../src/server/token.ts';
import { BASELINE } from '../../helpers/fake-claude.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, payloadType, spawnedArgv, stdinOf, until, waitForStatus } from '../../helpers/supervisor.ts';
import { type FixtureName, asTerminal, fixtureLines, withChainRepaired, withSessionId, withoutTypes, writeTranscript } from '../../helpers/transcripts.ts';

/**
 * D16 oracle (server, real path): a conversation started in a terminal moves into
 * Switchboard as the same conversation through `POST /api/history/{id}/continue`.
 * fake-claude is the CLI (`FAKE_CLAUDE_LOG`, a temp `CLAUDE_CONFIG_DIR`); the
 * terminal conversations are the M0.3/M0.4 recordings moved into a temp workspace
 * (`tools/fake-claude/fixtures/transcripts`), marked as typed in a terminal
 * (`entrypoint: "cli"`), with the chain links to the lines the recordings dropped
 * restored (`withChainRepaired`). Checked: the session keeps the id, the transcript's turns
 * become its events, `--resume <id>` is spawned with no message and stays idle;
 * the folder rules (a saved folder holds it; else `folder-not-saved` → `addFolder`;
 * else 422), the terminal warning (→ `confirm`), `already-in-switchboard`, and
 * History listing the moved conversation once, as a stored session.
 */
const PORT = 4970; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const OLD = new Date(Date.now() - 60 * 60_000);

let sw: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await sw?.cleanup();
  app = undefined;
  sw = undefined;
  vi.unstubAllEnvs();
});

/** A world with a router workspace `work space` (not saved unless `save`) and the app over it. */
async function setup(options: { readonly save?: boolean } = {}): Promise<SupervisorWorld> {
  sw = await makeSupervisorWorld();
  await writeFile(path.join(sw.workspace, 'AGENTS.md'), '# AGENTS.md (Workspace Router)\n');
  if (options.save !== false) await seedFolder(sw.store, sw.workspace);
  // History reads the transcripts under CLAUDE_CONFIG_DIR (read when the route registers).
  vi.stubEnv('CLAUDE_CONFIG_DIR', sw.configDir);
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: sw.store, webRoot: sw.root, supervisor: sw.supervisor });
  await app.ready();
  return sw;
}

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

function move(id: string, body: Record<string, unknown> = {}) {
  return call('POST', `/api/history/${encodeURIComponent(id)}/continue`, body);
}

/**
 * Writes a recorded conversation as a terminal one (`cli`) that started in
 * `<parent>/<recorded folder>` (created on disk), with an old mtime unless
 * `mtime` is given. Returns the start cwd.
 */
async function terminalConversation(
  w: SupervisorWorld,
  fixture: FixtureName,
  id: string,
  options: { readonly parent?: string; readonly mtime?: Date; readonly strip?: readonly string[]; readonly headless?: boolean } = {},
): Promise<string> {
  const parent = options.parent ?? path.join(w.workspace, 'other');
  const folder = fixture === 'tx-main' ? 'tx main' : fixture;
  const cwd = path.join(parent, folder);
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(parent, 'handoff-elsewhere'), { recursive: true });
  let lines = withChainRepaired(withSessionId(await fixtureLines(fixture, parent), id));
  if (!options.headless) lines = asTerminal(lines);
  if (options.strip) lines = withoutTypes(lines, ...options.strip);
  await writeTranscript(w.configDir, cwd, id, lines, options.mtime ?? OLD);
  return cwd;
}

/** The supervisor's spawns (they carry `--name`), in order. */
async function sessionSpawns(w: SupervisorWorld) {
  return (await spawnedArgv(w.logFile)).filter((line) => line.argv?.includes('--name'));
}

async function history(): Promise<HistoryItem[]> {
  const response = await call('GET', '/api/history');
  expect(response.statusCode).toBe(200);
  return response.json() as HistoryItem[];
}

describe('POST /api/history/{id}/continue (D16)', () => {
  it('moves a terminal conversation: same id, its turns imported, --resume spawned with no message, idle; History lists it once', async () => {
    const w = await setup();
    const cwd = await terminalConversation(w, 'handoff-mid', 'term-mid', { strip: ['custom-title', 'agent-name'] });
    const before = await history();
    expect(before.find((item) => item.claudeSessionId === 'term-mid')).toMatchObject({
      sessionId: null,
      terminal: true,
      cwd,
      firstPrompt: expect.stringMatching(/^Remember the code word: marigold\./),
    });

    const response = await move('term-mid');
    expect(response.statusCode, response.body).toBe(201);
    const session = response.json() as Session;
    expect(session).toMatchObject({
      claudeSessionId: 'term-mid',
      name: 'remember-the-code-word-marigold-then-run',
      workType: null,
      mode: null,
      phase: null,
      worktrees: false,
      ultracode: false,
      attached: true,
      cwd,
      folderPath: w.workspace,
      folderKind: 'workspace',
      solutions: ['handoff-mid'],
      // D22: no title in the transcript (stripped here): no title, the name is shown.
      title: null,
      displayTitle: 'remember-the-code-word-marigold-then-run',
    });
    const folders = await w.store.folders.list();
    expect(session.folder).toBe(folders[0]?.id);

    const idle = await waitForStatus(w.store, session.id, ['idle']);
    expect(idle.task).toMatch(/^Remember the code word: marigold\./);
    const spawns = await until(async () => {
      const logged = await sessionSpawns(w);
      return logged.length === 1 ? logged : undefined;
    }, 'the resume spawn');
    expect(spawns[0]?.argv).toEqual([...BASELINE, '--resume', 'term-mid', '--name', session.name, '--forward-subagent-text', '--replay-user-messages']);
    expect(spawns[0]?.cwd).toBe(cwd);
    expect(spawns[0]?.pid).toBe(idle.pid);
    // No first message: the process stays idle until the developer writes.
    expect(await stdinOf(w.logFile, spawns[0]?.pid ?? -1)).toEqual([]);

    // The transcript's conversation, as the Attach-here import shows it: prompts (origin terminal), replies, the Bash call with its result.
    const events = await w.store.events.list(session.id);
    const shown = events.map((event) => [payloadType(event), event.label]);
    expect(shown[0]).toEqual(['user', expect.stringMatching(/^Remember the code word: marigold\./)]);
    expect(shown.slice(-3)).toEqual([
      ['user', 'What code word did I ask you to remember? Reply with just the word.'],
      ['assistant', 'marigold'],
      ['lifecycle', 'Moved from a terminal'],
    ]);
    const prompts = events.filter((event) => payloadType(event) === 'user');
    expect(prompts.every((event) => (event.payload as UserPayload).origin === 'terminal' && (event.payload as UserPayload).delivered)).toBe(true);
    const tools = events.filter((event) => payloadType(event) === 'tool');
    expect(tools).toHaveLength(1);
    expect((tools[0]?.payload as ToolPayload).name).toBe('Bash');
    expect(tools[0]?.endTs).not.toBeNull();
    expect(events.map((event) => event.label)).not.toContain('No response requested.');
    expect((events.at(-1)?.payload as LifecyclePayload).action).toBe('moved');
    expect(idle.lastTranscriptUuid).not.toBeNull();

    // History: the moved conversation is one row, the stored session (no terminal row next to it).
    const rows = (await history()).filter((item) => item.claudeSessionId === 'term-mid');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: session.id, name: session.name, summary: 'marigold' });
    expect(rows[0]?.terminal).toBeUndefined();

    // Moved twice: refused with the session that has it.
    const again = await move('term-mid');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'already-in-switchboard', sessionId: session.id });
    expect(await sessionSpawns(w)).toHaveLength(1);
    expect(w.errors).toEqual([]);
  });

  it('names: the title first, made unique; a given name is checked', async () => {
    const w = await setup();
    await terminalConversation(w, 'handoff', 'term-a');
    await terminalConversation(w, 'handoff', 'term-b');
    await terminalConversation(w, 'handoff-conc', 'term-c');
    const first = await move('term-a');
    expect(first.statusCode, first.body).toBe(201);
    expect((first.json() as Session).name).toBe('sb-handoff');
    // The same title again: made unique. Resumed from a second folder: both folders' solutions.
    const second = await move('term-b');
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json()).toMatchObject({ name: 'sb-handoff-2', solutions: ['handoff', 'handoff-elsewhere'] });

    expect((await move('term-c', { name: 'Not Kebab' })).json()).toMatchObject({ error: 'invalid', errors: [{ field: 'name' }] });
    expect((await move('term-c', { name: 'sb-handoff' })).json()).toMatchObject({ error: 'invalid', errors: [{ field: 'name', message: 'a session named "sb-handoff" already exists' }] });
    const named = await move('term-c', { name: 'code-words' });
    expect(named.statusCode, named.body).toBe(201);
    expect((named.json() as Session).name).toBe('code-words');
  });

  it("D22: the conversation's title becomes the session's title (the short name still derived from it) and its --name", async () => {
    const w = await setup();
    await terminalConversation(w, 'handoff', 'term-a');
    await terminalConversation(w, 'handoff', 'term-b');
    await terminalConversation(w, 'handoff-conc', 'term-c');
    const first = (await move('term-a')).json() as Session;
    expect(first).toMatchObject({ name: 'sb-handoff', title: 'sb-handoff', displayTitle: 'sb-handoff' });
    const second = (await move('term-b')).json() as Session;
    expect(second).toMatchObject({ name: 'sb-handoff-2', title: 'sb-handoff' });
    // A given name replaces only the short name.
    const named = (await move('term-c', { name: 'code-words' })).json() as Session;
    expect(named).toMatchObject({ name: 'code-words', title: 'sb-handoff-conc', displayTitle: 'sb-handoff-conc' });
    const spawns = await until(async () => {
      const logged = await sessionSpawns(w);
      return logged.length === 3 ? logged : undefined;
    }, 'three resume spawns');
    const names = spawns.map((line) => line.argv?.[(line.argv?.indexOf('--name') ?? -2) + 1]);
    expect(names.sort()).toEqual(['sb-handoff', 'sb-handoff', 'sb-handoff-conc']);
    const rows = (await history()).filter((item) => item.sessionId === named.id);
    expect(rows).toEqual([expect.objectContaining({ name: 'code-words', displayTitle: 'sb-handoff-conc' })]);
  });

  it('D22 (developer ruling): a given title is the title and the short name is derived from it (-2 when taken); a given name still wins; 422 on a bad title', async () => {
    const w = await setup();
    await terminalConversation(w, 'handoff', 'term-a');
    await terminalConversation(w, 'handoff', 'term-b');
    await terminalConversation(w, 'handoff-conc', 'term-c');
    // Refused before anything moves: an 81-character, blank or non-text title.
    for (const title of ['x'.repeat(81), '   ', 42]) {
      const refusal = await move('term-c', { title });
      expect(refusal.statusCode, String(title)).toBe(422);
      expect(refusal.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'title', message: 'the title must be text of 1–80 characters' }] });
    }
    expect(await sessionSpawns(w)).toEqual([]);

    const first = await move('term-a', { title: '  Lantern follow-up ' });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ name: 'lantern-follow-up', title: 'Lantern follow-up', displayTitle: 'Lantern follow-up', claudeSessionId: 'term-a' });
    // The same title again: the short name gets -2 (the title is not unique).
    const second = await move('term-b', { title: 'Lantern follow-up' });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json()).toMatchObject({ name: 'lantern-follow-up-2', title: 'Lantern follow-up' });
    // A given name is the short name; the title stays the given one. null = the conversation's own title (D16).
    const named = await move('term-c', { name: 'code-words', title: 'Code words' });
    expect(named.statusCode, named.body).toBe(201);
    expect(named.json()).toMatchObject({ name: 'code-words', title: 'Code words' });
    const spawns = await until(async () => {
      const logged = await sessionSpawns(w);
      return logged.length === 3 ? logged : undefined;
    }, 'three resume spawns');
    const names = spawns.map((line) => line.argv?.[(line.argv?.indexOf('--name') ?? -2) + 1]);
    expect(names.sort()).toEqual(['Code words', 'Lantern follow-up', 'Lantern follow-up']);
  });

  it('D22: title null keeps the conversation\'s own title (D16)', async () => {
    const w = await setup();
    await terminalConversation(w, 'handoff', 'term-a');
    const moved = await move('term-a', { title: null });
    expect(moved.statusCode, moved.body).toBe(201);
    expect(moved.json()).toMatchObject({ name: 'sb-handoff', title: 'sb-handoff' });
    expect(w.errors).toEqual([]);
  });

  it("D22: the title is the custom title, else the AI title, whitespace collapsed, at most 80 characters; none without either", () => {
    expect(conversationTitle({ customTitle: '  Fix   the\nlogin  ', aiTitle: 'AI' })).toBe('Fix the login');
    expect(conversationTitle({ customTitle: '   ', aiTitle: 'Refactor billing' })).toBe('Refactor billing');
    expect(conversationTitle({ customTitle: null, aiTitle: null })).toBeNull();
    expect(conversationTitle({ customTitle: `${'a'.repeat(79)} bcd`, aiTitle: null })).toBe('a'.repeat(79));
  });

  it('no saved folder holds it: 409 folder-not-saved with the workspace it sits in; addFolder adds it and moves', async () => {
    const w = await setup({ save: false });
    await terminalConversation(w, 'handoff', 'term-a');
    const refusal = await move('term-a');
    expect(refusal.statusCode).toBe(409);
    const body = refusal.json() as Extract<ContinueRefusal, { error: 'folder-not-saved' }>;
    expect(body).toMatchObject({ error: 'folder-not-saved', check: { path: w.workspace, kind: 'workspace', router: { title: 'AGENTS.md (Workspace Router)' } } });
    // Nothing changed: no folder, no session, no process.
    expect(await w.store.folders.list()).toEqual([]);
    expect(await w.store.sessions.list()).toEqual([]);

    const moved = await move('term-a', { addFolder: true });
    expect(moved.statusCode, moved.body).toBe(201);
    const folders = await w.store.folders.list();
    expect(folders.map((folder) => [folder.canonicalPath, folder.kind])).toEqual([[w.workspace, 'workspace']]);
    expect(moved.json()).toMatchObject({ folder: folders[0]?.id, folderPath: w.workspace });
  });

  it('the nearest git repo above the start folder is offered when no workspace is closer', async () => {
    const w = await setup({ save: false });
    const repo = path.join(w.root, 'repos', 'lone-repo');
    await mkdir(path.join(repo, '.git'), { recursive: true });
    await terminalConversation(w, 'handoff', 'term-r', { parent: path.join(repo, 'src') });
    const refusal = await move('term-r');
    expect(refusal.statusCode).toBe(409);
    expect(refusal.json()).toMatchObject({ error: 'folder-not-saved', check: { path: repo, kind: 'repo', repoName: 'lone-repo' } });
    const moved = await move('term-r', { addFolder: true });
    expect(moved.statusCode, moved.body).toBe(201);
    expect(moved.json()).toMatchObject({ folderKind: 'repo', folderPath: repo, solutions: ['lone-repo'], cwd: path.join(repo, 'src', 'handoff') });
  });

  it('D59: neither a workspace nor a repo above it: its start folder is offered as a plain folder (409), addFolder saves it and moves', async () => {
    const w = await setup();
    const cwd = await terminalConversation(w, 'handoff', 'term-p', { parent: path.join(w.root, 'plain') });
    const refusal = await move('term-p');
    expect(refusal.statusCode).toBe(409);
    expect(refusal.json()).toMatchObject({ error: 'folder-not-saved', message: `no saved folder holds ${cwd}; add the folder ${cwd} to continue it here`, check: { path: cwd, kind: 'plain' } });
    expect(await w.store.sessions.list()).toEqual([]);
    const moved = await move('term-p', { addFolder: true, confirm: true });
    expect(moved.statusCode, moved.body).toBe(201);
    expect(moved.json()).toMatchObject({ folderKind: 'plain', folderPath: cwd, solutions: [], cwd });
    expect((await w.store.folders.list()).find((folder) => folder.canonicalPath === cwd)?.kind).toBe('plain');
  });

  it('D59: a conversation inside a saved plain folder continues there, with no solutions', async () => {
    const w = await setup();
    const notes = path.join(w.root, 'notes');
    await mkdir(notes, { recursive: true });
    await w.store.folders.create({ path: notes, canonicalPath: await realpath(notes), kind: 'plain' });
    const cwd = await terminalConversation(w, 'handoff', 'term-n', { parent: notes });
    const moved = await move('term-n', { confirm: true });
    expect(moved.statusCode, moved.body).toBe(201);
    expect(moved.json()).toMatchObject({ folderKind: 'plain', folderPath: await realpath(notes), solutions: [], cwd });
  });

  it('a terminal may still have it open: 409 terminal-open (nothing moved), confirm moves it', async () => {
    const w = await setup();
    await terminalConversation(w, 'handoff', 'term-open', { mtime: new Date() });
    const refusal = await move('term-open');
    expect(refusal.statusCode).toBe(409);
    const body = refusal.json() as Extract<ContinueRefusal, { error: 'terminal-open' }>;
    expect(body.error).toBe('terminal-open');
    expect(body.reasons.map((reason) => reason.kind)).toEqual(['transcript-recent']);
    expect(body.message).toMatch(/Moving it now forks the conversation/);
    expect(await w.store.sessions.list()).toEqual([]);
    expect(await sessionSpawns(w)).toEqual([]);

    const moved = await move('term-open', { confirm: true });
    expect(moved.statusCode, moved.body).toBe(201);
    await waitForStatus(w.store, (moved.json() as Session).id, ['idle']);
  });

  it('unknown ids, headless conversations and bad bodies are refused', async () => {
    const w = await setup();
    await terminalConversation(w, 'tx-main', 'headless-tx', { headless: true });
    expect((await move('nope')).statusCode).toBe(404);
    expect((await move('bad id')).statusCode).toBe(404);
    const headless = await move('headless-tx');
    expect(headless.statusCode).toBe(422);
    expect(headless.json()).toMatchObject({ error: 'not-a-terminal-conversation' });
    const bad = await call('POST', '/api/history/headless-tx/continue', ['x']);
    expect(bad.statusCode).toBe(422);
    // Nothing is ever written under the config folder by a refusal.
    const projects = await readdir(path.join(w.configDir, 'projects'), { recursive: true });
    expect(projects.filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
  });

  it('an old transcript and no terminal holding it: no warning, though another moved conversation is live', async () => {
    const w = await setup();
    await terminalConversation(w, 'handoff', 'term-1');
    const cwd = await terminalConversation(w, 'handoff-conc', 'term-2');
    const first = await move('term-1');
    expect(first.statusCode, first.body).toBe(201);
    await waitForStatus(w.store, (first.json() as Session).id, ['idle']);
    const second = await move('term-2');
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json()).toMatchObject({ cwd, name: 'sb-handoff-conc' });
    // Its own process now holds the id: moving it again is refused before any terminal check.
    expect((await move('term-2', { confirm: true })).json()).toMatchObject({ error: 'already-in-switchboard' });
  });
});
