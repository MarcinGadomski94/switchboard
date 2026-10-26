import { stat } from 'node:fs/promises';
import { CLI_LABELS, type CliProviderId } from '../../core/cli-providers.ts';
import {
  MEMORY_CHECK_DEFAULT_SETTINGS,
  MEMORY_CHECK_MAX_NOTES,
  MEMORY_REMOVED_KEEP_DAYS,
  type MemoryCheckResult,
  type MemoryCheckSettings,
  type MemoryCheckStatus,
  memoryCheckActive,
  memoryCheckDueAt,
  memoryCheckPrompt,
  memoryConflictPrompt,
  memoryRemovalCap,
  readCheckAnswer,
  readCheckFrequency,
  readConflictAnswer,
} from '../../core/memory-check.ts';
import type { MemoryEntry } from '../../core/memory.ts';
import { parseStreamLine } from '../../core/stream-json.ts';
import { userMessageLine } from '../../core/stdin.ts';
import { resultModelTotals } from '../../core/usage-breakdown.ts';
import { ClaudeProcess } from '../supervisor/process.ts';
import type { MemoryDb } from './db.ts';

/**
 * D136 · Project memory checks (`docs/memory.md` → *Checking notes (D136)*).
 *
 * - **(A) the proposal check:** when an agent proposes a new note, a short model call compares it
 *   with the approved notes the proposing session sees (`memory_list`'s reach) and keeps a finding
 *   when it duplicates or contradicts one (the review card shows it; "Approve and remove the old
 *   note" applies it).
 * - **(B) the periodic check:** weekly (by default) per folder with approved notes, when an agent
 *   worked there since the last run and the account it would use is below the usage warning level:
 *   a fresh, short-lived, read-only headless run of the folder's CLI verifies each note against the
 *   code and recent git history and answers keep / edit / remove per note. Removals are applied
 *   (recoverable, capped per run); edits and removals over the cap become normal D135 proposals.
 *
 * Neither is a session: no `sessions` row, no events, nothing in Agents / sidebar / Home, nothing
 * to interact with; the run is `claude -p` with stream-json, `--permission-mode dontAsk`, only
 * reading tools allowed, no MCP servers and no transcript (`--no-session-persistence`). Their
 * tokens go to Insights → Usage as "Memory check". Demo mode never runs them.
 */

/** One headless run of a check. */
export interface MemoryCheckRun {
  /** `proposal` (A) or `periodic` (B). */
  readonly purpose: 'proposal' | 'periodic';
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompt: string;
  /** `--model`, `null` = the CLI's default. */
  readonly model: string | null;
  readonly timeoutMs: number;
}

/** One model's tokens of a run. */
export interface MemoryCheckTokens {
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

/** What a run answered (its final text) and used, or why it failed (with what it used anyway). */
export type MemoryCheckOutput =
  | { readonly ok: true; readonly text: string; readonly tokens: readonly MemoryCheckTokens[]; readonly durationMs: number }
  | { readonly ok: false; readonly error: string; readonly tokens: readonly MemoryCheckTokens[]; readonly durationMs: number };

/** Runs one check (the real one spawns the CLI; tests pass a fake). */
export type MemoryCheckRunner = (run: MemoryCheckRun) => Promise<MemoryCheckOutput>;

/** The tools check (B) may use without asking (`--allowedTools`): reading, searching and read-only git. */
export const MEMORY_CHECK_ALLOWED_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'LS', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git ls-files:*)', 'Bash(git branch:*)', 'Bash(git status:*)', 'Bash(git diff:*)'];

/** The tools no check may use (`--disallowedTools`; `dontAsk` refuses anything not allowed anyway). */
export const MEMORY_CHECK_DISALLOWED_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'ExitPlanMode', 'KillShell', 'Workflow'];

/** The model of the proposal check (a short comparison) and of the periodic check. */
export const MEMORY_CHECK_MODELS: Readonly<Record<MemoryCheckRun['purpose'], string>> = { proposal: 'haiku', periodic: 'sonnet' };

