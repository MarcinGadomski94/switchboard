import { randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Json, type JsonObject, asArray, asObject, asString, clone, isObject, parseNdjson } from './json.ts';

/**
 * Project-folder name for a cwd, as CLI 2.1.283 computes it (`docs/spike-m0.md`
 * → Transcript location): every char except ASCII letters/digits becomes `-`;
 * past 200 chars the first 200 are kept plus `-` and a base-36 hash of the raw cwd.
 * The fake keeps its own copy on purpose, so it does not agree with a bug in `src/`.
 */
export function slugForCwd(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= 200) return slug;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * `gitBranch` as the CLI records it: the branch checked out at the start cwd
 * (worktrees included, via the `.git` file), `"HEAD"` when detached or not in a repo.
 * Reads `.git/HEAD` directly; no `git` process.
 */
export async function gitBranchOf(cwd: string): Promise<string> {
  let dir = cwd;
  for (;;) {
    const dotGit = path.join(dir, '.git');
    try {
      const info = await stat(dotGit);
      let headFile: string;
      if (info.isDirectory()) {
        headFile = path.join(dotGit, 'HEAD');
      } else {
        const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'));
        if (!pointer?.[1]) return 'HEAD';
        headFile = path.join(path.resolve(dir, pointer[1].trim()), 'HEAD');
      }
      const head = (await readFile(headFile, 'utf8')).trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return ref?.[1] ?? 'HEAD';
    } catch {
      // no .git here: keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return 'HEAD';
    dir = parent;
  }
}

/** Thrown when `--resume <id>` finds no transcript (or finds it in more than one project folder). */
export class ResumeError extends Error {
  override name = 'ResumeError';
}

/**
 * Finds `<configDir>/projects/<slug>/<id>.jsonl`: the cwd's own project folder
 * first, then every project folder (the CLI's explicit-id loader, M0.4).
 */
export async function findTranscript(configDir: string, cwd: string, sessionId: string): Promise<string> {
  const projects = path.join(configDir, 'projects');
  const own = path.join(projects, slugForCwd(cwd), `${sessionId}.jsonl`);
  if (await exists(own)) return own;
  let folders: string[] = [];
  try {
    folders = await readdir(projects);
  } catch {
    folders = [];
  }
  const hits: string[] = [];
  for (const folder of folders) {
    const candidate = path.join(projects, folder, `${sessionId}.jsonl`);
    if (await exists(candidate)) hits.push(candidate);
  }
  if (hits.length === 1 && hits[0]) return hits[0];
  if (hits.length > 1) throw new ResumeError(`No conversation found with session ID: ${sessionId} (it exists in ${hits.length} project folders)`);
  throw new ResumeError(`No conversation found with session ID: ${sessionId}`);
}

/** Entry types that form the `parentUuid` chain. */
const CHAIN_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);

function isChainEntry(entry: JsonObject): boolean {
  return CHAIN_TYPES.has(String(entry['type'])) && typeof entry['uuid'] === 'string' && entry['isSidechain'] !== true;
}

function isInterruptMarker(entry: JsonObject): boolean {
  if (entry['type'] !== 'user') return false;
  return asArray(asObject(entry['message'])?.['content']).some(
    (block) => isObject(block) && typeof block['text'] === 'string' && block['text'].startsWith('[Request interrupted by user'),
  );
}

/** Templates taken from `fixtures/transcripts/` (the shapes the CLI writes). */
export interface TranscriptTemplates {
  /** `cost-state` line (`tx-main`). */
  costState: JsonObject;
  /** The synthetic `No response requested.` assistant line (`handoff-mid`). */
  synthetic: JsonObject;
}

/** Loads {@link TranscriptTemplates} from the transcript fixtures. */
export function templatesFrom(txMain: readonly JsonObject[], handoffMid: readonly JsonObject[]): TranscriptTemplates {
  const costState = txMain.find((e) => e['type'] === 'cost-state');
  const synthetic = handoffMid.find((e) => e['type'] === 'assistant' && asObject(e['message'])?.['model'] === '<synthetic>');
  if (!costState || !synthetic) throw new Error('transcript fixtures lack cost-state or the synthetic line');
  return { costState, synthetic };
}

/** Options for {@link Transcript.open}. */
export interface TranscriptOptions {
  configDir: string;
  /** Canonical cwd of the process. */
  cwd: string;
  sessionId: string;
  /** `--resume <id>`: the id to load (equal to `sessionId` unless forking). */
  resumeFrom: string | null;
  /** `--name` of a new session (resumes never re-append the title, M0.4). */
  name: string | null;
  gitBranch: string;
  version: string;
  templates: TranscriptTemplates;
  now(): string;
}

/**
 * The session transcript `<configDir>/projects/<slug(cwd)>/<sessionId>.jsonl`,
 * written like CLI 2.1.283 writes it (`docs/spike-m0.md` → M0.3/M0.4): created
 * with the first user message, appended per message, `last-prompt` per turn,
 * `custom-title` + `agent-name` for a new session with `--name`, `cost-state`
 * at exit; `--resume` appends to the same file, first adding the synthetic
 * `No response requested.` line when the previous turn was interrupted.
 */
