/**
 * D51: the Workflow runs of sessions and their agents (`docs/derivations.md` →
 * *Workflow agents*). Kept in memory, never stored: the CLI's own files are the
 * record (they survive a Switchboard restart, and they are there for History and
 * terminal sessions too), and this process's stream adds what is live
 * (`WorkflowSignal`s from the recorder).
 *
 * Files read (only ever read), all under `<configDir>/projects/<folder>/<claudeSessionId>/`
 * of the session's own CLI session id, every name checked before it becomes a path
 * part (run ids `wf_…`, agent ids), symlinks never followed, and no path taken from
 * a file's contents:
 * - `subagents/workflows/<runId>/journal.jsonl`, `agent-<id>.meta.json`, `agent-<id>.jsonl`
 *   (written while the run runs; transcripts are read as they grow: their head once,
 *   then what was appended, at most {@link TAIL_BYTES} of an unread middle);
 * - `workflows/<runId>.json` (the run file, written once when the run ends);
 * - `workflows/scripts/<name>-<runId>.js` (its `meta`: name, description, phases),
 *   which the CLI may write under the project folder of another cwd the session
 *   moved to, so every project folder holding the session id is searched.
 *
 * Runs that may still run are re-read every {@link WorkflowServiceOptions.pollMs}
 * (only files that grew); nothing is polled once no run runs.
 */
import { type Dirent, constants } from 'node:fs';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Agent, WorkflowAgentChat, WorkflowRun } from '../../core/api.ts';
import { type SessionPlace, sessionSolutionFolder } from '../../core/derive/artifacts.ts';
import {
  AGENT_FILE,
  type AgentMeta,
  type AgentTranscriptFacts,
  type JournalEntry,
  NO_TRANSCRIPT,
  NO_WRITES,
  type WriteScan,
  type RunFileFacts,
  type ScriptMeta,
  WORKFLOW_RUN_ID,
  type WorkflowAgentView,
  type WorkflowLaunch,
  type WorkflowProgress,
  deriveWorkflowRun,
  parseAgentMeta,
  parseJournal,
  parseRunFile,
  parseScriptMeta,
  parseWorkflowProgress,
  scanAgentEntries,
  scanWrites,
  scriptFileName,
  workflowAgentEvents,
  workflowAgents,
} from '../../core/derive/workflows.ts';
import { parseTranscript } from '../../core/transcript-sync.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { WorkflowSignal } from '../supervisor/recorder.ts';

/** How much of a transcript's head is read once (its `cwd`, its first time). */
export const HEAD_BYTES = 16 * 1024;
/** How much of a transcript is read at most at a time (the rest of an unread middle is skipped). */
export const TAIL_BYTES = 64 * 1024;
/** The largest transcript an agent's chat reads (its end, when longer). */
export const CHAT_MAX_BYTES = 32 * 1024 * 1024;
/** Runs files changed within this long may still run (a terminal's run, or one whose process Switchboard did not see). */
export const RECENT_MS = 2 * 60_000;
/** The default poll interval while a run runs. */
export const POLL_MS = 1_500;
/** D51-solution: how much of a transcript one load scans for its first write, and at most in all (then it gives up). */
export const WRITE_SCAN_CHUNK = 4 * 1024 * 1024;
export const WRITE_SCAN_MAX = 32 * 1024 * 1024;
/** How long the project folders' index and a session's run list are reused before they are listed again. */
export const LIST_TTL_MS = 10_000;