/** Time limits of a run (spawn to exit). */
export const MEMORY_CHECK_TIMEOUT_MS: Readonly<Record<MemoryCheckRun['purpose'], number>> = { proposal: 120_000, periodic: 10 * 60_000 };

/** How often the scheduler looks for due folders. */
export const MEMORY_CHECK_TICK_MS = 10 * 60_000;

/**
 * The argv of a check run (without the CLI command): print mode with stream-json in and out (the
 * prompt goes over stdin, as every Switchboard spawn), `dontAsk` (anything not allowed is refused,
 * never asked), the read-only tools (none for the proposal check), no MCP servers, no transcript.
 */
export function memoryCheckArgs(purpose: MemoryCheckRun['purpose'], model: string | null, extraArgs: readonly string[] = []): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    ...(purpose === 'periodic' ? ['--allowedTools', MEMORY_CHECK_ALLOWED_TOOLS.join(',')] : []),
    '--disallowedTools',
    [...MEMORY_CHECK_DISALLOWED_TOOLS, ...(purpose === 'proposal' ? ['Bash', 'Read', 'Grep', 'Glob', 'LS'] : [])].join(','),
    '--strict-mcp-config',
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
    ...extraArgs,
  ];
}

/** The tokens of a raw `result` line: per model from its `modelUsage` (subagents included), else its `usage` under its model. */
export function resultTokens(raw: unknown, fallbackModel: string): MemoryCheckTokens[] {
  const totals = resultModelTotals(raw);
  if (totals) return Object.entries(totals).map(([model, split]) => ({ model, input: split.input, output: split.output, cacheWrite: split.cacheWrite, cacheRead: split.cacheRead }));
  const usage = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)['usage'] : null;
  if (usage === null || typeof usage !== 'object') return [];
  const u = usage as Record<string, unknown>;
  const n = (key: string): number => (typeof u[key] === 'number' && Number.isFinite(u[key]) ? (u[key] as number) : 0);
  return [{ model: fallbackModel, input: n('input_tokens'), output: n('output_tokens'), cacheWrite: n('cache_creation_input_tokens'), cacheRead: n('cache_read_input_tokens') }];
}

const KILL_GRACE_MS = 2_000;

/**
 * The real runner: spawns the CLI (argv array, `shell: false`, `ClaudeProcess`) with
 * {@link memoryCheckArgs}, writes the prompt as one stream-json user message, waits for the turn's
 * `result`, closes stdin and waits for the exit (killing it past the time limit).
 */
export function claudeCheckRunner(options: { readonly extraArgs?: readonly string[] } = {}): MemoryCheckRunner {
  return async (run) => {
    const started = Date.now();
    const holder: { proc?: ClaudeProcess; result?: { text: string | null; isError: boolean; errors: readonly string[]; raw: unknown }; model?: string } = {};
    let proc: ClaudeProcess;
    try {
      proc = new ClaudeProcess({
        command: run.command,
        args: memoryCheckArgs(run.purpose, run.model, options.extraArgs),
        cwd: run.cwd,
        env: run.env,
        onLine: (line) => {
          const message = parseStreamLine(line);
          if (message.kind === 'init' && message.model !== null) holder.model = message.model;
          if (message.kind !== 'result' || message.taskNotification || holder.result) return;
          holder.result = { text: message.text, isError: message.isError, errors: message.errors, raw: message.raw };
          holder.proc?.endInput();
        },
      });
    } catch (error) {
      return { ok: false, error: `could not start the CLI: ${error instanceof Error ? error.message : String(error)}`, tokens: [], durationMs: 0 };
    }
    holder.proc = proc;
    proc.write(userMessageLine(run.prompt));
    if (!(await proc.waitForExit(run.timeoutMs))) {
      proc.endInput();
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        proc.kill(signal);
        if (await proc.waitForExit(KILL_GRACE_MS)) break;
      }
      if (!holder.result) return { ok: false, error: `the check did not finish within ${Math.round(run.timeoutMs / 1000)} s`, tokens: [], durationMs: Date.now() - started };
    }
    const exit = await proc.exited;
    const durationMs = Date.now() - started;
    const result = holder.result;
    const tokens = result ? resultTokens(result.raw, holder.model ?? run.model ?? 'default') : [];
    if (!result) {
      if (exit.spawnError) return { ok: false, error: `could not start the CLI: ${exit.spawnError.message}`, tokens, durationMs };
      const stderr = proc.stderrTail().trim().split('\n').pop() ?? '';
      return { ok: false, error: `the CLI exited (${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}) without an answer${stderr ? `: ${stderr}` : ''}`, tokens, durationMs };
    }
    if (result.isError || result.text === null) return { ok: false, error: result.errors[0] ?? 'the CLI reported an error', tokens, durationMs };
    return { ok: true, text: result.text, tokens, durationMs };
  };
}

