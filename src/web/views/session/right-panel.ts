import type { Agent, SessionEvent } from '../../../core/api.ts';
import type {
  LifecyclePayload,
  RequestPayload,
  ResultPayload,
  ToolPayload,
} from '../../../core/event-payload.ts';
import type { FolderKind, SessionStatus } from '../../../core/model.ts';
import { folderName } from '../../folders/folders.ts';

/**
 * The session view's right panel (M4.3, SPEC → Session → Right panel; prototype
 * `agents`, `agentSummary`, `term`, `lineColor`): the agent cards, their summary
 * line and the terminal tail, kept free of React so `tests/web` can check them.
 * The rules are in `docs/session-panel.md`.
 */

// ── agent cards ──────────────────────────────────────────────────────────

/** Path line of an agent that has not written into a solution yet: it runs at the session's cwd, the workspace root. */
export const WORKSPACE_ROOT = 'workspace root';

/**
 * The path line of an agent without a solution path (D14): `workspace root` for a
 * workspace session; a repo session's agents run in its one solution, so its
 * name (the repo folder's name).
 */
export function rootPath(session: { readonly folderKind?: FolderKind | null; readonly folderPath?: string | null }): string {
  if (session.folderKind === 'repo' && session.folderPath) return folderName(session.folderPath);
  return WORKSPACE_ROOT;
}

/** Path values that are not a solution (the prototype's `agentSummary` leaves them out). */
const NOT_A_SOLUTION: ReadonlySet<string> = new Set([WORKSPACE_ROOT, 'read-only']);

/** The word next to an agent's dot when it has no status text of its own (prototype words: `needs you`, `running`, `done`, `paused`). */
const STATUS_WORDS: Readonly<Record<SessionStatus, string>> = {
  need: 'needs you',
  run: 'running',
  done: 'done',
  fail: 'failed',
  idle: 'idle',
  paused: 'paused',
};

/** One agent card (prototype `g`): dot + name + description + status, then path + ⎇ branch. */
export interface AgentCard {
  readonly id: string;
  readonly name: string;
  /** Empty when there is none. */
  readonly description: string;
  /** Status copy, e.g. `needs you`, `running`, or the agent's own progress text. */
  readonly statusText: string;
  /** Drives the dot and the status copy's color (`statusColor`). */
  readonly status: SessionStatus;
  /** Workspace-relative solution folder, or `workspace root`. */
  readonly path: string;
  /** `null` = no branch chip. */
  readonly branch: string | null;
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0] ?? '';
}

/**
 * An agent's description (the cards, D21's overview): its own (a subagent's
 * Agent-call description); the main agent, which has none, shows the first line
 * of the session's task.
 */
export function agentDescription(agent: Pick<Agent, 'kind' | 'description'>, task: string): string {
  return agent.description ?? (agent.kind === 'main' ? firstLine(task) : '');
}

/**
 * An agent's shown status and its own status text (the cards, D21's overview):
 * while the session is paused, an agent the pause cut off (`idle`) reads `paused`
 * and its text is dropped; `text` is `null` when the agent has none.
 */
export function agentStatus(
  agent: Pick<Agent, 'status' | 'statusText'>,
  sessionStatus: SessionStatus,
): { readonly status: SessionStatus; readonly text: string | null } {
  const cutByPause = sessionStatus === 'paused' && agent.status === 'idle';
  return { status: cutByPause ? 'paused' : agent.status, text: agent.statusText && !cutByPause ? agent.statusText : null };
}

/**
 * The cards, one per agent in creation order (the main agent first):
 * - description: the agent's own (a subagent's Agent-call description); the main
 *   agent, which has none, shows the first line of the session's task;
 * - status copy: the agent's status text (a subagent's latest progress), else the
 *   status word; while the session is paused, agents the pause cut off (`idle`)
 *   read `paused`;
 * - path: the solution folder the agent wrote into (`docs/derivations.md` →
 *   *Agents*), else `workspace root` (every agent runs at the session's cwd; D14:
 *   a repo session's repo name, {@link rootPath}).
 */
