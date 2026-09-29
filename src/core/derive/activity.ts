/**
 * Live activity (D19; `docs/derivations.md` → *Live activity*): what a session's
 * running turn is doing now, derived in memory from the process's stream-json and
 * never guessed. The recorder feeds an {@link ActivityTracker} as lines arrive; its
 * {@link ActivityTracker.snapshot} is `Session.activity` and the `/hub` `activity`
 * payload. D30: the snapshot also carries the pending background tasks
 * (`./background.ts`), and shows them (state `background`) while no turn runs.
 * Pure: the clock is injected, nothing is stored.
 */
import type { ActivityState, AgentActivity, BackgroundTask, BackgroundTaskKind, SessionActivity } from '../api.ts';
import { AGENT_TOOLS } from './event-kind.ts';

/** Longest tool summary (characters, `…` included). */
export const SUMMARY_MAX = 80;

/**
 * D30: the tool behind each kind of background task (the `tool` of a `background`
 * activity). D43: `Workflow` for a workflow; none for a `task` (the CLI reported it,
 * no known tool started it).
 */
export const BACKGROUND_TOOLS: Readonly<Record<BackgroundTaskKind, string | null>> = {
  bash: 'Bash',
  agent: 'Agent',
  monitor: 'Monitor',
  wakeup: 'ScheduleWakeup',
  workflow: 'Workflow',
  task: null,
};

