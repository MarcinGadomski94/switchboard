import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session, SessionEvent } from '../../../src/core/api.ts';
import { HOOK_MARKER } from '../../../src/core/hooks.ts';
import { buildApp } from '../../../src/server/app.ts';
import { CLI_MODE_RESTART_LABEL } from '../../../src/server/cli-mode/service.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { DEVICE_ALLOWED } from '../../../src/server/devices/local-only.ts';
import { HOOK_MESSAGE_KIND } from '../../../src/server/hooks/service.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { type PtySpawner, TerminalService } from '../../../src/server/terminals/service.ts';
import { HOOK_TOKEN_FILE, generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D171 oracle (`docs/terminals.md` → *CLI mode*): a supervised fake-claude agent switches to CLI mode
 * (its headless process stopped; the session hooked; a D170 terminal runs `claude --resume <id>` with the
 * same launch context and the D48 hooks passed for this process only, never `-p` / stream-json, no
 * Switchboard internals in its environment), its Chat tab follows it through the hooks and its composer's
 * messages wait for the CLI (D48's mailbox), Back to chat mode ends the CLI (Ctrl-C twice) and D72's
 * continue resumes the same conversation headless; a running turn is refused unless stopped first; the
 * CLI exiting by itself is back to chat mode too; a restart leaves it in chat mode; Codex agents and
 * conversations are refused; another profile gets 404; the routes are on the peer and phone lists.
 * The pseudo-terminal is a stand-in (it records the program and its input; a second Ctrl-C exits it).
 */

const PORT = 4876;
const HOST = `127.0.0.1:${PORT}`;

interface FakePty {
  readonly file: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly writes: string[];
  exited: boolean;
  exit(code?: number): void;
}

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';
let ptys: FakePty[] = [];

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
  ptys = [];
});

const fakeSpawn: PtySpawner = (file, args, options) => {
  const exits: Array<(event: { exitCode: number }) => void> = [];
  let ctrlC = 0;
  const pty: FakePty = {
    file,
    args: [...args],
    env: options.env,
    cwd: options.cwd,
    writes: [],
    exited: false,
    exit(code = 0) {
      if (pty.exited) return;
      pty.exited = true;
      for (const listener of exits) listener({ exitCode: code });
    },
  };
  ptys.push(pty);
  return {
    pid: 40_000 + ptys.length,
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener) => {
      exits.push(listener);
      return { dispose: () => undefined };
    },
    write: (data) => {
      pty.writes.push(data);
      // The TUI's own exit: Ctrl-C twice.
      if (data === '\x03' && ++ctrlC >= 2) setTimeout(() => pty.exit(0), 10);
    },
    resize: () => undefined,
    kill: () => pty.exit(1),
  };
};

async function startApp(w: SupervisorWorld): Promise<void> {
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: w.store, webRoot: w.root, supervisor: w.supervisor, terminals: new TerminalService({ spawn: fakeSpawn }) });
  await app.ready();
}

async function setup(): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld();
  token = generateToken();
  await seedFolder(world.store, world.workspace);
  await startApp(world);
  return world;
}

function call(method: InjectOptions['method'], url: string, payload?: unknown, cookie = '') {
  if (!app) throw new Error('no app');
  return app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${token}${cookie ? `; ${cookie}` : ''}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}

async function session(id: string): Promise<Session> {
  return (await call('GET', `/api/sessions/${id}`)).json() as Session;
}

async function hookCall(w: SupervisorWorld, claudeSessionId: string, event: Record<string, unknown>) {
  if (!app) throw new Error('no app');
  const hookToken = (await readFile(path.join(w.root, HOOK_TOKEN_FILE), 'utf8')).trim();
  return app.inject({ method: 'POST', url: '/hook/v1/event', headers: { host: HOST, authorization: `Bearer ${hookToken}`, 'content-type': 'application/json' }, payload: JSON.stringify({ event: { session_id: claudeSessionId, cwd: w.workspace, ...event }, claudePid: 40_001, entrypoint: 'cli' }) });
}