/** What the checks need of the rest of Switchboard (the app's host is built in `install.ts`; tests pass their own). */
export interface MemoryCheckHost {
  /** The CLI command of `cli` (argv prefix). */
  command(cli: CliProviderId): Promise<readonly string[]>;
  /**
   * The account a check would run on, with its environment, or why not now: usage paused (every
   * account out of allowance, D103), or at / above the developer's usage warning level ("Warn at").
   * `manual` (Check now) skips the warning level, never the pause.
   */
  account(manual: boolean): Promise<{ readonly profileId: string; readonly env: NodeJS.ProcessEnv } | { readonly blocked: string }>;
  /** The CLI of the folder's newest session (`null`: no session there yet). */
  folderCli(folder: string): Promise<CliProviderId | null>;
  /** The newest session activity in the folder (ISO), `null` when none. */
  lastActivity(folder: string): Promise<string | null>;
  /** Records a run's tokens (Insights → Usage, kind "Memory check"). */
  recordUsage(row: { readonly ts: string; readonly provider: CliProviderId; readonly profileId: string; readonly folder: string; readonly tokens: readonly MemoryCheckTokens[]; readonly durationMs: number }): void;
  /** Where the proposal check runs (no project files needed): the app-data folder. */
  readonly workDir: string;
}

/** What the checks need of the memory service. */
export interface MemoryCheckAccess {
  db(): MemoryDb | null;
  now(): Date;
  label(folder: string): Promise<string>;
  /** Moves an approved note to the removed list (recoverable). */
  removeNote(entry: MemoryEntry, reason: string): Promise<void>;
  /** Files a D135 edit / retract proposal authored by the check; `false` when one is pending already or nothing changes. */
  fileChange(target: MemoryEntry, kind: 'edit' | 'retract', fields: { readonly title: string | null; readonly text: string | null; readonly reason: string }): Promise<boolean>;
  /** `memoryChanged` for the folder (pages reload; no Inbox item, toast or push). */
  changed(folder: string): void;
  onError(error: unknown): void;
}

/** Options of {@link MemoryChecks}. */
export interface MemoryCheckOptions {
  readonly runner: MemoryCheckRunner;
  readonly host: MemoryCheckHost;
  readonly tickMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ENABLED_KEY = 'check.enabled';
const DAYS_KEY = 'check.days';

/** D136 · the proposal check, the periodic check and their schedule (one per `MemoryService`). */
export class MemoryChecks {
  readonly #o: MemoryCheckOptions;
  readonly #a: MemoryCheckAccess;
  #timer: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  /** Runs one at a time per kind (a proposal check never waits behind a periodic run). */
  #periodicQueue: Promise<unknown> = Promise.resolve();
  #proposalQueue: Promise<unknown> = Promise.resolve();
  readonly #running = new Set<string>();
  readonly #queued = new Set<string>();
  #ticking = false;

  constructor(access: MemoryCheckAccess, options: MemoryCheckOptions) {
    this.#a = access;
    this.#o = options;
  }