export class Transcript {
  readonly file: string;
  private readonly options: TranscriptOptions;
  private chainTip: string | null;
  private needsSynthetic: boolean;
  private pendingCopy: string[];
  private writes: Promise<void> = Promise.resolve();
  private started = false;
  private lastPrompt: string | null = null;
  private promptId: string | null = null;
  private readonly toolUseOwner = new Map<string, string>();
  private readonly startTime = Date.now();

  private constructor(file: string, options: TranscriptOptions, chainTip: string | null, needsSynthetic: boolean, pendingCopy: string[]) {
    this.file = file;
    this.options = options;
    this.chainTip = chainTip;
    this.needsSynthetic = needsSynthetic;
    this.pendingCopy = pendingCopy;
  }

  /**
   * Opens the transcript for a new session, a resume (same file) or a fork
   * (new file with the old entries copied under the new id).
   * @throws {ResumeError} when `--resume` finds no conversation.
   */
  static async open(options: TranscriptOptions): Promise<Transcript> {
    const own = path.join(options.configDir, 'projects', slugForCwd(options.cwd), `${options.sessionId}.jsonl`);
    if (options.resumeFrom === null) return new Transcript(own, options, null, false, []);

    const source = await findTranscript(options.configDir, options.cwd, options.resumeFrom);
    const entries = parseNdjson(await readFile(source, 'utf8'));
    let tip: JsonObject | null = null;
    for (const entry of entries) if (isChainEntry(entry)) tip = entry;
    const chainTip = tip ? String(tip['uuid']) : null;
    const needsSynthetic = tip !== null && isInterruptMarker(tip);
    if (options.resumeFrom === options.sessionId) return new Transcript(source, options, chainTip, needsSynthetic, []);

    const copy = entries.map((entry) => {
      const next = clone(entry);
      if (typeof next['sessionId'] === 'string') next['sessionId'] = options.sessionId;
      return JSON.stringify(next);
    });
    return new Transcript(own, options, chainTip, needsSynthetic, copy);
  }

  private envelope(extra: JsonObject): JsonObject {
    return {
      parentUuid: this.chainTip,
      isSidechain: false,
      ...extra,
      userType: 'external',
      entrypoint: 'sdk-cli',
      cwd: this.options.cwd,
      sessionId: this.options.sessionId,
      version: this.options.version,
      gitBranch: this.options.gitBranch,
    };
  }

  private append(entries: readonly JsonObject[]): void {
    const pending = this.pendingCopy;
    this.pendingCopy = [];
    const text = [...pending, ...entries.map((e) => JSON.stringify(e))].map((l) => `${l}\n`).join('');
    const { file } = this;
    this.writes = this.writes.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, text);
    });
  }

  private chain(entry: JsonObject): JsonObject {
    this.chainTip = String(entry['uuid']);
    return entry;
  }

  private titleLines(): JsonObject[] {
    const { name, sessionId, resumeFrom } = this.options;
    if (name === null || resumeFrom !== null) return [];
    return [
      { type: 'custom-title', customTitle: name, sessionId },
      { type: 'agent-name', agentName: name, sessionId },
    ];
  }

  /** A user message starts a turn: title (first message of a named new session), queue ops, synthetic line, the prompt. */
  beginTurn(content: Json, promptUuid: string, permissionMode: string): void {
    const now = this.options.now();
    const { sessionId } = this.options;
    const text = typeof content === 'string' ? content : '';
    const entries: JsonObject[] = [];
    if (!this.started) entries.push(...this.titleLines());
    entries.push(
      { type: 'queue-operation', operation: 'enqueue', timestamp: now, sessionId, content: text },
      { type: 'queue-operation', operation: 'dequeue', timestamp: now, sessionId },
    );
    if (this.needsSynthetic) {
      const synthetic = clone(this.options.templates.synthetic);
      entries.push(
        this.chain({
          ...synthetic,
          ...this.envelope({}),
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: now,
          message: { ...asObject(synthetic['message']), id: randomUUID() },
        }),
      );
      this.needsSynthetic = false;
    }
    this.promptId = randomUUID();
    entries.push(
      this.chain(
        this.envelope({
          promptId: this.promptId,
          type: 'user',
          message: { role: 'user', content },
          uuid: promptUuid,
          timestamp: now,
          permissionMode,
          promptSource: 'sdk',
          turnOrigin: 'sdk',
        }),
      ),
    );
    this.started = true;
    this.lastPrompt = text;
    this.append(entries);
  }

  /** Mirrors a main-chain stdout line (assistant, tool_result, interrupt marker) into the transcript. */
  onStdout(line: JsonObject): void {
    if (!this.started || line['parent_tool_use_id'] !== null) return;
    if (line['isReplay'] === true || typeof line['uuid'] !== 'string') return;
    const timestamp = asString(line['timestamp']) ?? this.options.now();
    if (line['type'] === 'assistant') {
      const message = asObject(line['message']);
      for (const block of asArray(message?.['content'])) {
        if (isObject(block) && block['type'] === 'tool_use' && typeof block['id'] === 'string') this.toolUseOwner.set(block['id'], line['uuid']);
      }
      this.append([
        this.chain(
          this.envelope({ message: message ?? null, requestId: line['request_id'] ?? null, type: 'assistant', uuid: line['uuid'], timestamp }),
        ),
      ]);
      return;
    }
    if (line['type'] === 'user') {
      const extra: JsonObject = { promptId: this.promptId, type: 'user', message: line['message'] ?? null, uuid: line['uuid'], timestamp };
      if (line['tool_use_result'] !== undefined) {
        extra['toolUseResult'] = line['tool_use_result'];
        const content = asArray(asObject(line['message'])?.['content']);
        const first = content.find((b) => isObject(b) && typeof b['tool_use_id'] === 'string');
        const owner = isObject(first) ? this.toolUseOwner.get(String(first['tool_use_id'])) : undefined;
        if (owner) extra['sourceToolAssistantUUID'] = owner;
      }
      this.append([this.chain(this.envelope(extra))]);
    }
  }

  /** A turn's `result` arrived: `last-prompt` (+ the title lines of a named new session). */
  endTurn(): void {
    if (!this.started) return;
    const { sessionId } = this.options;
    this.append([{ type: 'last-prompt', lastPrompt: this.lastPrompt ?? '', leafUuid: this.chainTip, sessionId }, ...this.titleLines()]);
  }

  /** Text-mode runs add `{"type":"mode","mode":"normal"}` before `cost-state` (M0.4). */
  markTextMode(): void {
    if (this.started) this.append([{ type: 'mode', mode: 'normal', sessionId: this.options.sessionId }]);
  }

  /** At exit: `cost-state` (only if this process wrote to the file), then waits for every write. */
  async close(): Promise<void> {
    if (this.started) {
      const cost = clone(this.options.templates.costState);
      cost['sessionId'] = this.options.sessionId;
      cost['startTime'] = this.startTime;
      cost['totalDuration'] = Date.now() - this.startTime;
      this.append([cost]);
    }
    await this.writes;
  }

  /** Waits for the writes queued so far. */
  flush(): Promise<void> {
    return this.writes;
  }
}

