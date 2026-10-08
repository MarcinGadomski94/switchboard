/**
 * M2.4 oracle (D7 crash recovery): the real server entry point runs as a child
 * process with fake-claude as the CLI, is SIGKILLed while one session is in a
 * `hang` turn and another has an open question, and is started again on the same
 * data folder. No demo seed.
 */
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, SessionEvent } from '../../../src/core/api.ts';
import type { LifecyclePayload, ToolPayload } from '../../../src/core/event-payload.ts';
import { DEFAULT_STANDING_INSTRUCTION } from '../../../src/core/settings.ts';
import { storeFile } from '../../../src/server/db/store.ts';
import { RESTART_MESSAGE, RESTART_NOTE } from '../../../src/server/supervisor/recovery.ts';
import { TOKEN_FILE } from '../../../src/server/token.ts';
import { fakeClaudeBinEnv } from '../../../tools/fake-claude/command.ts';
import { seedFolderInDataDir } from '../../helpers/folders.ts';
import { BASELINE, delay, userLine } from '../../helpers/fake-claude.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type ServerProcess, spawnServer, startServer } from '../../helpers/server-process.ts';
import { requestJson } from '../../helpers/sse.ts';
import { newSession, spawnedArgv, stdinOf, until } from '../../helpers/supervisor.ts';

let tmp: string;
let server: ServerProcess | undefined;
let logFile: string;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

beforeEach(async () => {
  tmp = await realpath(await makeTempDir('restart'));
  logFile = path.join(tmp, 'fake.log');
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  // Never leave a fake behind, whatever failed.
  for (const line of await spawnedArgv(logFile)) if (alive(line.pid)) process.kill(line.pid, 'SIGKILL');
  await removeTempDir(tmp);
});

/**
 * Samples `<configDir>/sessions/*.json` (the fake's live-process files, M1.2) every
 * few ms and remembers the most processes that were alive at once per session id.
 */
function sampleLiveFiles(configDir: string): { stop(): Promise<Map<string, number>>; seen: Set<number> } {
  const most = new Map<string, number>();
  const seen = new Set<number>();
  let running = true;
  const loop = (async () => {
    while (running) {
      let files: string[] = [];
      try {
        files = (await readdir(path.join(configDir, 'sessions'))).filter((file) => file.endsWith('.json'));
      } catch {
        files = [];
      }
      const count = new Map<string, number>();
      for (const file of files) {
        let row: { pid?: unknown; sessionId?: unknown };
        try {
          row = JSON.parse(await readFile(path.join(configDir, 'sessions', file), 'utf8')) as typeof row;
        } catch {
          continue;
        }
        if (typeof row.pid !== 'number' || typeof row.sessionId !== 'string' || !alive(row.pid)) continue;
        seen.add(row.pid);
        count.set(row.sessionId, (count.get(row.sessionId) ?? 0) + 1);
      }
      for (const [id, n] of count) most.set(id, Math.max(most.get(id) ?? 0, n));
      await delay(5);
    }
  })();
  return {
    seen,
    async stop() {
      running = false;
      await loop;
      return most;
    },
  };
}