/** Options of {@link WorkflowService}. */
export interface WorkflowServiceOptions {
  /** `$CLAUDE_CONFIG_DIR` or `~/.claude` (read per call: tests change it). */
  readonly configDir: () => string;
  /** A session's run list or an agent changed: publish `sessionUpdated` (and the activity). */
  readonly onChange: (sessionId: string) => void;
  readonly pollMs?: number;
  readonly recentMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/** What a session's workflows are, as `toSession` needs them. */
export interface SessionWorkflows {
  readonly runs: readonly WorkflowRun[];
  readonly agents: readonly Agent[];
}

/** What `toSession` reads (`registerWorkflowSource` in `sessions/wire.ts`). */
export interface WorkflowSource {
  forSession(record: SessionRecord): Promise<SessionWorkflows>;
}

interface TranscriptState {
  facts: AgentTranscriptFacts;
  /** Bytes consumed (complete lines). */
  offset: number;
  /** D51-solution: the scan for its first write, from the start, in order. */
  writes: WriteScan;
  writeOffset: number;
  /** The scan found a write or gave up ({@link WRITE_SCAN_MAX}). */
  writesDone: boolean;
}

interface RunState {
  readonly runId: string;
  /** The session folder (`<projects>/<folder>/<claudeSessionId>`) whose `subagents/workflows/<runId>` holds its agents; `null` before it appeared. */
  dir: string | null;
  launch: WorkflowLaunch | null;
  launchedAt: string | null;
  /** This session's live process launched it or reported its progress, and has not ended. */
  live: boolean;
  /** The process that ran it ended (a pause, a stop, an exit): it runs no more, however fresh its files are. */
  stopped: boolean;
  /** The task's final status on stdout. */
  ended: string | null;
  progress: WorkflowProgress | null;
  runFile: RunFileFacts | null;
  journalBytes: number;
  journal: JournalEntry[];
  readonly metas: Map<string, AgentMeta>;
  readonly transcripts: Map<string, TranscriptState>;
  script: ScriptMeta | null;
  /** D51-resume: its script file as found by listing (a path Switchboard built), `null` before. */
  scriptFile: string | null;
  /** Newest mtime seen in its files (epoch ms). */
  touchedAt: number;
  /** The run file was read and every transcript once after it: nothing changes any more. */
  settled: boolean;
}

interface SessionState {
  readonly sessionId: string;
  claudeSessionId: string;
  place: SessionPlace | null;
  name: string;
  readonly runs: Map<string, RunState>;
  /** Task id → run id (from launches and run files). */
  readonly tasks: Map<string, string>;
  /** `task_progress` snapshots of task ids no launch named yet. */
  readonly early: Map<string, WorkflowProgress>;
  listedAt: number;
  /** Loads run one after the other (file offsets move with each). */
  chain: Promise<void>;
  /** A first load finished. */
  loaded: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  views: { runs: WorkflowRun[]; agents: Agent[]; byAgent: Map<string, { run: RunState; view: WorkflowAgentView }> };
  key: string;
}

function placeOf(record: SessionRecord): SessionPlace | null {
  return record.cwd ? { root: record.root ?? record.cwd, kind: record.rootKind ?? 'workspace', cwd: record.cwd } : null;
}

/** Reads `[start, end)` of a file as UTF-8 (`''` when empty or unreadable). */
async function readRange(file: string, start: number, end: number): Promise<string> {
  if (end <= start) return '';
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, end - start, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** A regular file's size and mtime (not following a symlink); `null` when it is missing or not a file. */
async function fileInfo(file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await lstat(file);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

async function list(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The complete lines of `text` and how many bytes they are (a cut last line waits for the next read). */
function completeText(text: string): { whole: string; consumed: number } {
  const end = text.lastIndexOf('\n');
  if (end < 0) return { whole: '', consumed: 0 };
  const whole = text.slice(0, end + 1);
  return { whole, consumed: Buffer.byteLength(whole, 'utf8') };
}

/** The JSON objects of the complete lines in `text`, and their bytes. */
function completeLines(text: string): { entries: Record<string, unknown>[]; consumed: number } {
  const { whole, consumed } = completeText(text);
  return { entries: parseTranscript(whole) as Record<string, unknown>[], consumed };
}

/**
 * The Workflow runs of every session Switchboard shows, from the CLI's files and
 * the live stream (module comment). One per supervisor.
 */
export class WorkflowService implements WorkflowSource {
  readonly #options: WorkflowServiceOptions;
  readonly #pollMs: number;
  readonly #recentMs: number;
  readonly #now: () => number;
  readonly #sessions = new Map<string, SessionState>();
  /** CLI session id → the session folders holding it (every project folder's), listed at most every {@link LIST_TTL_MS}. */
  #index: { at: number; dirs: Map<string, string[]>; pending: Promise<Map<string, string[]>> | null } = { at: 0, dirs: new Map(), pending: null };
  #closed = false;

  constructor(options: WorkflowServiceOptions) {
    this.#options = options;
    this.#pollMs = options.pollMs ?? POLL_MS;
    this.#recentMs = options.recentMs ?? RECENT_MS;
    this.#now = options.now ?? Date.now;
  }

  /** The session's runs and their agents (loaded from its files on first use; re-listed at most every {@link LIST_TTL_MS}). */
  async forSession(record: SessionRecord): Promise<SessionWorkflows> {
    const state = this.#state(record);
    if (!state.loaded || this.#now() - state.listedAt > LIST_TTL_MS) await this.#serial(state, false);
    return { runs: state.views.runs, agents: state.views.agents };
  }

  /**
   * D51: a stream signal of the session's live process (`RecorderOptions.onWorkflow`):
   * a launch registers its run (live); a progress snapshot is the run's newest agent
   * list; a task's end ends its run. The run's files are read at once.
   */
  signal(record: SessionRecord, signal: WorkflowSignal): void {
    const state = this.#state(record);
    if (signal.kind === 'launched') {
      const run = this.#run(state, signal.launch.runId);
      run.launch = signal.launch;
      run.launchedAt ??= new Date(this.#now()).toISOString();
      run.live = true;
      run.stopped = false;
      run.ended = null;
      if (signal.launch.taskId) {
        state.tasks.set(signal.launch.taskId, run.runId);
        const early = state.early.get(signal.launch.taskId);
        if (early) {
          run.progress = early;
          state.early.delete(signal.launch.taskId);
        }
      }
      // A new run folder: list the session's folders again.
      state.listedAt = 0;
      this.#index.at = 0;
    } else if (signal.kind === 'progress') {
      const progress = parseWorkflowProgress(signal.progress);
      const runId = state.tasks.get(signal.taskId);
      const run = runId ? state.runs.get(runId) : undefined;
      if (!run) {
        state.early.set(signal.taskId, progress);
        return;
      }
      run.progress = progress;
      run.live = true;
      run.stopped = false;
    } else {
      const runId = state.tasks.get(signal.taskId);
      const run = runId ? state.runs.get(runId) : undefined;
      if (!run) return;
      run.ended = signal.status;
      run.live = false;
    }
    this.#kick(state);
  }

  /** D51: the session's process ended: its runs ended with it (their files say how far they got). */
  processEnded(sessionId: string): void {
    const state = this.#sessions.get(sessionId);
    if (!state) return;
    for (const run of state.runs.values()) {
      if (run.live) run.stopped = true;
      run.live = false;
    }
    state.early.clear();
    this.#kick(state);
  }

  /** D51: the run of a workflow task (`BackgroundTask.workflow`), when known. */
  taskRun(sessionId: string, taskId: string): WorkflowRun | null {
    const state = this.#sessions.get(sessionId);
    const runId = state?.tasks.get(taskId);
    return (runId && state?.views.runs.find((run) => run.runId === runId)) || null;
  }

  /**
   * D51: a workflow agent's conversation (`GET /api/sessions/{id}/workflow-agents/{agentId}/chat`),
   * read from its transcript; `null` when the session has no such agent (or it has
   * no transcript yet: queued).
   */
  async chat(record: SessionRecord, agentKey: string): Promise<WorkflowAgentChat | null> {
    await this.forSession(record);
    const state = this.#sessions.get(record.id);
    const hit = state?.views.byAgent.get(agentKey);
    const agentId = hit?.view.workflow.agentId ?? null;
    if (!state || !hit || !hit.run.dir || agentId === null) return null;
    const file = path.join(hit.run.dir, 'subagents', 'workflows', hit.run.runId, `agent-${agentId}.jsonl`);
    const info = await fileInfo(file);
    if (!info) return { events: [], result: hit.view.result, version: hit.view.workflow.version };
    const start = Math.max(0, info.size - CHAT_MAX_BYTES);
    const text = await readRange(file, start, info.size);
    const entries = parseTranscript(start > 0 ? text.slice(text.indexOf('\n') + 1) : text) as Record<string, unknown>[];
    return { events: workflowAgentEvents(entries, record.id, agentKey), result: hit.view.result, version: info.size };
  }

  /** Stops every poll. */
  close(): void {
    this.#closed = true;
    for (const state of this.#sessions.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  #state(record: SessionRecord): SessionState {
    let state = this.#sessions.get(record.id);
    if (!state) {
      state = {
        sessionId: record.id,
        claudeSessionId: record.claudeSessionId,
        place: placeOf(record),
        name: record.name,
        runs: new Map(),
        tasks: new Map(),
        early: new Map(),
        listedAt: 0,
        chain: Promise.resolve(),
        loaded: false,
        timer: null,
        views: { runs: [], agents: [], byAgent: new Map() },
        key: '',
      };
      this.#sessions.set(record.id, state);
    } else {
      if (state.claudeSessionId !== record.claudeSessionId) {
        // A new CLI session id (a teleport's local copy): its folders are elsewhere.
        state.claudeSessionId = record.claudeSessionId;
        state.listedAt = 0;
      }
      state.place = placeOf(record);
      state.name = record.name;
    }
    return state;
  }

  #run(state: SessionState, runId: string): RunState {
    let run = state.runs.get(runId);
    if (!run) {
      run = {
        runId,
        dir: null,
        launch: null,
        launchedAt: null,
        live: false,
        stopped: false,
        ended: null,
        progress: null,
        runFile: null,
        journalBytes: 0,
        journal: [],
        metas: new Map(),
        transcripts: new Map(),
        script: null,
        scriptFile: null,
        touchedAt: 0,
        settled: false,
      };
      state.runs.set(runId, run);
    }
    return run;
  }

  /** Re-reads the session's files soon (a signal came): at most one refresh at a time. */
  #kick(state: SessionState): void {
    if (this.#closed) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.#serial(state, true);
    }, 0);
  }

  /** Runs a load after the ones before it (errors are reported, never thrown). */
  #serial(state: SessionState, notify: boolean): Promise<void> {
    state.chain = state.chain.then(() => this.#load(state, notify)).catch((error: unknown) => this.#options.onError?.(error));
    return state.chain;
  }

  /** Lists the session's runs (when due), reads what changed, derives, publishes a change, and polls on while a run runs. */
  async #load(state: SessionState, notify: boolean): Promise<void> {
    // A run known from the stream whose folder was not there yet (the CLI creates it just after the launch): list again soon, not after the TTL.
    const missing = [...state.runs.values()].some((run) => run.dir === null && run.live && run.ended === null);
    const due = missing ? this.#pollMs : LIST_TTL_MS;
    if (missing && this.#now() - this.#index.at > this.#pollMs) this.#index.at = 0;
    if (this.#now() - state.listedAt > due || state.listedAt === 0) await this.#listRuns(state);
    for (const run of state.runs.values()) await this.#readRun(state, run);
    const changed = await this.#derive(state);
    state.loaded = true;
    // A load a reader asked for returns its result to that reader; the others are news.
    if (changed && notify) this.#options.onChange(state.sessionId);
    this.#schedule(state);
  }

  #schedule(state: SessionState): void {
    if (this.#closed || state.timer) return;
    if (!state.views.runs.some((run) => run.status === 'run')) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.#serial(state, true);
    }, this.#pollMs);
    state.timer.unref?.();
  }

  /** Every project folder's folders named like a CLI session id (one listing per project folder, reused for {@link LIST_TTL_MS}). */
  async #sessionDirs(claudeSessionId: string): Promise<string[]> {
    if (this.#now() - this.#index.at > LIST_TTL_MS) {
      this.#index.pending ??= (async () => {
        const projects = path.join(this.#options.configDir(), 'projects');
        const dirs = new Map<string, string[]>();
        for (const folder of await list(projects)) {
          if (!folder.isDirectory()) continue;
          for (const entry of await list(path.join(projects, folder.name))) {
            if (!entry.isDirectory()) continue;
            const found = dirs.get(entry.name);
            const dir = path.join(projects, folder.name, entry.name);
            if (found) found.push(dir);
            else dirs.set(entry.name, [dir]);
          }
        }
        return dirs;
      })();
      const pending = this.#index.pending;
      try {
        this.#index = { at: this.#now(), dirs: await pending, pending: null };
      } finally {
        if (this.#index.pending === pending) this.#index.pending = null;
      }
    }
    return this.#index.dirs.get(claudeSessionId) ?? [];
  }

  /** Finds the session's runs: run folders, run files and scripts in every folder holding its CLI session id. */
  async #listRuns(state: SessionState): Promise<void> {
    state.listedAt = this.#now();
    for (const dir of await this.#sessionDirs(state.claudeSessionId)) {
      for (const entry of await list(path.join(dir, 'subagents', 'workflows'))) {
        if (entry.isDirectory() && WORKFLOW_RUN_ID.test(entry.name)) this.#run(state, entry.name).dir ??= dir;
      }
      for (const entry of await list(path.join(dir, 'workflows'))) {
        const id = entry.isFile() && entry.name.endsWith('.json') ? entry.name.slice(0, -'.json'.length) : null;
        if (id !== null && WORKFLOW_RUN_ID.test(id)) {
          const run = this.#run(state, id);
          run.dir ??= dir;
        }
      }
    }
    // Scripts: the file (D51-resume) of every run, and its meta for runs whose name is not known otherwise.
    for (const run of state.runs.values()) {
      if (run.scriptFile !== null) continue;
      for (const dir of this.#index.dirs.get(state.claudeSessionId) ?? []) {
        const scripts = path.join(dir, 'workflows', 'scripts');
        const hit = (await list(scripts)).find((entry) => entry.isFile() && scriptFileName(entry.name, run.runId) !== null);
        if (!hit) continue;
        const file = path.join(scripts, hit.name);
        run.scriptFile = file;
        if (run.script === null && run.runFile === null) {
          const info = await fileInfo(file);
          const meta = info && info.size <= 1024 * 1024 ? parseScriptMeta(await readFile(file, 'utf8').catch(() => '')) : null;
          run.script = { name: meta?.name ?? scriptFileName(hit.name, run.runId), summary: meta?.summary ?? null, phases: meta?.phases ?? [] };
        }
        break;
      }
    }
  }

  /** Reads what changed in one run's files. */
  async #readRun(state: SessionState, run: RunState): Promise<void> {
    if (run.settled || run.dir === null) return;
    const dir = run.dir;
    if (run.runFile === null) {
      const file = path.join(dir, 'workflows', `${run.runId}.json`);
      const info = await fileInfo(file);
      if (info) {
        try {
          run.runFile = parseRunFile(JSON.parse(await readFile(file, 'utf8')));
          run.touchedAt = Math.max(run.touchedAt, info.mtimeMs);
          if (run.runFile?.taskId) state.tasks.set(run.runFile.taskId, run.runId);
        } catch {
          run.runFile = null; // being written: next time
        }
      }
    }
    const folder = path.join(dir, 'subagents', 'workflows', run.runId);
    const journal = path.join(folder, 'journal.jsonl');
    const journalInfo = await fileInfo(journal);
    if (journalInfo && journalInfo.size > run.journalBytes) {
      const { whole, consumed } = completeText(await readRange(journal, run.journalBytes, journalInfo.size));
      run.journalBytes += consumed;
      run.journal.push(...parseJournal(whole));
      run.touchedAt = Math.max(run.touchedAt, journalInfo.mtimeMs);
    }
    for (const entry of await list(folder)) {
      const match = entry.isFile() ? AGENT_FILE.exec(entry.name) : null;
      const agentId = match?.[1];
      if (!match || agentId === undefined) continue;
      const file = path.join(folder, entry.name);
      if (match[2] === 'meta.json') {
        if (run.metas.has(agentId)) continue;
        try {
          const meta = parseAgentMeta(JSON.parse(await readFile(file, 'utf8')));
          if (meta) run.metas.set(agentId, meta);
        } catch {
          // Being written: next time.
        }
        continue;
      }
      await this.#readTranscript(run, agentId, file);
    }
    // Settled: final, every transcript read, every write scan over.
    if (run.runFile !== null && [...run.transcripts.values()].every((t) => t.writesDone || t.writeOffset >= t.facts.bytes)) run.settled = true;
  }

  /** An agent's transcript: its head once, then what was appended (at most {@link TAIL_BYTES} of it). */
  async #readTranscript(run: RunState, agentId: string, file: string): Promise<void> {
    const info = await fileInfo(file);
    if (!info) return;
    let state = run.transcripts.get(agentId);
    if (state && info.size <= state.offset && (state.writesDone || info.size <= state.writeOffset)) return;
    run.touchedAt = Math.max(run.touchedAt, info.mtimeMs);
    if (!state) {
      const head = completeLines(await readRange(file, 0, Math.min(info.size, HEAD_BYTES)));
      state = { facts: scanAgentEntries(NO_TRANSCRIPT, head.entries, head.consumed), offset: head.consumed, writes: NO_WRITES, writeOffset: 0, writesDone: false };
      run.transcripts.set(agentId, state);
    }
    await this.#scanWrites(state, file, info.size);
    if (info.size <= state.offset) {
      state.facts = { ...state.facts, bytes: info.size };
      return;
    }
    let start = state.offset;
    let skip = false;
    if (info.size - start > TAIL_BYTES) {
      // Skip an unread middle: only its end says what the agent does now.
      start = info.size - TAIL_BYTES;
      skip = true;
    }
    let text = await readRange(file, start, info.size);
    let lead = 0;
    if (skip) {
      const cut = text.indexOf('\n');
      lead = cut < 0 ? Buffer.byteLength(text, 'utf8') : Buffer.byteLength(text.slice(0, cut + 1), 'utf8');
      text = cut < 0 ? '' : text.slice(cut + 1);
    }
    const { entries, consumed } = completeLines(text);
    state.offset = start + lead + consumed;
    state.facts = scanAgentEntries(state.facts, entries, info.size);
  }