  start(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setInterval(() => void this.tick().catch((error: unknown) => this.#a.onError(error)), this.#o.tickMs ?? MEMORY_CHECK_TICK_MS);
    this.#timer.unref?.();
    // A first look soon after start (purges, first sightings); runs are still gated by their due time.
    const first = setTimeout(() => void this.tick().catch((error: unknown) => this.#a.onError(error)), 30_000);
    first.unref?.();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await Promise.allSettled([this.#periodicQueue, this.#proposalQueue]);
  }

  /** Every queued run has finished (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const periodic = this.#periodicQueue;
      const proposal = this.#proposalQueue;
      await Promise.allSettled([periodic, proposal]);
      if (periodic === this.#periodicQueue && proposal === this.#proposalQueue) return;
    }
  }

  // ── settings ──────────────────────────────────────────────────────────

  settings(): MemoryCheckSettings {
    const db = this.#a.db();
    if (!db) return MEMORY_CHECK_DEFAULT_SETTINGS;
    const enabled = db.meta(ENABLED_KEY);
    const days = readCheckFrequency(Number(db.meta(DAYS_KEY)));
    return { enabled: enabled === null ? MEMORY_CHECK_DEFAULT_SETTINGS.enabled : enabled === '1', frequencyDays: days ?? MEMORY_CHECK_DEFAULT_SETTINGS.frequencyDays };
  }

  setSettings(patch: { readonly enabled: boolean | null; readonly frequencyDays: number | null }): MemoryCheckSettings {
    const db = this.#a.db();
    if (db) {
      if (patch.enabled !== null) db.setMeta(ENABLED_KEY, patch.enabled ? '1' : '0');
      if (patch.frequencyDays !== null) db.setMeta(DAYS_KEY, String(patch.frequencyDays));
    }
    return this.settings();
  }

  #folderEnabled(folder: string): boolean {
    return this.#a.db()?.checkFolder(folder)?.enabled ?? true;
  }

  /** A folder's state (`GET /api/memory/check?scope=`). */
  status(folder: string): MemoryCheckStatus {
    const db = this.#a.db();
    const settings = this.settings();
    const record = db?.checkFolder(folder) ?? null;
    const enabled = record?.enabled ?? true;
    const notes = db?.list({ scope: folder, statuses: ['approved'] }).length ?? 0;
    const due =
      settings.enabled && enabled && notes > 0
        ? new Date(
            memoryCheckDueAt({ folder, firstSeenAt: record?.firstSeenAt ?? this.#a.now().toISOString(), lastRunAt: record?.lastRunAt ?? null, lastOutcome: record?.lastResult?.outcome ?? null, frequencyDays: settings.frequencyDays }),
          ).toISOString()
        : null;
    return { folder, enabled, settings, lastRunAt: record?.lastRunAt ?? null, lastResult: record?.lastResult ?? null, nextDueAt: due, running: this.#running.has(folder) || this.#queued.has(folder), notes };
  }

  setFolderEnabled(folder: string, enabled: boolean): MemoryCheckStatus {
    this.#a.db()?.setCheckFolderEnabled(folder, enabled, this.#a.now().toISOString());
    return this.status(folder);
  }

  // ── (B) the periodic check ────────────────────────────────────────────

  /**
   * One look at every folder with approved notes: purges removed notes past their 30 days, records
   * first sightings and starts **at most one** due run (folders are spread by their jitter and the
   * tick, never all at once). A folder runs when the check is on (globally and for it), its due
   * time passed, an agent worked there since its last run, and the account is below the warning
   * level; otherwise it waits for a later tick.
   */
  async tick(): Promise<{ readonly started: string | null }> {
    if (this.#closed || this.#ticking) return { started: null };
    const db = this.#a.db();
    if (!db) return { started: null };
    this.#ticking = true;
    try {
      const now = this.#a.now();
      const purged = db.purgeRemoved(new Date(now.getTime() - MEMORY_REMOVED_KEEP_DAYS * DAY_MS).toISOString());
      for (const folder of new Set(purged)) this.#a.changed(folder);
      const settings = this.settings();
      if (!settings.enabled) return { started: null };
      const folders = db
        .counts()
        .filter((row) => row.approved > 0)
        .map((row) => row.scope);
      for (const folder of folders) {
        const record = db.ensureCheckFolder(folder, now.toISOString());
        if (!record.enabled || this.#running.has(folder) || this.#queued.has(folder)) continue;
        const due = memoryCheckDueAt({ folder, firstSeenAt: record.firstSeenAt, lastRunAt: record.lastRunAt, lastOutcome: record.lastResult?.outcome ?? null, frequencyDays: settings.frequencyDays });
        if (due > now.getTime()) continue;
        if (!memoryCheckActive(await this.#o.host.lastActivity(folder), record.lastRunAt, now.getTime(), settings.frequencyDays)) continue;
        const account = await this.#o.host.account(false);
        if ('blocked' in account) return { started: null };
        this.#enqueue(folder, 'periodic');
        return { started: folder };
      }
      return { started: null };
    } finally {
      this.#ticking = false;
    }
  }

  /** "Check now" for a folder: runs it soon, whatever its schedule or activity (usage paused still refuses it). */
  checkNow(folder: string): MemoryCheckStatus {
    if (!this.#running.has(folder) && !this.#queued.has(folder)) this.#enqueue(folder, 'manual');
    return this.status(folder);
  }

  #enqueue(folder: string, trigger: 'periodic' | 'manual'): void {
    this.#queued.add(folder);
    this.#periodicQueue = this.#periodicQueue
      .then(async () => {
        this.#queued.delete(folder);
        this.#running.add(folder);
        this.#a.changed(folder);
        try {
          await this.#runFolder(folder, trigger);
        } finally {
          this.#running.delete(folder);
          this.#a.changed(folder);
        }
      })
      .catch((error: unknown) => this.#a.onError(error));
  }

  #save(folder: string, at: string, result: Omit<MemoryCheckResult, 'at'>): MemoryCheckResult {
    const full: MemoryCheckResult = { at, ...result };
    this.#a.db()?.setCheckRun(folder, at, full);
    return full;
  }

  /** One periodic (or manual) run of a folder; the result is kept as the folder's last run. */
  async #runFolder(folder: string, trigger: 'periodic' | 'manual'): Promise<MemoryCheckResult | null> {
    const db = this.#a.db();
    if (!db || this.#closed) return null;
    const at = this.#a.now().toISOString();
    const empty = { trigger, checked: 0, removed: 0, edits: 0, retracts: 0 } as const;
    const approved = db.list({ scope: folder, statuses: ['approved'] });
    if (approved.length === 0) return this.#save(folder, at, { ...empty, outcome: 'skipped', reason: 'the folder has no approved notes' });
    const cli = (await this.#o.host.folderCli(folder)) ?? 'claude';
    if (cli !== 'claude') return this.#save(folder, at, { ...empty, outcome: 'skipped', reason: `the folder's agents use ${CLI_LABELS[cli]}, which has no headless check mode in Switchboard yet` });
    const exists = await stat(folder).then(
      (info) => info.isDirectory(),
      () => false,
    );
    if (!exists) return this.#save(folder, at, { ...empty, outcome: 'skipped', reason: 'the folder no longer exists on this computer' });
    const account = await this.#o.host.account(trigger === 'manual');
    if ('blocked' in account) return this.#save(folder, at, { ...empty, outcome: 'skipped', reason: account.blocked });
    // Persisted at the start: a restart in the middle of a run does not run it again.
    db.setCheckRun(folder, at, null);
    const notes = [...approved].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0)).slice(0, MEMORY_CHECK_MAX_NOTES);
    const sent = new Map(notes.map((note) => [note.id, note]));
    const output = await this.#o.runner({
      purpose: 'periodic',
      command: await this.#o.host.command('claude'),
      cwd: folder,
      env: account.env,
      prompt: memoryCheckPrompt(folder, await this.#a.label(folder), notes, at.slice(0, 10)),
      model: MEMORY_CHECK_MODELS.periodic,
      timeoutMs: MEMORY_CHECK_TIMEOUT_MS.periodic,
    });
    this.#record(folder, account.profileId, output);
    if (!output.ok) return this.#save(folder, at, { ...empty, checked: notes.length, outcome: 'failed', reason: output.error });
    const answer = readCheckAnswer(output.text, new Set(sent.keys()));
    if (!answer.ok) return this.#save(folder, at, { ...empty, checked: notes.length, outcome: 'failed', reason: answer.problems[0] ?? 'the answer could not be read' });
    for (const problem of answer.problems) this.#a.onError(new Error(`memory check of ${folder}: dropped: ${problem}`));
    let cap = memoryRemovalCap(approved.length);
    let removed = 0;
    let edits = 0;
    let retracts = 0;
    for (const decision of answer.decisions) {
      if (decision.action === 'keep') continue;
      const before = sent.get(decision.id) as MemoryEntry;
      const now = this.#a.db()?.get(decision.id) ?? null;
      // Changed or gone while the check ran: the developer's change wins.
      if (!now || now.status !== 'approved' || now.updatedAt !== before.updatedAt) continue;
      if (decision.action === 'remove') {
        if (cap > 0) {
          await this.#a.removeNote(now, decision.reason);
          cap -= 1;
          removed += 1;
        } else if (await this.#a.fileChange(now, 'retract', { title: null, text: null, reason: decision.reason })) retracts += 1;
        continue;
      }
      if (await this.#a.fileChange(now, 'edit', { title: decision.title, text: decision.text, reason: decision.reason })) edits += 1;
    }
    return this.#save(folder, at, { trigger, checked: notes.length, removed, edits, retracts, outcome: 'done', reason: null });
  }

  #record(folder: string, profileId: string, output: MemoryCheckOutput): void {
    if (output.tokens.length === 0) return;
    try {
      this.#o.host.recordUsage({ ts: this.#a.now().toISOString(), provider: 'claude', profileId, folder, tokens: output.tokens, durationMs: output.durationMs });
    } catch (error) {
      this.#a.onError(error);
    }
  }

  // ── (A) the proposal check ────────────────────────────────────────────

  /**
   * An agent proposed `proposal` (a new note); `approved` are the notes its session sees. In the
   * background: a short model call compares them; a duplicate or a conflict is kept for the review
   * card. Nothing is shown when it is off (globally or for the folder), there is nothing to compare,
   * the folder's CLI has no headless mode, usage is paused or at the warning level, or it fails.
   */
  proposalAdded(proposal: MemoryEntry, approved: readonly MemoryEntry[]): void {
    if (this.#closed || approved.length === 0 || !this.settings().enabled || !this.#folderEnabled(proposal.scope)) return;
    this.#proposalQueue = this.#proposalQueue.then(() => this.#checkProposal(proposal, approved)).catch((error: unknown) => this.#a.onError(error));
  }

  async #checkProposal(proposal: MemoryEntry, approved: readonly MemoryEntry[]): Promise<void> {
    if (this.#closed) return;
    const cli = (await this.#o.host.folderCli(proposal.scope)) ?? 'claude';
    if (cli !== 'claude') return;
    const account = await this.#o.host.account(false);
    if ('blocked' in account) return;
    const output = await this.#o.runner({
      purpose: 'proposal',
      command: await this.#o.host.command('claude'),
      cwd: this.#o.host.workDir,
      env: account.env,
      prompt: memoryConflictPrompt(proposal, approved),
      model: MEMORY_CHECK_MODELS.proposal,
      timeoutMs: MEMORY_CHECK_TIMEOUT_MS.proposal,
    });
    this.#record(proposal.scope, account.profileId, output);
    if (!output.ok) return;
    const answer = readConflictAnswer(output.text, new Set(approved.map((entry) => entry.id)));
    if (answer.verdict !== 'duplicate' && answer.verdict !== 'conflict') return;
    const db = this.#a.db();
    const still = db?.get(proposal.id);
    const target = db?.get(answer.id);
    if (!db || !still || still.status !== 'proposed' || !target || target.status !== 'approved') return;
    db.putProposalCheck(proposal.id, { verdict: answer.verdict, targetId: target.id, targetTitle: target.title, reason: answer.reason, checkedAt: this.#a.now().toISOString() });
    this.#a.changed(proposal.scope);
  }
}
