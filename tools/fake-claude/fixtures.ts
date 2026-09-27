import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type JsonObject, asArray, asObject, asString, isObject, parseNdjson } from './json.ts';

/** `tools/fake-claude/fixtures/`: the M0 recordings (`docs/spike-m0.md`). */
export const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

/** The repo path the fixtures were recorded under (home dir scrubbed to `/Users/dev`). */
export const RECORDED_REPO = '/Users/dev/RiderProjects/Acme Corp/workspace/other/switchboard';

/**
 * One step of a turn playback.
 * - `line`: emit the recorded stdout line (rewritten).
 * - `replay`: where the `isReplay` echo of the stdin message goes (only with `--replay-user-messages`).
 * - `request`: a `control_request/can_use_tool`; it opens a request the host must answer.
 * - `answer`: the recorded `tool_result` for the open request. Playback blocks here until the
 *   `control_response` arrives, then emits the result built from that response.
 * - `wait`: the recorded interrupt point (a tool still running, a question still open, a hang).
 *   Playback blocks until an interrupt / SIGINT; the steps after it are the interrupt tail.
 * - `ack`: the `control_response` to the interrupt, at the position it was recorded.
 * - `crash`: exit 1 right here, unasked.
 */
export type Step =
  | { readonly t: 'line'; readonly line: JsonObject }
  | { readonly t: 'replay' }
  | { readonly t: 'request'; readonly line: JsonObject }
  | { readonly t: 'answer'; readonly line: JsonObject }
  | { readonly t: 'wait' }
  | { readonly t: 'ack' }
  | { readonly t: 'crash' };

/** The steps one stdin user message plays. */
export type Turn = readonly Step[];

/** `manifest.json` → `scenarios.<name>`. */
export interface ManifestScenario {
  cwd: string;
  argv: string[];
  exitCode: number;
  stdout: string;
  stdin: string | null;
  stdinPlan: string | null;
  note: string;
}

/** `manifest.json` → `textRuns.<name>` (text-mode terminal runs, M0.4). */
export interface ManifestTextRun {
  cwd: string;
  argv: string[];
  exitCode: number;
  stdoutText: string;
  note: string;
}

/** `manifest.json` → `transcripts.<name>`. */
export interface ManifestTranscript {
  file: string;
  sessionId: string;
  scenario: string;
  projectDir: string;
  note: string;
}

/** `fixtures/manifest.json`. */
export interface Manifest {
  cliVersion: string;
  homeReplacedWith: string;
  scenarios: Record<string, ManifestScenario>;
  transcripts: Record<string, ManifestTranscript>;
  textRuns: Record<string, ManifestTextRun>;
}

/** A recorded scenario, split into turns. */
export interface Fixture {
  readonly name: string;
  /** Absolute cwd of the recording (`RECORDED_REPO` + manifest `cwd`). */
  readonly recordedCwd: string;
  /** Every `session_id` value in the recording (all are rewritten to the current id). */
  readonly sessionIds: readonly string[];
  readonly stdout: readonly JsonObject[];
  readonly stdin: readonly JsonObject[];
  /** Leading `SessionStart` hook lines (emitted at spawn, before any message). */
  readonly preamble: readonly JsonObject[];
  readonly turns: readonly Turn[];
}

/**
 * Where the recorded interrupt point is when no interrupt `control_response`
 * marks it: `sigint` got SIGINT (no stdin request) while the model was streaming
 * after its backgrounded Bash call; everything from the `task_notification` on
 * came after the signal.
 */
const WAIT_BEFORE: Record<string, (line: JsonObject) => boolean> = {
  sigint: (line) => line['type'] === 'system' && line['subtype'] === 'task_notification',
};

function isSessionStartHook(line: JsonObject): boolean {
  return (
    line['type'] === 'system' &&
    (line['subtype'] === 'hook_started' || line['subtype'] === 'hook_response') &&
    line['hook_event'] === 'SessionStart'
  );
}

/** `true` for a `result` that closes a background agent (no stdin message behind it). */
export function isTaskNotificationResult(line: JsonObject): boolean {
  return line['type'] === 'result' && asObject(line['origin'])?.['kind'] === 'task-notification';
}

/** `true` for the `control_response` to an interrupt (`response.response.still_queued`). */
export function isInterruptAck(line: JsonObject): boolean {
  return asObject(asObject(line['response'])?.['response'])?.['still_queued'] !== undefined;
}

/** The `tool_use_id`s of the `tool_result` blocks in a `user` line. */
export function toolResultIds(line: JsonObject): string[] {
  if (line['type'] !== 'user') return [];
  const content = asObject(line['message'])?.['content'];
  const ids: string[] = [];
  for (const block of asArray(content)) {
    if (isObject(block) && block['type'] === 'tool_result') {
      const id = asString(block['tool_use_id']);
      if (id) ids.push(id);
    }
  }
  return ids;
}

/** The `request` object of a `control_request` line. */
export function requestOf(line: JsonObject): JsonObject | undefined {
  return line['type'] === 'control_request' ? asObject(line['request']) : undefined;
}