  /**
   * D51-solution: scans a transcript from where it stopped for the agent's first
   * successful write, at most {@link WRITE_SCAN_CHUNK} per load and
   * {@link WRITE_SCAN_MAX} in all; once found (or given up) never again.
   */
  async #scanWrites(state: TranscriptState, file: string, size: number): Promise<void> {
    if (state.writesDone || size <= state.writeOffset) return;
    const end = Math.min(size, state.writeOffset + WRITE_SCAN_CHUNK);
    const { entries, consumed } = completeLines(await readRange(file, state.writeOffset, end));
    // A single line longer than the chunk: skip past it.
    state.writeOffset += consumed > 0 ? consumed : end - state.writeOffset;
    state.writes = scanWrites(state.writes, entries);
    if (state.writes.first !== null || state.writeOffset >= WRITE_SCAN_MAX) state.writesDone = true;
  }

  /** D51-resume: the run's script, as found by listing, else the path its run file or launch names when that is a script file of this run under the projects folder. */
  async #scriptPath(run: RunState): Promise<string | null> {
    if (run.scriptFile !== null) return run.scriptFile;
    const projects = path.join(this.#options.configDir(), 'projects');
    for (const candidate of [run.runFile?.scriptPath ?? null, run.launch?.scriptPath ?? null]) {
      if (candidate === null) continue;
      const resolved = path.resolve(candidate);
      if (!resolved.startsWith(projects + path.sep) || scriptFileName(path.basename(resolved), run.runId) === null) continue;
      if (await fileInfo(resolved)) return (run.scriptFile = resolved);
    }
    return null;
  }

  /** Derives the session's runs and agents; `true` when they changed. */
  async #derive(state: SessionState): Promise<boolean> {
    const now = this.#now();
    const runs: WorkflowRun[] = [];
    const agents: Agent[] = [];
    const byAgent = new Map<string, { run: RunState; view: WorkflowAgentView }>();
    const place = state.place;
    const solutionOf = (file: string): string | null => (place ? sessionSolutionFolder(place, file, state.name) : null);
    const ordered = [...state.runs.values()].filter((run) => run.dir !== null || run.launch !== null);
    const scripts = new Map<RunState, string | null>();
    for (const run of ordered) scripts.set(run, await this.#scriptPath(run));
    const derived = ordered.map((run) => {
      const transcripts = new Map<string, AgentTranscriptFacts>();
      const writes = new Map<string, string>();
      for (const [agentId, transcript] of run.transcripts) {
        transcripts.set(agentId, transcript.facts);
        if (transcript.writes.first !== null) writes.set(agentId, transcript.writes.first);
      }
      const recent = run.touchedAt > 0 && now - run.touchedAt < this.#recentMs;
      return {
        run,
        result: deriveWorkflowRun({
          runId: run.runId,
          launch: run.launch,
          launchedAt: run.launchedAt,
          runFile: run.runFile,
          progress: run.progress,
          journal: run.journal,
          metas: run.metas,
          transcripts,
          writes,
          scriptPath: scripts.get(run) ?? null,
          script: run.script,
          ended: run.ended,
          running: !run.stopped && run.ended === null && (run.live || recent),
        }),
      };
    });
    derived.sort((a, b) => (a.result.run.startedAt ?? '9').localeCompare(b.result.run.startedAt ?? '9') || a.run.runId.localeCompare(b.run.runId));
    for (const { run, result } of derived) {
      runs.push(result.run);
      agents.push(...workflowAgents(result.agents, solutionOf));
      for (const view of result.agents) byAgent.set(view.id, { run, view });
      if (result.run.taskId) state.tasks.set(result.run.taskId, run.runId);
    }
    const key = JSON.stringify([runs, agents]);
    state.views = { runs, agents, byAgent };
    if (key === state.key) return false;
    state.key = key;
    return true;
  }
}