export function agentCards(
  agents: readonly Agent[],
  session: { readonly status: SessionStatus; readonly task: string; readonly folderKind?: FolderKind | null; readonly folderPath?: string | null },
): AgentCard[] {
  const root = rootPath(session);
  return agents.map((agent) => {
    const { status, text } = agentStatus(agent, session.status);
    return {
      id: agent.id,
      name: agent.name,
      description: agentDescription(agent, session.task),
      statusText: text ?? STATUS_WORDS[status],
      status,
      path: agent.solutionPath ?? root,
      branch: agent.branch,
    };
  });
}

/**
 * D37: a subagent that finished (`done`) leaves the right panel (its card and its
 * overview row); failed, running, waiting, idle and paused ones stay, and so does
 * the main agent, whatever its status.
 */
export function isFinishedSubagent(agent: Pick<Agent, 'kind' | 'status'>): boolean {
  return agent.kind !== 'main' && agent.status === 'done';
}

/** D37: the agents the right panel shows and how many finished subagents it hides. */
export interface PanelAgents<A> {
  /** The agents shown, in creation order: all of them while the finished ones are expanded. */
  readonly shown: readonly A[];
  /** How many finished subagents there are (the "✓ N finished" line, shown only when N > 0). */
  readonly finished: number;
}

/**
 * D37: the right panel's agents: without the finished subagents
 * ({@link isFinishedSubagent}) unless `expanded` (the "✓ N finished" line was
 * opened; the cards only, the overview never expands), and their count.
 */
export function panelAgents<A extends Pick<Agent, 'kind' | 'status'>>(agents: readonly A[], expanded: boolean): PanelAgents<A> {
  const finished = agents.filter(isFinishedSubagent).length;
  return { shown: expanded ? agents : agents.filter((agent) => !isFinishedSubagent(agent)), finished };
}

/** D37: the collapsed line under the agent cards: `✓ 2 finished`. */
export function finishedLine(count: number): string {
  return `✓ ${count} finished`;
}

/**
 * The line next to "Agents & solutions", in the prototype's words (`agentSummary`:
 * `n agents · n solutions · n branches`, never singular): agents, distinct solution
 * folders (not `workspace root` / `read-only`) and distinct branches, e.g.
 * `4 agents · 2 solutions · 1 branches`.
 */
export function agentSummary(agents: readonly Pick<Agent, 'solutionPath' | 'branch'>[]): string {
  const solutions = new Set(agents.map((a) => a.solutionPath).filter((p): p is string => p !== null && !NOT_A_SOLUTION.has(p)));
  const branches = new Set(agents.map((a) => a.branch).filter((b): b is string => b !== null && b !== ''));
  return `${agents.length} agents · ${solutions.size} solutions · ${branches.size} branches`;
}

// ── terminal tail ────────────────────────────────────────────────────────

/** How many lines the tail shows (the newest ones, the cursor included). */
export const TERMINAL_TAIL_LINES = 8;

/** Output lines shown under a finished Bash command (its last non-empty ones). */
export const BASH_OUTPUT_LINES = 3;

/** The cursor line while a turn runs (prototype `▍`). */
export const TERMINAL_CURSOR = '▍';

/**
 * A line's color (prototype `lineColor`, after an optional `[agent] ` prefix):
 * `cmd` `$ …` (#6d6c67), `ok` `✓ …` (green), `wait` `⏸ …` / `⚠ …` (amber),
 * `fail` `✕ …` (red), `out` anything else (#bfbeb8).
 */
export type LineTone = 'cmd' | 'ok' | 'wait' | 'fail' | 'out';

/** One line of the terminal tail. */
export interface TerminalLine {
  /** Unique within the tail (`<event id>:<n>`, or `cursor`). */
  readonly key: string;
  readonly text: string;
  readonly tone: LineTone;
}

/** The tone of a line's text (the prototype's `lineColor` rules). */
export function lineTone(text: string): LineTone {
  const body = text.replace(/^\[[\w-]+\] /, '');
  if (body.startsWith('$')) return 'cmd';
  if (body.startsWith('✓')) return 'ok';
  if (body.startsWith('⏸') || body.startsWith('⚠')) return 'wait';
  if (body.startsWith('✕')) return 'fail';
  return 'out';
}

function payloadOf(event: SessionEvent): { type?: unknown } | null {
  return event.payload && typeof event.payload === 'object' ? (event.payload as { type?: unknown }) : null;
}

