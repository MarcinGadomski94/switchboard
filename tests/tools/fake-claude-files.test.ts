import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgv } from '../../tools/fake-claude/args.ts';
import { FAKE_CLAUDE_ENTRY, fakeClaudeBinEnv, fakeClaudeCommand } from '../../tools/fake-claude/command.ts';
import { FIXTURES_DIR, type Manifest, RECORDED_REPO } from '../../tools/fake-claude/fixtures.ts';
import { type JsonObject, parseNdjson } from '../../tools/fake-claude/json.ts';
import { slugForCwd } from '../../tools/fake-claude/transcript.ts';
import {
  BASELINE,
  type FakeEnv,
  type FakeRun,
  delay,
  kind,
  listTranscripts,
  makeFakeEnv,
  readTranscript,
  runFake,
  spawnFake,
  transcriptPath,
  userLine,
} from '../helpers/fake-claude.ts';

const SID = '0b7e6c1d-1111-4222-8333-44445555f00d';

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(path.join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as Manifest;
}

function obj(value: unknown): JsonObject {
  return value as JsonObject;
}

function textOf(entry: JsonObject): string {
  const content = obj(entry['message'])['content'];
  if (typeof content === 'string') return content;
  return (content as JsonObject[]).map((b) => (typeof b['text'] === 'string' ? b['text'] : '')).join('');
}

const isResult = (l: JsonObject): boolean => l['type'] === 'result';

let env: FakeEnv;
let runs: FakeRun[] = [];

function start(args: readonly string[], extraEnv: Record<string, string> = {}, cwd?: string): FakeRun {
  const run = spawnFake(args, { cwd: cwd ?? env.cwd, env: { CLAUDE_CONFIG_DIR: env.configDir, ...extraEnv } });
  runs.push(run);
  return run;
}

function run(args: readonly string[], extraEnv: Record<string, string> = {}, cwd?: string, stdin?: string) {
  return runFake(args, { cwd: cwd ?? env.cwd, env: { CLAUDE_CONFIG_DIR: env.configDir, ...extraEnv }, ...(stdin === undefined ? {} : { stdin }) });
}

beforeEach(async () => {
  env = await makeFakeEnv('fake-claude-files');
  runs = [];
});

afterEach(async () => {
  for (const r of runs) {
    if (r.child.exitCode === null && r.child.signalCode === null) {
      r.kill('SIGKILL');
      await r.exited;
    }
  }
  await env.cleanup();
});