describe('M2.4 crash recovery (server child process + fake-claude, SIGKILL and restart)', () => {
  it('stops the leftover, resumes both sessions with --resume and the same ids, never two live processes per id; run gets the restart message, need nothing until answered', async () => {
    const workspace = path.join(tmp, 'work space');
    const configDir = path.join(tmp, 'claude-config');
    const dataDir = path.join(tmp, 'data');
    await mkdir(workspace, { recursive: true });
    await mkdir(configDir, { recursive: true });
    // D14: the workspace is a saved folder (the default) in the server's database, as a user saved it.
    await seedFolderInDataDir(dataDir, workspace);
    const env = {
      SWITCHBOARD_DATA_DIR: dataDir,
      SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
      CLAUDE_CONFIG_DIR: configDir,
      FAKE_CLAUDE_LOG: logFile,
      FAKE_CLAUDE_SCENARIO: 'default',
    };

    // ── first life ──────────────────────────────────────────────────────────
    server = await startServer(env);
    const cookie = `sb_token=${(await readFile(path.join(dataDir, TOKEN_FILE), 'utf8')).trim()}`;
    let port = server.port;
    const api = (method: string, url: string, body?: unknown) => requestJson(port, method, url, cookie, body);

    const run = (await api('POST', '/api/sessions', newSession({ name: 'hang-session', task: '[fake:hang] Keep working on it.' }))).body as Session;
    const need = (await api('POST', '/api/sessions', newSession({ name: 'ask-session', task: '[fake:ask-2q] Ask me two questions.' }))).body as Session;
    expect(run.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    const statusOf = async (id: string) => ((await api('GET', `/api/sessions/${id}`)).body as Session).status;
    await until(async () => (await statusOf(run.id)) === 'run', 'the hang session running');
    await until(async () => (await statusOf(need.id)) === 'need', 'the ask session waiting for its answer');

    // Session processes only: `agents --json` checks log their argv too.
    const sessionProcesses = async () => (await spawnedArgv(logFile)).filter((line) => line.argv?.includes('-p'));
    const first = await sessionProcesses();
    expect(first).toHaveLength(2);
    const pidOf = (lines: typeof first, claudeId: string, flag: string) => lines.find((l) => l.argv?.[l.argv.indexOf(flag) + 1] === claudeId && l.argv.includes(flag))?.pid;
    const oldRunPid = pidOf(first, run.claudeSessionId, '--session-id') as number;
    const oldNeedPid = pidOf(first, need.claudeSessionId, '--session-id') as number;
    expect(oldRunPid).toBeGreaterThan(0);
    expect(oldNeedPid).toBeGreaterThan(0);

    const sampler = sampleLiveFiles(configDir);

    // ── crash ───────────────────────────────────────────────────────────────
    server.child.kill('SIGKILL');
    await server.closed;
    server = undefined;
    await delay(300);
    // The hang turn keeps its process alive after the service died (stdin EOF does not end it).
    expect(alive(oldRunPid)).toBe(true);

    // ── second life ─────────────────────────────────────────────────────────
    server = await startServer(env);
    port = server.port;

    // The leftover is stopped (recovery runs right after the server took its port).
    await until(async () => !alive(oldRunPid) && !alive(oldNeedPid), 'the leftovers gone');

    // Two new processes: --resume with the same ids and the baseline flags, never --session-id.
    const all = await until(async () => {
      const lines = await sessionProcesses();
      return lines.length >= 4 ? lines : undefined;
    }, 'two resumed processes');
    expect(all).toHaveLength(4);
    // The leftover was identified through `claude agents --json` (M0.1).
    expect((await spawnedArgv(logFile)).filter((line) => line.argv?.[0] === 'agents').map((line) => line.argv)).toEqual([['agents', '--json']]);
    const resumed = all.slice(2);
    const newRunPid = pidOf(resumed, run.claudeSessionId, '--resume') as number;
    const newNeedPid = pidOf(resumed, need.claudeSessionId, '--resume') as number;
    expect(newRunPid).toBeGreaterThan(0);
    expect(newNeedPid).toBeGreaterThan(0);
    for (const [pid, session] of [[newRunPid, run], [newNeedPid, need]] as const) {
      const line = resumed.find((l) => l.pid === pid);
      expect(line?.argv).toEqual([...BASELINE, '--resume', session.claudeSessionId, '--append-system-prompt', DEFAULT_STANDING_INSTRUCTION, '--mcp-config', expect.stringMatching(/agent-mcp[\\/][^\\/]+\.json$/), '--allowedTools', 'mcp__switchboard', '--name', session.name, '--forward-subagent-text', '--replay-user-messages']);
      expect(line?.cwd).toBe(await realpath(workspace));
    }

    // The run session got the restart message; its turn finishes (fake default reply).
    await until(async () => (await stdinOf(logFile, newRunPid)).length > 0 || undefined, 'the restart message');
    expect(await stdinOf(logFile, newRunPid)).toEqual([userLine(RESTART_MESSAGE)]);
    await until(async () => (await statusOf(run.id)) === 'done', 'the resumed run session finishing its turn');

    // The need session is resumed idle and gets nothing.
    await delay(500);
    expect((await stdinOf(logFile, newNeedPid)).filter((line) => line['type'] === 'user')).toEqual([]);
    expect(await statusOf(need.id)).toBe('idle');

    const most = await sampler.stop();
    expect(sampler.seen.has(oldRunPid)).toBe(true);
    expect(sampler.seen.has(newRunPid)).toBe(true);
    expect(most.get(run.claudeSessionId)).toBe(1);
    expect(most.get(need.claudeSessionId) ?? 0).toBeLessThanOrEqual(1);
    expect([...most.values()].every((n) => n <= 1)).toBe(true);

    // Events: the leftover stop and the resume are recorded; the open question went stale.
    const eventsOf = async (id: string) => (await api('GET', `/api/sessions/${id}/events`)).body as SessionEvent[];
    const lifecycle = (events: SessionEvent[]) =>
      events.map((e) => e.payload as LifecyclePayload).filter((p) => p?.type === 'lifecycle');
    const runLife = lifecycle(await eventsOf(run.id));
    expect(runLife.find((p) => p.action === 'leftover-stopped')).toMatchObject({ leftoverPid: oldRunPid, stoppedBy: 'SIGINT' });
    expect(runLife.find((p) => p.action === 'recovered')).toMatchObject({ pid: newRunPid });
    const needEvents = await eventsOf(need.id);
    expect(lifecycle(needEvents).find((p) => p.action === 'recovered')).toMatchObject({ pid: newNeedPid });
    const ask = needEvents.map((e) => e.payload as ToolPayload).find((p) => p?.type === 'tool' && p.name === 'AskUserQuestion');
    expect(ask?.requestState).toBe('stale');

    // Answered through the contract route (M3.1): the stale batch's answers reach the
    // resumed idle process as its next message, and the note goes with them.
    const batchId = ask?.requestId as string;
    const db = new DatabaseSync(storeFile(dataDir), { readOnly: true });
    let questionIds: string[] = [];
    try {
      const rows = db.prepare('SELECT q.id AS id, b.state AS state FROM questions q JOIN question_batches b ON b.id = q.batch_id WHERE q.batch_id = ? ORDER BY q.position').all(batchId);
      expect(rows.map((row) => row['state'])).toEqual(['stale', 'stale']);
      questionIds = rows.map((row) => String(row['id']));
    } finally {
      db.close();
    }
    const answered = await api('POST', `/api/questions/batch/${batchId}/answers`, {
      answers: [{ questionId: questionIds[0], answerIndex: 2 }, { questionId: questionIds[1], answerIndex: 1 }],
    });
    expect(answered.status).toBe(204);
    const answers = 'Answers to your earlier questions:\n"Which color should the button be?" = "Blue"\n"Which size should it be?" = "Large"';
    await until(async () => (await stdinOf(logFile, newNeedPid)).length > 0 || undefined, 'the answers message');
    expect(await stdinOf(logFile, newNeedPid)).toEqual([userLine(`${RESTART_NOTE}\n\n${answers}`)]);
    await until(async () => (await statusOf(need.id)) === 'done', 'the need session finishing its turn');

    // A second instance on the same port and data folder cannot bind, so it never
    // runs recovery and never touches the first one's processes.
    const agentsCalls = async () => (await spawnedArgv(logFile)).filter((line) => line.argv?.[0] === 'agents').length;
    const second = spawnServer(port, env);
    expect(await second.closed).toBe(1);
    expect(second.output()).toContain('EADDRINUSE');
    expect(alive(newRunPid)).toBe(true);
    expect(alive(newNeedPid)).toBe(true);
    expect(await agentsCalls()).toBe(1);
    expect((await sessionProcesses()).length).toBe(4);

    // A clean stop now keeps no process behind.
    expect(await server.stop()).toBe(0);
    server = undefined;
    await delay(100);
    for (const line of await spawnedArgv(logFile)) expect(alive(line.pid), `pid ${line.pid}`).toBe(false);
  }, 60_000);
});