function text(input: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function firstLine(value: string): string {
  return value.trim().split('\n', 1)[0]?.trim() ?? '';
}

function baseName(file: string): string {
  return file.split(/[\\/]/).filter(Boolean).at(-1) ?? file;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function clipSummary(value: string): string {
  return value.length > SUMMARY_MAX ? `${value.slice(0, SUMMARY_MAX - 1)}…` : value;
}

/**
 * A tool call's short, literal summary (D19): Bash → the command's first line;
 * Read / Edit / Write → the file name; Grep / Glob → the pattern; Agent / Task →
 * its description; WebFetch → the host; anything else (or an input without that
 * field) → the tool name. At most {@link SUMMARY_MAX} characters.
 */
export function toolSummary(name: string, input: Readonly<Record<string, unknown>>): string {
  let summary: string | null = null;
  if (name === 'Bash') {
    const command = text(input, 'command');
    summary = command ? firstLine(command) : null;
  } else if (name === 'Read' || name === 'Edit' || name === 'Write') {
    const file = text(input, 'file_path');
    summary = file ? baseName(file) : null;
  } else if (name === 'Grep' || name === 'Glob') {
    const pattern = text(input, 'pattern');
    summary = pattern ? firstLine(pattern) : null;
  } else if (AGENT_TOOLS.includes(name)) {
    const description = text(input, 'description');
    summary = description ? firstLine(description) : null;
  } else if (name === 'WebFetch') {
    const url = text(input, 'url');
    summary = url ? hostOf(url.trim()) : null;
  }
  return clipSummary(summary || name);
}

/** Options for {@link ActivityTracker}. */
export interface ActivityTrackerOptions {
  /** The session's main agent: lines without `parent_tool_use_id`, the thinking-token ticks. */
  readonly mainAgentId: string;
  /** Clock (tests pass a fake one). */
  readonly now?: () => Date;
}

interface OpenTool {
  readonly agentId: string;
  readonly name: string;
  readonly summary: string;
  readonly since: string;
}

interface AgentEntry {
  /** What the agent does when it has no open tool or request. */
  phase: 'thinking' | 'writing';
  phaseSince: string;
  readonly startedAt: string;
}

interface OpenRequest {
  readonly agentId: string;
  readonly since: string;
}

/**
 * The live activity of one process (D19). Between a turn's start and its end it
 * tracks, per agent, the open tool calls (until their `tool_result`), the open
 * questions / permission requests and whether the agent last thought or wrote;
 * outside a turn every call is ignored and the snapshot is `null`.
 *
 * - **Turn start** ({@link startTurn}): the main agent is `thinking`, no tokens yet.
 * - **Thinking tokens**: the main agent's ticks add their delta to the turn's total
 *   (`estimated_tokens` restarts per model message) and mean `thinking`.
 * - **Tool**: an agent runs a tool from its `tool_use` until the `tool_result`; with
 *   several open, the newest shows. After the last one ends it is `thinking` again.
 * - **Text** → `writing`; a thinking block → `thinking`.
 * - **Waiting**: an agent with an open request is `waiting`; the session is
 *   `waiting` while any request is open, else it shows the main agent's state.
 * - **Subagents** get an entry when they start (or first act) and lose it when
 *   they end.
 * - **Background** (D30): {@link snapshot} takes the pending background tasks; they
 *   ride along while a turn runs, and make the snapshot a `background` one while
 *   none does.
 */
export class ActivityTracker {
  readonly #main: string;
  readonly #now: () => Date;
  #turnStartedAt: string | null = null;
  #tokens: number | null = null;
  #lastEstimate: number | null = null;
  readonly #agents = new Map<string, AgentEntry>();
  /** Open tool calls by `tool_use` id, in start order. */
  readonly #tools = new Map<string, OpenTool>();
  readonly #requests = new Map<string, OpenRequest>();

  constructor(options: ActivityTrackerOptions) {
    this.#main = options.mainAgentId;
    this.#now = options.now ?? (() => new Date());
  }

  /** `true` between a turn's start and its end. */
  get running(): boolean {
    return this.#turnStartedAt !== null;
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  #entry(agentId: string): AgentEntry {
    let entry = this.#agents.get(agentId);
    if (!entry) {
      const now = this.#stamp();
      entry = { phase: 'thinking', phaseSince: now, startedAt: now };
      this.#agents.set(agentId, entry);
    }
    return entry;
  }

  #phase(agentId: string, phase: AgentEntry['phase'], restart = false): void {
    const entry = this.#entry(agentId);
    if (entry.phase === phase && !restart) return;
    entry.phase = phase;
    entry.phaseSince = this.#stamp();
  }

  /** A turn started (the user message was taken up, or the CLI began one itself); a no-op while one runs. */
  startTurn(): void {
    if (this.running) return;
    this.#turnStartedAt = this.#stamp();
    this.#tokens = null;
    this.#lastEstimate = null;
    this.#agents.clear();
    this.#tools.clear();
    this.#requests.clear();
    this.#entry(this.#main);
  }

  /** The turn ended (its `result`, or the process stopped): back to idle. */
  endTurn(): void {
    this.#turnStartedAt = null;
    this.#tokens = null;
    this.#lastEstimate = null;
    this.#agents.clear();
    this.#tools.clear();
    this.#requests.clear();
  }

  /**
   * A `system/thinking_tokens` tick of `agentId`. The main agent's ticks count
   * toward the turn's total: the delta, or (without one) the rise of the estimate
   * since the previous tick, a drop meaning a new model message.
   */
  thinkingTokens(agentId: string, estimated: number | null, delta: number | null): void {
    if (!this.running) return;
    if (agentId === this.#main) {
      let add: number | null = delta;
      if (add === null && estimated !== null) add = this.#lastEstimate !== null && estimated >= this.#lastEstimate ? estimated - this.#lastEstimate : estimated;
      if (estimated !== null) this.#lastEstimate = estimated;
      if (add !== null && add > 0) this.#tokens = (this.#tokens ?? 0) + add;
    }
    this.#phase(agentId, 'thinking');
  }

  /** A thinking block of `agentId`. */
  thinking(agentId: string): void {
    if (this.running) this.#phase(agentId, 'thinking');
  }

  /** A text block of `agentId`. */
  writing(agentId: string): void {
    if (this.running) this.#phase(agentId, 'writing');
  }

  /** A `tool_use` of `agentId`. */
  toolStarted(agentId: string, toolUseId: string, name: string, input: Readonly<Record<string, unknown>>): void {
    if (!this.running || toolUseId === '') return;
    this.#entry(agentId);
    this.#tools.delete(toolUseId);
    this.#tools.set(toolUseId, { agentId, name, summary: toolSummary(name, input), since: this.#stamp() });
  }

  /** The `tool_result` of a tool call; its agent thinks again once it has no open tool left. */
  toolEnded(toolUseId: string): void {
    const tool = this.#tools.get(toolUseId);
    if (!tool) return;
    this.#tools.delete(toolUseId);
    if (!this.#agents.has(tool.agentId)) return;
    if (![...this.#tools.values()].some((open) => open.agentId === tool.agentId)) this.#phase(tool.agentId, 'thinking', true);
  }

  /** A question batch or permission request of `agentId` is open. */
  requestOpened(requestId: string, agentId: string): void {
    if (!this.running || this.#requests.has(requestId)) return;
    this.#entry(agentId);
    this.#requests.set(requestId, { agentId, since: this.#stamp() });
  }

  /** The request was answered, withdrawn or went stale. */
  requestClosed(requestId: string): void {
    this.#requests.delete(requestId);
  }

  /** A subagent started (its Agent call, its `task_started`). */
  agentStarted(agentId: string): void {
    if (this.running) this.#entry(agentId);
  }

  /** A subagent ended: its entry and its open tool calls go. The main agent stays until the turn ends. */
  agentEnded(agentId: string): void {
    if (agentId === this.#main) return;
    this.#agents.delete(agentId);
    for (const [id, tool] of this.#tools) if (tool.agentId === agentId) this.#tools.delete(id);
  }

  #agentActivity(agentId: string, entry: AgentEntry): AgentActivity {
    const requests = [...this.#requests.values()].filter((request) => request.agentId === agentId);
    if (requests.length > 0) {
      return { state: 'waiting', since: earliest(requests.map((r) => r.since)), startedAt: entry.startedAt, tool: null, summary: null };
    }
    const tools = [...this.#tools.values()].filter((tool) => tool.agentId === agentId);
    const tool = tools.at(-1);
    if (tool) return { state: 'tool', since: tool.since, startedAt: entry.startedAt, tool: tool.name, summary: tool.summary };
    return { state: entry.phase, since: entry.phaseSince, startedAt: entry.startedAt, tool: null, summary: null };
  }

  /**
   * The current activity with the main agent's pending background tasks (D30,
   * oldest first). Outside a turn: `background` while any task is pending (since
   * the oldest one started; the main agent's entry the same), else `null`.
   */
  snapshot(background: readonly BackgroundTask[] = []): SessionActivity | null {
    const turnStartedAt = this.#turnStartedAt;
    if (turnStartedAt === null) return background.length > 0 ? this.#backgroundSnapshot(background) : null;
    const agents: Record<string, AgentActivity> = {};
    for (const [id, entry] of this.#agents) agents[id] = this.#agentActivity(id, entry);
    const main = agents[this.#main] ?? { state: 'thinking' as ActivityState, since: turnStartedAt, startedAt: turnStartedAt, tool: null, summary: null };
    const waiting = [...this.#requests.values()];
    const top =
      waiting.length > 0
        ? { state: 'waiting' as ActivityState, since: earliest(waiting.map((r) => r.since)), tool: null, summary: null }
        : { state: main.state, since: main.since, tool: main.tool, summary: main.summary };
    return { turnStartedAt, ...top, thinkingTokens: this.#tokens, agents, background: [...background] };
  }

  /** D30: no turn runs, the oldest pending task shows (its tool, its summary, since it started). */
  #backgroundSnapshot(background: readonly BackgroundTask[]): SessionActivity {
    const oldest = [...background].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))[0] as BackgroundTask;
    const since = oldest.startedAt;
    const tool = BACKGROUND_TOOLS[oldest.kind];
    const main: AgentActivity = { state: 'background', since, startedAt: since, tool, summary: oldest.summary };
    return { turnStartedAt: since, state: 'background', since, tool, summary: oldest.summary, thinkingTokens: null, agents: { [this.#main]: main }, background: [...background] };
  }
}

function earliest(stamps: readonly string[]): string {
  return [...stamps].sort()[0] ?? '';
}
