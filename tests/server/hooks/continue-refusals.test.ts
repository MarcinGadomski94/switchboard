import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { TerminalAgentRow } from '../../../src/core/hooks.ts';
import { buildApp, createSessionServices } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HookService } from '../../../src/server/hooks/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { HOOK_TOKEN_FILE, generateToken, loadOrCreateToken } from '../../../src/server/token.ts';
import { fakeClaudeBinEnv } from '../../../tools/fake-claude/command.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { assistantTextLine, lastUuid, terminalUserLine, writeTranscript } from '../../helpers/transcripts.ts';

/**
 * D72 refusals over the real routes (`inject`, no process is ever started): a stop
 * that fails leaves everything as it was (still hooked, nothing sent, the reason
 * shown); a registry that cannot be read is "unknown", never "gone". (A closed
 * hooked session is reopened and converted: `continue.test.ts`.)
 */

const PORT = 4962;
const HOST = `127.0.0.1:${PORT}`;
const CS = '3e2d1c0b-1111-4222-8333-944455556666';

interface Rig {
  readonly root: string;
  readonly store: Store;
  readonly app: FastifyInstance;
  readonly token: string;
  readonly holder: { rows: TerminalAgentRow[] | null };
  readonly signals: string[];
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.app.close();
  await rig?.store.close();
  if (rig) await removeTempDir(rig.root);
  rig = undefined;
});

async function setup(): Promise<Rig> {
  const root = await makeTempDir('hooked-continue-refusals');
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'claude-config');
  const cwd = path.join(root, 'project');
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const store = await openTempStore(dataDir);
  // Never the real CLI, even if something tried to start one.
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dataDir, SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv() }, platform: 'linux', home: root, cwd: root }), port: PORT };
  const bus = new HubBus();
  const { supervisor, questions } = createSessionServices(config, store, bus);
  const hookToken = await loadOrCreateToken(dataDir, HOOK_TOKEN_FILE);
  const holder: { rows: TerminalAgentRow[] | null } = { rows: [] };
  const signals: string[] = [];
  const hooks = new HookService({
    config,
    store,
    bus,
    questions,
    hookTokenFile: path.join(dataDir, HOOK_TOKEN_FILE),
    env: { CLAUDE_CONFIG_DIR: configDir },
    listAgents: async () => holder.rows,
    cliVersion: async () => '2.1.284 (Claude Code)',
    // A terminal `claude` that never goes away: the polite stop and the force both fail.
    stop: { graceMs: 20, alive: () => true, signal: (_pid, signal) => void signals.push(signal) },
  });
  const token = generateToken();
  const app = await buildApp({ config, token, store, webRoot: root, supervisor, questions, bus, hooks, hookToken, agentTools: false });
  await app.ready();
  const lines = [terminalUserLine({ sessionId: CS, cwd, content: 'Fix the flaky test.', parentUuid: null, timestamp: '2026-10-05T10:00:00.000Z' })];
  lines.push(assistantTextLine({ sessionId: CS, cwd, text: 'Looking at it.', parentUuid: lastUuid(lines), timestamp: '2026-10-05T10:00:05.000Z' }));
  await writeTranscript(configDir, cwd, CS, lines);
  holder.rows = [{ pid: 424242, sessionId: CS, cwd, kind: 'interactive', name: 'flaky-fix', status: 'idle', waitingFor: null, startedAt: Date.parse('2026-10-05T09:59:00.000Z') }];
  rig = { root, store, app, token, holder, signals };
  return rig;
}

function api(r: Rig, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return r.app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${r.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

describe('D72: refusals that change nothing', () => {
  it('a stop that fails: 502 stop-failed with the reason; the session stays hooked and its queued message stays in the mailbox', async () => {
    const r = await setup();
    const hooked = (await api(r, 'POST', `/api/terminal-sessions/${CS}/hook`)).json() as Session;
    expect(hooked.hooked).toBe(true);
    expect((await api(r, 'POST', `/api/sessions/${hooked.id}/messages`, { text: 'Also rename it.' })).statusCode).toBe(202);

    const answer = await api(r, 'POST', `/api/sessions/${hooked.id}/continue-in-switchboard`, { confirmStopTerminal: true });
    expect(answer.statusCode).toBe(502);
    expect(answer.json()).toMatchObject({ error: 'stop-failed' });
    expect((answer.json() as { message: string }).message).toContain('still running after SIGKILL');
    expect(r.signals).toEqual(['SIGTERM', 'SIGKILL']);

    const after = (await api(r, 'GET', `/api/sessions/${hooked.id}`)).json() as Session;
    expect(after).toMatchObject({ hooked: true, attached: false });
    const pending = await r.store.pendingMessages.pending(hooked.id);
    expect(pending.map((message) => [message.kind, message.text])).toEqual([['hook-message', 'Also rename it.']]);
    const events = await r.store.events.list(hooked.id);
    expect(events.some((event) => (event.payload as { action?: string } | null)?.action === 'continued')).toBe(false);
    expect(events.some((event) => (event.payload as { withdrawn?: boolean } | null)?.withdrawn === true)).toBe(false);
  }, 20_000);

  it('a registry that cannot be read: 409 terminal-unknown (never taken as gone), without stopping anything', async () => {
    const r = await setup();
    const hooked = (await api(r, 'POST', `/api/terminal-sessions/${CS}/hook`)).json() as Session;
    r.holder.rows = null;
    const answer = await api(r, 'POST', `/api/sessions/${hooked.id}/continue-in-switchboard`, { confirmStopTerminal: true });
    expect(answer.statusCode).toBe(409);
    expect(answer.json()).toMatchObject({ error: 'terminal-unknown' });
    expect(r.signals).toEqual([]);
    expect(((await api(r, 'GET', `/api/sessions/${hooked.id}`)).json() as Session).hooked).toBe(true);
  });
});
