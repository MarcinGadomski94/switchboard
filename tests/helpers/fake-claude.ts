import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fakeClaudeCommand } from '../../tools/fake-claude/command.ts';
import { type JsonObject, parseNdjson } from '../../tools/fake-claude/json.ts';
import { slugForCwd } from '../../tools/fake-claude/transcript.ts';
import { makeTempDir, removeTempDir } from './net.ts';

/** The baseline argv the SessionSupervisor passes (ARCHITECTURE → Claude Code integration). */
export const BASELINE = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-prompt-tool',
  'stdio',
  '--permission-mode',
  'auto',
] as const;

/** One stdin user message line. */
export function userLine(content: string): JsonObject {
  return { type: 'user', message: { role: 'user', content } };
}

/** An interrupt control request. */
export function interruptLine(requestId = 'req_interrupt_1'): JsonObject {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
}

/** Result of a finished fake process. */
export interface FakeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A running fake-claude child with its parsed stdout. */
export interface FakeRun {
  readonly child: ChildProcess;
  /** Parsed stdout lines so far (NDJSON), or [] in text mode. */
  readonly lines: JsonObject[];
  stdout(): string;
  stderr(): string;
  send(line: object): void;
  end(): void;
  /** Resolves with the `n`-th (1-based) line matching `predicate`. */
  waitFor(predicate: (line: JsonObject) => boolean, n?: number, timeoutMs?: number): Promise<JsonObject>;
  readonly exited: Promise<FakeExit>;
  kill(signal?: NodeJS.Signals): void;
}

/** A temp workspace for one test: a cwd, a CLAUDE_CONFIG_DIR and a log file. */
export interface FakeEnv {
  root: string;
  /** Canonical (realpath) cwd for the fake. */
  cwd: string;
  configDir: string;
  logFile: string;
  cleanup(): Promise<void>;
}

/** Creates a temp dir with `cwd/` and `config/`; paths are canonical so they compare with the fake's `init.cwd`. */
export async function makeFakeEnv(prefix = 'fake'): Promise<FakeEnv> {
  const root = await realpath(await makeTempDir(prefix));
  const cwd = path.join(root, 'work dir');
  const configDir = path.join(root, 'config');
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true });
  return { root, cwd, configDir, logFile: path.join(root, 'fake.log'), cleanup: () => removeTempDir(root) };
}

/** Env for the fake: the parent env without CLAUDE* / FAKE_CLAUDE_*, plus `env`. */
export function fakeEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('CLAUDE') && !key.startsWith('FAKE_CLAUDE_')) clean[key] = value;
  }
  return { ...clean, ...env };
}

/** Spawns the fake through {@link fakeClaudeCommand} (`shell: false`), as the supervisor will. */
export function spawnFake(args: readonly string[], options: { cwd: string; env: Record<string, string> }): FakeRun {
  const [cmd, ...prefix] = fakeClaudeCommand();
  const child = spawn(cmd as string, [...prefix, ...args], {
    cwd: options.cwd,
    env: fakeEnv(options.env),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let partial = '';
  const lines: JsonObject[] = [];
  const listeners = new Set<() => void>();
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk;
    partial += chunk;
    let nl = partial.indexOf('\n');
    while (nl >= 0) {
      const text = partial.slice(0, nl);
      partial = partial.slice(nl + 1);
      if (text.trim().startsWith('{')) lines.push(JSON.parse(text) as JsonObject);
      nl = partial.indexOf('\n');
    }
    for (const listener of listeners) listener();
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    err += chunk;
  });
  child.stdin?.on('error', () => undefined);
  const exited = new Promise<FakeExit>((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));

  return {
    child,
    lines,
    stdout: () => out,
    stderr: () => err,
    send: (line) => {
      child.stdin?.write(`${JSON.stringify(line)}\n`);
    },
    end: () => {
      child.stdin?.end();
    },
    kill: (signal = 'SIGTERM') => {
      child.kill(signal);
    },
    exited,
    waitFor(predicate, n = 1, timeoutMs = 8_000) {
      return new Promise<JsonObject>((resolve, reject) => {
        const check = (): boolean => {
          let seen = 0;
          for (const line of lines) {
            if (predicate(line) && ++seen === n) {
              resolve(line);
              return true;
            }
          }
          return false;
        };
        if (check()) return;
        const timer = setTimeout(() => {
          listeners.delete(onData);
          reject(new Error(`timed out waiting for line #${n}; got ${lines.length} lines; stderr: ${err}`));
        }, timeoutMs);
        const onData = (): void => {
          if (check()) {
            clearTimeout(timer);
            listeners.delete(onData);
          }
        };
        listeners.add(onData);
        void exited.then(() => {
          setTimeout(() => {
            if (listeners.has(onData)) {
              clearTimeout(timer);
              listeners.delete(onData);
              if (!check()) reject(new Error(`fake exited before line #${n}; stderr: ${err}`));
            }
          }, 20);
        });
      });
    },
  };
}

/** Runs the fake to completion (stdin closed at once unless `stdin` is given). */
export async function runFake(
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; stdin?: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const run = spawnFake(args, options);
  if (options.stdin !== undefined) run.child.stdin?.write(options.stdin);
  run.end();
  const { code } = await run.exited;
  return { code, stdout: run.stdout(), stderr: run.stderr() };
}

/** `type` or `type/subtype`. */
export function kind(line: JsonObject): string {
  return typeof line['subtype'] === 'string' ? `${String(line['type'])}/${line['subtype']}` : String(line['type']);
}

/** Resolves after `ms`. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The transcript file of `sessionId` for a process started in `cwd`. */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  return path.join(configDir, 'projects', slugForCwd(cwd), `${sessionId}.jsonl`);
}

/** Parsed transcript entries. */
export async function readTranscript(file: string): Promise<JsonObject[]> {
  return parseNdjson(await readFile(file, 'utf8'));
}

/** Every `*.jsonl` under `<configDir>/projects`. */
export async function listTranscripts(configDir: string): Promise<string[]> {
  const root = path.join(configDir, 'projects');
  let folders: string[] = [];
  try {
    folders = await readdir(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const folder of folders) {
    for (const file of await readdir(path.join(root, folder))) if (file.endsWith('.jsonl')) files.push(path.join(root, folder, file));
  }
  return files;
}