function compileTurn(chunk: readonly JsonObject[], waitBefore?: (line: JsonObject) => boolean): Step[] {
  const steps: Step[] = [];
  let openToolUse: string | null = null;
  let sawReplay = false;
  let mainResultSeen = false;
  for (const line of chunk) {
    const type = line['type'];
    if (type === 'user' && line['isReplay'] === true) {
      steps.push({ t: 'replay' });
      sawReplay = true;
      continue;
    }
    if (type === 'control_response') {
      // Replies to stdin control requests are generated when the request arrives.
      // Only an interrupt ack that came mid-turn stays, as the marker of the recorded interrupt point.
      if (!mainResultSeen && isInterruptAck(line)) {
        steps.push({ t: 'ack' });
        openToolUse = null;
      }
      continue;
    }
    if (type === 'control_cancel_request') {
      steps.push({ t: 'line', line });
      openToolUse = null;
      continue;
    }
    const request = requestOf(line);
    if (request?.['subtype'] === 'can_use_tool') {
      steps.push({ t: 'request', line });
      openToolUse = asString(request['tool_use_id']) ?? null;
      continue;
    }
    if (openToolUse !== null && toolResultIds(line).includes(openToolUse)) {
      steps.push({ t: 'answer', line });
      openToolUse = null;
      continue;
    }
    if (type === 'result' && !isTaskNotificationResult(line)) mainResultSeen = true;
    steps.push({ t: 'line', line });
  }

  if (!sawReplay) {
    let at = steps.findIndex((s) => s.t === 'line' && s.line['type'] === 'assistant');
    if (at < 0) at = steps.findIndex((s) => s.t === 'line' && s.line['type'] === 'result');
    if (at < 0) at = steps.length;
    steps.splice(at, 0, { t: 'replay' });
  }

  let waitAt = steps.findIndex((s) => s.t === 'ack');
  if (waitAt > 0) {
    const before = steps[waitAt - 1];
    if (before?.t === 'line' && before.line['type'] === 'control_cancel_request') waitAt -= 1;
  } else if (waitBefore) {
    waitAt = steps.findIndex((s) => s.t === 'line' && waitBefore(s.line));
  }
  if (waitAt >= 0) steps.splice(waitAt, 0, { t: 'wait' });
  return steps;
}

/**
 * Splits a recorded stdout into the spawn preamble and one {@link Turn} per stdin
 * user message: a turn ends with its `result`; a later `result` with
 * `origin.kind:"task-notification"` (a background agent finishing) and any lines
 * after the last result stay in the same turn.
 */
export function compileFixture(
  name: string,
  stdout: readonly JsonObject[],
): { preamble: JsonObject[]; turns: Step[][] } {
  let i = 0;
  const preamble: JsonObject[] = [];
  while (i < stdout.length && isSessionStartHook(stdout[i] as JsonObject)) preamble.push(stdout[i++] as JsonObject);

  const chunks: JsonObject[][] = [];
  let current: JsonObject[] = [];
  for (const line of stdout.slice(i)) {
    current.push(line);
    if (line['type'] !== 'result') continue;
    const previous = chunks[chunks.length - 1];
    if (isTaskNotificationResult(line) && previous) previous.push(...current);
    else chunks.push(current);
    current = [];
  }
  const last = chunks[chunks.length - 1];
  if (current.length > 0 && last) last.push(...current);

  return { preamble, turns: chunks.map((chunk) => compileTurn(chunk, WAIT_BEFORE[name])) };
}

/** Loads `manifest.json` and compiles fixtures on demand (each file is read once). */
export class FixtureStore {
  readonly manifest: Manifest;
  private readonly dir: string;
  private readonly cache = new Map<string, Promise<Fixture>>();
  private readonly loadedList: Fixture[] = [];

  private constructor(dir: string, manifest: Manifest) {
    this.dir = dir;
    this.manifest = manifest;
  }

  /** Reads `<dir>/manifest.json`. */
  static async open(dir: string = FIXTURES_DIR): Promise<FixtureStore> {
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
    return new FixtureStore(dir, manifest);
  }

  /** `true` if `name` is a recorded scenario in the manifest. */
  hasScenario(name: string): boolean {
    return Object.hasOwn(this.manifest.scenarios, name);
  }

  /** Fixtures loaded so far (the rewrite tables are built from them). */
  loaded(): readonly Fixture[] {
    return this.loadedList;
  }

  /** The compiled fixture for a manifest scenario. */
  fixture(name: string): Promise<Fixture> {
    let pending = this.cache.get(name);
    if (!pending) {
      pending = this.load(name);
      this.cache.set(name, pending);
    }
    return pending;
  }

  /** Lines of `fixtures/transcripts/<name>.jsonl`. */
  async transcript(name: string): Promise<JsonObject[]> {
    return parseNdjson(await readFile(path.join(this.dir, 'transcripts', `${name}.jsonl`), 'utf8'));
  }

  private async load(name: string): Promise<Fixture> {
    const entry = this.manifest.scenarios[name];
    if (!entry) throw new Error(`no fixture scenario "${name}"`);
    const stdout = parseNdjson(await readFile(path.join(this.dir, entry.stdout), 'utf8'));
    const stdin = entry.stdin ? parseNdjson(await readFile(path.join(this.dir, entry.stdin), 'utf8')) : [];
    const sessionIds = new Set<string>();
    for (const line of stdout) {
      const id = asString(line['session_id']);
      if (id) sessionIds.add(id);
    }
    const { preamble, turns } = compileFixture(name, stdout);
    const fixture: Fixture = {
      name,
      recordedCwd: `${RECORDED_REPO}/${entry.cwd.replace(/^\.\//, '')}`,
      sessionIds: [...sessionIds],
      stdout,
      stdin,
      preamble,
      turns,
    };
    this.loadedList.push(fixture);
    return fixture;
  }
}