function lifecycles(list: readonly SessionEvent[]): string[] {
  return list.filter((event) => (event.payload as { type?: string } | null)?.type === 'lifecycle').map((event) => event.label ?? '');
}

describe('D171 · the agent CLI tab', () => {
  it('enters CLI mode: headless stopped, hooked, the interactive claude with the same launch and the per-process hooks; the chat follows; Back to chat resumes headless', async () => {
    const w = await setup();
    const started = await w.supervisor.start(newSession({ task: 'Say hi.' }), w.place);
    await waitForStatus(w.store, started.id, ['done', 'idle']);
    expect(w.supervisor.isLive(started.id)).toBe(true);

    const entered = await call('POST', `/api/sessions/${started.id}/cli-mode`, { cols: 120, rows: 40 });
    expect(entered.statusCode, entered.body).toBe(200);
    const cli = entered.json() as Session;
    expect(cli.cliMode?.terminalId).toEqual(expect.any(String));
    expect(cli).toMatchObject({ hooked: true, attached: false });
    expect(w.supervisor.isLive(started.id)).toBe(false);

    // The program: the CLI command with `--resume <id>`, the launch context, the hooks via --settings; never the headless surface.
    expect(ptys).toHaveLength(1);
    const pty = ptys[0] as FakePty;
    const argv = [pty.file, ...pty.args];
    expect(argv).toEqual(expect.arrayContaining(['--resume', started.claudeSessionId, '--permission-mode', '--name', '--mcp-config', '--settings']));
    for (const headless of ['-p', '--input-format', '--output-format', 'stream-json', '--permission-prompt-tool']) expect(argv).not.toContain(headless);
    const settings = JSON.parse(pty.args[pty.args.indexOf('--settings') + 1] as string) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks).sort()).toEqual(['PermissionRequest', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(JSON.stringify(settings)).toContain(HOOK_MARKER);
    expect(pty.cwd).toBe(w.workspace);
    // Its environment: the agent's marker (D127), the account's config dir; no other Switchboard internal.
    expect(pty.env['SWITCHBOARD_SESSION']).toBe(started.id);
    expect(Object.keys(pty.env).filter((key) => /^SWITCHBOARD_/i.test(key))).toEqual(['SWITCHBOARD_SESSION']);
    expect(pty.env['CLAUDE_CONFIG_DIR']).toBe(w.configDir);
    // The terminal is the agent's profile's (Default here): listed for this browser.
    expect(((await call('GET', '/api/terminals')).json() as { terminals: Array<{ id: string }> }).terminals.map((t) => t.id)).toEqual([cli.cliMode?.terminalId]);

    // The chat follows it through the hooks; a message from the composer waits for the CLI (D48's mailbox).
    expect((await hookCall(w, started.claudeSessionId, { hook_event_name: 'SessionStart' })).statusCode).toBeLessThan(300);
    expect((await call('POST', `/api/sessions/${started.id}/messages`, { text: 'Also add a test.' })).statusCode).toBe(202);
    expect((await w.store.pendingMessages.pending(started.id)).map((m) => [m.kind, m.text])).toEqual([[HOOK_MESSAGE_KIND, 'Also add a test.']]);

    // Back to chat mode: Ctrl-C twice ends the CLI, its terminal closes, the same record resumes headless.
    const back = await call('DELETE', `/api/sessions/${started.id}/cli-mode`);
    expect(back.statusCode, back.body).toBe(200);
    expect(pty.writes.filter((data) => data === '\x03')).toHaveLength(2);
    expect(pty.exited).toBe(true);
    const after = back.json() as Session;
    expect(after).toMatchObject({ id: started.id, claudeSessionId: started.claudeSessionId, hooked: false, attached: true });
    expect(after.cliMode).toBeUndefined();
    expect(((await call('GET', '/api/terminals')).json() as { terminals: unknown[] }).terminals).toEqual([]);
    await until(async () => w.supervisor.isLive(started.id), 'the headless process again');
    // Not in CLI mode any more: 409.
    expect((await call('DELETE', `/api/sessions/${started.id}/cli-mode`)).json()).toMatchObject({ error: 'not-cli-mode' });
  });

  it('a running turn: refused (turn-running) unless stopTurn, which stops it first; the CLI exiting by itself is back to chat mode', async () => {
    const w = await setup();
    const started = await w.supervisor.start(newSession({ task: '[fake:hold 30] Think about it.' }), w.place);
    await waitForStatus(w.store, started.id, ['run']);
    const refused = await call('POST', `/api/sessions/${started.id}/cli-mode`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'turn-running' });
    expect(ptys).toHaveLength(0);
    expect(w.supervisor.isLive(started.id)).toBe(true);

    const entered = await call('POST', `/api/sessions/${started.id}/cli-mode`, { stopTurn: true });
    expect(entered.statusCode, entered.body).toBe(200);
    expect(w.supervisor.isLive(started.id)).toBe(false);

    // The developer typed /exit in the CLI: back to chat mode by itself.
    (ptys[0] as FakePty).exit(0);
    const back = await until(async () => {
      const now = await session(started.id);
      return now.cliMode || now.hooked ? undefined : now;
    }, 'back in chat mode');
    expect(back).toMatchObject({ hooked: false, attached: true });
  });

  it('a restart: an agent still in CLI mode comes back in chat mode (idle, no process), with a line in its chat', async () => {
    const w = await setup();
    const started = await w.supervisor.start(newSession({ task: 'Say hi.' }), w.place);
    await waitForStatus(w.store, started.id, ['done', 'idle']);
    expect((await call('POST', `/api/sessions/${started.id}/cli-mode`, {})).statusCode).toBe(200);
    // Switchboard stops (its terminals end with it), then starts again.
    await app?.close();
    expect((await w.store.sessions.get(started.id))?.cliTerminalId).toEqual(expect.any(String));
    await startApp(w);
    const now = await session(started.id);
    expect(now).toMatchObject({ hooked: false, attached: true });
    expect(now.cliMode).toBeUndefined();
    expect(lifecycles((await call('GET', `/api/sessions/${started.id}/events`)).json() as SessionEvent[])).toContain(CLI_MODE_RESTART_LABEL);
  });

  it('refusals: a Codex agent, a conversation, another profile (404); the routes are on the peer and phone allow lists', async () => {
    const w = await setup();
    const codex = await w.store.sessions.create({ name: 'codex-agent', claudeSessionId: 'c0dex000-0000-4000-8000-000000000001', provider: 'codex', cwd: w.workspace, root: w.workspace });
    expect((await call('POST', `/api/sessions/${codex.id}/cli-mode`, {})).json()).toMatchObject({ error: 'not-available' });
    const chat = await w.store.sessions.create({ name: 'a-chat', claudeSessionId: 'c4a70000-0000-4000-8000-000000000002', kind: 'chat', cwd: w.workspace });
    expect((await call('POST', `/api/sessions/${chat.id}/cli-mode`, {})).json()).toMatchObject({ error: 'chat' });
    // Another profile does not see the agent at all.
    const bo = (await call('POST', '/api/user-profiles', { name: 'Bo', color: 'amber' })).json() as { id: string };
    const switched = await call('POST', '/api/user-profiles/switch', { id: bo.id });
    const cookie = String(switched.headers['set-cookie']).split(';')[0] as string;
    const started = await w.supervisor.start(newSession({ task: 'Say hi.' }), w.place);
    await waitForStatus(w.store, started.id, ['done', 'idle']);
    expect((await call('POST', `/api/sessions/${started.id}/cli-mode`, {}, cookie)).statusCode).toBe(404);
    expect(ptys).toHaveLength(0);
    // A paired computer's agent and a paired phone (D170's ruling) reach the routes.
    for (const method of ['POST', 'DELETE'] as const) {
      expect(peerApiAllowed(method, '/api/sessions/s1/cli-mode')).toBe(true);
      expect(DEVICE_ALLOWED.some(([methods, pattern]) => methods.split('|').includes(method) && pattern.test('/api/sessions/s1/cli-mode'))).toBe(true);
    }
  });
});