function byTime(a: SessionEvent, b: SessionEvent): number {
  return a.ts === b.ts ? a.id - b.id : a.ts < b.ts ? -1 : 1;
}

function marked(mark: string | null, label: string): string {
  return mark ? `${mark} ${label}` : label;
}

/** A tool call's mark: `✕` failed, `✓` finished, `⏸` its request waits (AskUserQuestion), none while it runs. */
function toolMark(event: SessionEvent, tool: ToolPayload): string | null {
  if (tool.isError) return '✕';
  if (tool.result !== undefined || event.endTs !== null) return '✓';
  if (tool.requestState === 'open') return '⏸';
  return null;
}

/** The last `n` non-empty lines of a command's output, verbatim (trailing spaces cut). */
function outputTail(result: string | undefined, n: number): string[] {
  if (!result) return [];
  const lines = result.split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line !== '');
  return lines.slice(-n);
}

/**
 * The lines one event contributes (`docs/session-panel.md` → *Terminal tail*),
 * without the agent prefix:
 * - Bash (any agent): `$ <command's first line>`, then the last output lines;
 * - AskUserQuestion: `⏸ …` while it waits, `✓ …` once answered;
 * - any other tool call: a subagent's only (the main agent's are the chat's step
 *   lines), bare while it runs, `✓` / `✕` once done;
 * - permission requests `⏸` / `✓` / `✕`, automatic denials `✕`, a permission-mode
 *   mismatch `⚠`;
 * - a turn's result: its text (the process's output), `✕ …` when it failed;
 * - process lifecycle: the label, `✕ …` when it failed;
 * - conversation text (user, assistant, subagent prompts) and anything else: none.
 */
function eventLines(event: SessionEvent, isMain: boolean): string[] {
  const payload = payloadOf(event);
  switch (payload?.type) {
    case 'tool': {
      const tool = payload as ToolPayload;
      if (tool.name === 'Bash') {
        const command = typeof tool.input['command'] === 'string' ? firstLine(tool.input['command']) : event.label;
        return [`$ ${command}`, ...outputTail(tool.result, BASH_OUTPUT_LINES)];
      }
      if (isMain && tool.name !== 'AskUserQuestion') return [];
      return [marked(toolMark(event, tool), event.label)];
    }
    case 'request': {
      const request = payload as RequestPayload;
      const mark = request.state === 'open' ? '⏸' : request.state === 'responded' && request.behavior === 'allow' ? '✓' : '✕';
      return [marked(mark, event.label)];
    }
    case 'denied':
      return [marked('✕', event.label)];
    case 'mode-mismatch':
      return [marked('⚠', event.label)];
    case 'result':
      return [(payload as ResultPayload).isError ? marked('✕', event.label) : event.label];
    case 'lifecycle':
      return [event.kind === 'error' || (payload as LifecyclePayload).action === 'failed' ? marked('✕', event.label) : event.label];
    default:
      return [];
  }
}

/**
 * The terminal tail (SPEC → Session → Right panel; ARCHITECTURE: events drive the
 * terminal tail): the session's events in time order turned into lines, lines of
 * a subagent prefixed `[<agent name>] `, the cursor `▍` last while the session
 * runs a turn (status `run`), and only the newest {@link TERMINAL_TAIL_LINES}.
 */
export function terminalLines(
  events: readonly SessionEvent[],
  agents: readonly Pick<Agent, 'id' | 'kind' | 'name'>[],
  status: SessionStatus,
): TerminalLine[] {
  const names = new Map(agents.map((agent) => [agent.id, agent]));
  const out: TerminalLine[] = [];
  for (const event of [...events].sort(byTime)) {
    const agent = event.agentId === null ? undefined : names.get(event.agentId);
    const isMain = agent === undefined || agent.kind === 'main';
    const prefix = isMain ? '' : `[${agent.name}] `;
    eventLines(event, isMain).forEach((line, index) => {
      out.push({ key: `${event.id}:${index}`, text: `${prefix}${line}`, tone: lineTone(line) });
    });
  }
  if (status === 'run') out.push({ key: 'cursor', text: TERMINAL_CURSOR, tone: 'out' });
  return out.slice(-TERMINAL_TAIL_LINES);
}