describe('fake-claude argv surface', () => {
  it('accepts every argv recorded in fixtures/manifest.json (scenarios and text runs)', async () => {
    const m = await manifest();
    const argvs = [...Object.values(m.scenarios), ...Object.values(m.textRuns)].map((s) => s.argv);
    expect(argvs.length).toBeGreaterThan(30);
    for (const argv of argvs) {
      expect(argv[0]).toBe('claude');
      const command = parseArgv(argv.slice(1));
      expect(command.kind).toBe('run');
      if (command.kind === 'run') expect(command.args.print).toBe(true);
    }
  });

  it('--version, auth status (exit code only) and unknown flags (exit 1)', async () => {
    const version = await run(['--version']);
    expect(version).toMatchObject({ code: 0, stdout: '2.1.283 (Claude Code)\n' });
    expect((await run(['auth', 'status'])).code).toBe(0);
    expect((await run(['auth', 'status', '--json'], { FAKE_CLAUDE_SIGNED_OUT: '1' })).code).toBe(1);
    const bogus = await run(['-p', '--bogus-flag', 'hi']);
    expect(bogus.code).toBe(1);
    expect(bogus.stderr).toContain("unknown option '--bogus-flag'");
    const badMode = await run(['-p', '--permission-mode', 'yolo', 'hi']);
    expect(badMode.code).toBe(1);
    expect(badMode.stderr).toContain("argument 'yolo' is invalid");
    expect((await run(['hi'])).code).toBe(1);
  });

  it('is started through an argv prefix (SWITCHBOARD_CLAUDE_BIN) and is directly executable on macOS/Linux', async () => {
    expect(fakeClaudeCommand()).toEqual([process.execPath, FAKE_CLAUDE_ENTRY]);
    expect(JSON.parse(fakeClaudeBinEnv())).toEqual(fakeClaudeCommand());
    expect((await readFile(FAKE_CLAUDE_ENTRY, 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true);
    if (process.platform !== 'win32') expect((await stat(FAKE_CLAUDE_ENTRY)).mode & 0o111).not.toBe(0);
  });
});

describe('fake-claude transcripts (CLAUDE_CONFIG_DIR)', () => {
  it('slugForCwd reproduces the recorded project folders', async () => {
    const m = await manifest();
    for (const t of Object.values(m.transcripts)) {
      const scenario = m.scenarios[t.scenario];
      if (!scenario) continue;
      expect(slugForCwd(`${RECORDED_REPO}/${scenario.cwd}`)).toBe(t.projectDir);
    }
    const long = `/tmp/${'a'.repeat(120)}/${'b'.repeat(120)}`;
    expect(slugForCwd(long)).toMatch(/^-tmp-a{120}-b{74}-[0-9a-z]+$/);
  });

  it('tx-main: the transcript has the recorded entry kinds, a parentUuid chain, gitBranch and the stdout uuids', async () => {
    const recorded = parseNdjson(await readFile(path.join(FIXTURES_DIR, 'transcripts', 'tx-main.jsonl'), 'utf8'));
    await mkdir(path.join(env.cwd, '.git'), { recursive: true });
    await writeFile(path.join(env.cwd, '.git', 'HEAD'), 'ref: refs/heads/feature/tx-probe\n');
    const fake = start([...BASELINE, '--session-id', SID, '--name', 'sb-tx-probe'], { FAKE_CLAUDE_SCENARIO: 'tx-main' });
    const file = transcriptPath(env.configDir, env.cwd, SID);
    await delay(300);
    await expect(stat(file)).rejects.toThrow();
    fake.send(userLine('Create a file named notes.txt containing the text ALPHA using the Write tool. Then reply with the single word DONE.'));
    await fake.waitFor(isResult);
    fake.send(userLine('Reply with exactly the word: finished'));
    await fake.waitFor(isResult, 2);
    fake.end();
    expect((await fake.exited).code).toBe(0);

    expect(await listTranscripts(env.configDir)).toEqual([file]);
    const entries = await readTranscript(file);
    const written = new Set(['custom-title', 'agent-name', 'queue-operation', 'user', 'assistant', 'last-prompt', 'cost-state']);
    const recordedKinds = [...new Set(recorded.map((e) => String(e['type'])).filter((t) => written.has(t)))].sort();
    expect([...new Set(entries.map((e) => String(e['type'])))].sort()).toEqual(recordedKinds);
    const count = (list: JsonObject[], type: string): number => list.filter((e) => e['type'] === type).length;
    expect(count(entries, 'user')).toBe(count(recorded, 'user'));
    expect(count(entries, 'assistant')).toBe(count(recorded, 'assistant'));
    expect(entries.at(-1)?.['type']).toBe('cost-state');

    const chain = entries.filter((e) => typeof e['uuid'] === 'string');
    chain.forEach((entry, i) => {
      expect(entry['parentUuid']).toBe(i === 0 ? null : chain[i - 1]?.['uuid']);
      expect(entry).toMatchObject({ isSidechain: false, userType: 'external', entrypoint: 'sdk-cli', cwd: env.cwd, sessionId: SID, version: '2.1.283', gitBranch: 'feature/tx-probe' });
    });
    const prompts = entries.filter((e) => e['type'] === 'user' && typeof obj(e['message'])['content'] === 'string');
    expect(prompts.map(textOf)).toEqual([
      'Create a file named notes.txt containing the text ALPHA using the Write tool. Then reply with the single word DONE.',
      'Reply with exactly the word: finished',
    ]);
    expect(prompts[0]).toMatchObject({ promptSource: 'sdk', turnOrigin: 'sdk', permissionMode: 'acceptEdits' });
    const toolResult = entries.find((e) => e['toolUseResult'] !== undefined) as JsonObject;
    expect(obj(toolResult['toolUseResult'])['type']).toBe('create');
    expect(typeof toolResult['sourceToolAssistantUUID']).toBe('string');
    expect(entries.filter((e) => e['type'] === 'custom-title').map((e) => e['customTitle'])).toContain('sb-tx-probe');
    const lastPrompt = entries.filter((e) => e['type'] === 'last-prompt').at(-1) as JsonObject;
    expect(lastPrompt).toMatchObject({ lastPrompt: 'Reply with exactly the word: finished', leafUuid: chain.at(-1)?.['uuid'] });

    const stdoutUuids = fake.lines.filter((l) => l['type'] === 'assistant' || (l['type'] === 'user' && l['tool_use_result'] !== undefined)).map((l) => l['uuid']);
    const transcriptUuids = entries.filter((e) => e['type'] === 'assistant' || e['toolUseResult'] !== undefined).map((e) => e['uuid']);
    expect(transcriptUuids).toEqual(stdoutUuids);
    const lastText = entries.filter((e) => e['type'] === 'assistant').map(textOf).filter(Boolean).at(-1);
    expect(lastText).toBe('finished');
  });

  it('resume: an idle --resume emits only the SessionStart:resume hook pair and writes nothing; turns append to the same file', async () => {
    const first = start([...BASELINE, '--replay-user-messages', '--session-id', SID, '--name', 'sb-handoff'], { FAKE_CLAUDE_SCENARIO: 'handoff-start' });
    first.send(userLine('Remember the code word: tangerine. Reply with just OK.'));
    await first.waitFor(isResult);
    first.end();
    expect((await first.exited).code).toBe(0);
    const file = transcriptPath(env.configDir, env.cwd, SID);
    const before = await readTranscript(file);
    const sizeBefore = (await stat(file)).size;

    const other = path.join(env.root, 'elsewhere');
    await mkdir(other);
    const attach = start([...BASELINE, '--replay-user-messages', '--resume', SID, '--name', 'sb-handoff'], { FAKE_CLAUDE_SCENARIO: 'handoff-reattach' }, other);
    await attach.waitFor((l) => l['subtype'] === 'hook_response');
    await delay(500);
    expect(attach.lines.map(kind)).toEqual(['system/hook_started', 'system/hook_response']);
    expect(attach.lines.map((l) => l['hook_name'])).toEqual(['SessionStart:resume', 'SessionStart:resume']);
    expect(attach.lines.every((l) => l['session_id'] === SID)).toBe(true);
    expect((await stat(file)).size).toBe(sizeBefore);

    attach.send(userLine('What were the two code words?'));
    const result = await attach.waitFor(isResult);
    expect(result['result']).toBe('tangerine, kestrel');
    expect(attach.lines.find((l) => l['subtype'] === 'init')?.['session_id']).toBe(SID);
    attach.end();
    expect((await attach.exited).code).toBe(0);

    expect(await listTranscripts(env.configDir)).toEqual([file]);
    const after = await readTranscript(file);
    expect(after.slice(0, before.length)).toEqual(before);
    const added = after.slice(before.length);
    expect(added.some((e) => e['type'] === 'custom-title')).toBe(false);
    const prompt = added.find((e) => e['type'] === 'user') as JsonObject;
    const tip = before.filter((e) => typeof e['uuid'] === 'string').at(-1);
    expect(prompt['parentUuid']).toBe(tip?.['uuid']);
    expect(prompt['cwd']).toBe(other);
    expect(new Set(after.map((e) => e['sessionId']))).toEqual(new Set([SID]));
  });

  it('resume (prompt mode, recorded): same session id, context replayed; --fork-session gets a new id and a copied file', async () => {
    const recorded = parseNdjson(await readFile(path.join(FIXTURES_DIR, 'resume.ndjson'), 'utf8'));
    const created = start([...BASELINE, '--session-id', SID, '--replay-user-messages'], { FAKE_CLAUDE_SCENARIO: 'multiturn' });
    created.send(userLine('Remember the code word: zeppelin. Reply with just OK.'));
    await created.waitFor(isResult);
    created.end();
    expect((await created.exited).code).toBe(0);

    const args = ['-p', 'What code word did I ask you to remember?', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
    const resumed = start([...args, '--resume', SID], { FAKE_CLAUDE_SCENARIO: 'resume' });
    expect((await resumed.exited).code).toBe(0);
    expect(resumed.lines.map(kind)).toEqual(recorded.map(kind));
    expect(resumed.lines.every((l) => l['session_id'] === SID)).toBe(true);
    expect(resumed.lines.at(-1)?.['result']).toBe('zeppelin');

    const forked = start([...args, '--resume', SID, '--fork-session'], { FAKE_CLAUDE_SCENARIO: 'fork' });
    expect((await forked.exited).code).toBe(0);
    const forkId = String(forked.lines.find((l) => l['subtype'] === 'init')?.['session_id']);
    expect(forkId).not.toBe(SID);
    expect(forked.lines.every((l) => l['session_id'] === forkId)).toBe(true);
    const original = await readTranscript(transcriptPath(env.configDir, env.cwd, SID));
    const copy = await readTranscript(transcriptPath(env.configDir, env.cwd, forkId));
    expect(copy.length).toBeGreaterThan(original.length);
    expect(new Set(copy.map((e) => e['sessionId']))).toEqual(new Set([forkId]));
    expect(copy.filter((e) => e['type'] === 'user').map(textOf)).toContain('Remember the code word: zeppelin. Reply with just OK.');
  });

  it('--resume of an unknown id exits 1 (no conversation found); --resume without CLAUDE_CONFIG_DIR is refused', async () => {
    const missing = await run([...BASELINE, '--resume', '9d9d9d9d-0000-4000-8000-000000000000']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('No conversation found with session ID: 9d9d9d9d-0000-4000-8000-000000000000');
    const noConfig = await runFake([...BASELINE, '--resume', SID], { cwd: env.cwd, env: {} });
    expect(noConfig.code).toBe(1);
    expect(noConfig.stderr).toContain('CLAUDE_CONFIG_DIR');
  });

  it('text mode: -p "<prompt>" prints only the final text; -p --resume appends to the same transcript', async () => {
    const first = await run(['-p', '--session-id', SID, 'Hello there'], { FAKE_CLAUDE_SCENARIO: 'eof-immediate' });
    expect(first).toMatchObject({ code: 0, stdout: 'pong\n' });
    const again = await run(['-p', '--resume', SID, '--model', 'haiku', '--max-turns', '3', 'And again']);
    expect(again).toMatchObject({ code: 0, stdout: 'OK\n' });
    const entries = await readTranscript(transcriptPath(env.configDir, env.cwd, SID));
    const prompts = entries.filter((e) => e['type'] === 'user').map(textOf);
    expect(prompts).toEqual(['Hello there', 'And again']);
    expect(entries.filter((e) => e['type'] === 'mode')).toHaveLength(2);
    expect(entries.filter((e) => e['type'] === 'cost-state')).toHaveLength(2);
    const piped = await run(['-p'], {}, undefined, 'from stdin\n');
    expect(piped).toMatchObject({ code: 0, stdout: 'OK\n' });
  });
});

describe('fake-claude live-process files, agents --json and FAKE_CLAUDE_LOG', () => {
  it('sessions/<pid>.json is listed by agents --json while the process lives (busy during a turn) and removed on exit', async () => {
    const fake = start([...BASELINE, '--session-id', SID, '--name', 'sb-live'], { FAKE_CLAUDE_SCENARIO: 'hang' });
    await fake.waitFor((l) => l['subtype'] === 'hook_response');
    await delay(100);
    const idle = JSON.parse((await run(['agents', '--json'])).stdout) as JsonObject[];
    expect(idle).toEqual([{ pid: fake.child.pid, cwd: env.cwd, kind: 'interactive', startedAt: expect.any(Number), sessionId: SID, name: 'sb-live', status: 'idle' }]);

    fake.send(userLine('hang now'));
    await fake.waitFor((l) => l['subtype'] === 'init');
    await delay(100);
    const busy = JSON.parse((await run(['agents', '--json', '--cwd', env.cwd])).stdout) as JsonObject[];
    expect(busy.map((r) => r['status'])).toEqual(['busy']);
    const elsewhere = JSON.parse((await run(['agents', '--json', '--cwd', env.root])).stdout) as JsonObject[];
    expect(elsewhere).toEqual([]);

    fake.kill('SIGINT');
    expect((await fake.exited).code).toBe(0);
    expect(JSON.parse((await run(['agents', '--json'])).stdout)).toEqual([]);
    expect(await readdir(path.join(env.configDir, 'sessions'))).toEqual([]);
  });

  it('a crashed process leaves its live file, but agents --json does not list a dead pid', async () => {
    const fake = start(BASELINE, { FAKE_CLAUDE_SCENARIO: 'crash' });
    fake.send(userLine('crash'));
    expect((await fake.exited).code).toBe(1);
    expect(await readdir(path.join(env.configDir, 'sessions'))).toEqual([`${fake.child.pid}.json`]);
    expect(JSON.parse((await run(['agents', '--json'])).stdout)).toEqual([]);
  });

  it('FAKE_CLAUDE_LOG records argv, cwd, CLAUDE* names and every stdin line verbatim', async () => {
    const args = [...BASELINE, '--session-id', SID];
    const fake = start(args, { FAKE_CLAUDE_LOG: env.logFile, CLAUDECODE: '1' });
    const first = JSON.stringify(userLine('first message'));
    fake.child.stdin?.write(`${first}\n`);
    await fake.waitFor(isResult);
    fake.child.stdin?.write('{"type":"control_request","request_id":"x","request":{"subtype":"interrupt"}}\n');
    await fake.waitFor((l) => l['type'] === 'control_response');
    fake.end();
    await fake.exited;
    const log = parseNdjson(await readFile(env.logFile, 'utf8'));
    expect(log[0]).toMatchObject({ kind: 'argv', argv: args, cwd: env.cwd, pid: fake.child.pid, env: { CLAUDE_CONFIG_DIR: env.configDir, FAKE_CLAUDE_LOG: env.logFile } });
    expect(log[0]?.['claudeEnvKeys']).toEqual(['CLAUDECODE', 'CLAUDE_CONFIG_DIR']);
    expect(obj(log[0]?.['env'])['CLAUDECODE']).toBeUndefined();
    expect(log.slice(1)).toEqual([
      { kind: 'stdin', line: first, pid: fake.child.pid },
      { kind: 'stdin', line: '{"type":"control_request","request_id":"x","request":{"subtype":"interrupt"}}', pid: fake.child.pid },
    ]);
  });

  it('without CLAUDE_CONFIG_DIR nothing is written and a warning goes to stderr', async () => {
    const result = await runFake(['-p', 'hi'], { cwd: env.cwd, env: {} });
    expect(result).toMatchObject({ code: 0, stdout: 'OK\n' });
    expect(result.stderr).toContain('CLAUDE_CONFIG_DIR is not set');
    expect(await readdir(env.configDir)).toEqual([]);
  });
});