/** Fields of `<configDir>/sessions/<pid>.json` (the live-process file `claude agents --json` reads). */
export interface LiveInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  version: string;
  kind: 'interactive';
  entrypoint: 'sdk-cli';
  status: 'busy' | 'idle';
  updatedAt: number;
  name: string;
}

/** The live-process file of this fake process. Removed on a normal exit; a crash leaves it behind like a killed CLI. */
export class LiveFile {
  readonly file: string;
  private readonly info: LiveInfo;
  private writes: Promise<void> = Promise.resolve();
  private removed = false;

  constructor(configDir: string, info: Omit<LiveInfo, 'updatedAt' | 'kind' | 'entrypoint'>) {
    this.file = path.join(configDir, 'sessions', `${info.pid}.json`);
    this.info = { ...info, kind: 'interactive', entrypoint: 'sdk-cli', updatedAt: Date.now() };
    this.write();
  }

  private write(): void {
    const text = `${JSON.stringify(this.info)}\n`;
    const { file } = this;
    this.writes = this.writes.then(async () => {
      if (this.removed) return;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    });
  }

  /** busy while a turn runs, idle between turns. */
  setStatus(status: LiveInfo['status']): void {
    if (this.info.status === status) return;
    this.info.status = status;
    this.info.updatedAt = Date.now();
    this.write();
  }

  /** Deletes the file (normal exit). */
  async remove(): Promise<void> {
    await this.writes;
    this.removed = true;
    await rm(this.file, { force: true });
  }

  /** Waits for the writes queued so far. */
  flush(): Promise<void> {
    return this.writes;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One row of `agents --json`, in the field order M0.1 recorded. */
export interface AgentRow {
  pid: number;
  cwd: string;
  kind: string;
  startedAt: number;
  sessionId: string;
  name: string;
  status: string;
}

/** Live sessions from `<configDir>/sessions/*.json` whose pid is still running (optionally one cwd). */
export async function listAgents(configDir: string | null, cwd: string | null): Promise<AgentRow[]> {
  if (configDir === null) return [];
  const dir = path.join(configDir, 'sessions');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const rows: AgentRow[] = [];
  for (const file of files) {
    let info: JsonObject;
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
      if (!isObject(parsed)) continue;
      info = parsed;
    } catch {
      continue;
    }
    const pid = info['pid'];
    if (typeof pid !== 'number' || !isAlive(pid)) continue;
    const row: AgentRow = {
      pid,
      cwd: String(info['cwd'] ?? ''),
      kind: String(info['kind'] ?? 'interactive'),
      startedAt: Number(info['startedAt'] ?? 0),
      sessionId: String(info['sessionId'] ?? ''),
      name: String(info['name'] ?? ''),
      status: String(info['status'] ?? 'idle'),
    };
    if (cwd !== null && path.resolve(cwd) !== row.cwd) continue;
    rows.push(row);
  }
  return rows;
}
