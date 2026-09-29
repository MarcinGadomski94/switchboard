/**
 * Workflow agents (D51; `docs/derivations.md` → *Workflow agents*): the agents a
 * `Workflow` run starts, derived from what the CLI streams and writes. Pure: the
 * server reads the files (`src/server/workflows/`) and feeds their parsed contents
 * here; nothing is stored.
 *
 * What CLI 2.1.284 has (read in its binary and in real session folders, read-only):
 * - **The launch.** A background `Workflow` call's `tool_result`: `Workflow launched in
 *   background. Task ID: w…`, `Summary: …`, `Transcript dir: <projects>/<slug>/<session>/subagents/workflows/<runId>`,
 *   `Run ID: wf_…`, with `tool_use_result` `{status: "async_launched", taskId, taskType:
 *   "local_workflow", workflowName, runId, summary, transcriptDir, scriptPath}`.
 * - **Live progress on stdout.** `system/task_progress` of the workflow's task with
 *   `workflow_progress`: the whole list of `{type: "workflow_phase", index, title}` and
 *   `{type: "workflow_agent", index, label, phaseIndex, phaseTitle, agentId, model,
 *   state, startedAt, queuedAt, lastToolName, lastToolSummary, durationMs, error, …}`
 *   entries (times in epoch ms), sent at most every few seconds while agents only
 *   progress, at once when one starts or ends (otherwise the line has none).
 *   `state` is `start` (queued: no `startedAt`; spawned: with it), `progress`, `done`
 *   or `error`.
 * - **Files, written live.** `<session>/subagents/workflows/<runId>/journal.jsonl`
 *   (`{type: "launched"}`, then per agent `{type: "started", key, agentId, label,
 *   phase}` and `{type: "result", key, agentId, result}` or `{type: "failed", key,
 *   agentId}`), and per agent `agent-<agentId>.jsonl` (its transcript: sidechain
 *   entries, the first user line is its brief) + `agent-<agentId>.meta.json`
 *   (`{agentType: "workflow-subagent", description: <label>, workflowPhase, …}`).
 * - **The run file, written once at the end.** `<session>/workflows/<runId>.json`:
 *   `{runId, taskId, workflowName, summary, status ("completed" / "failed" / …),
 *   startTime, durationMs, phases: [{title, detail}], defaultModel, workflowProgress,
 *   agentCount, …}`.
 */
import type { Agent, AgentWorkflow, SessionEvent, WorkflowAgentAction, WorkflowRun } from '../api.ts';
import type { SessionStatus } from '../model.ts';
import { type AgentPromptPayload, type ToolPayload, clip, clipInput } from '../event-payload.ts';
import { toolSummary } from './activity.ts';
import { textLabel, toolEventKind, toolLabel } from './event-kind.ts';
import { agentStatusFromTask } from './agents.ts';
import { newestChain, transcriptItems } from '../transcript-sync.ts';

/** A run id as the CLI names run folders and files (`wf_1a2b3c4d-5e6`). Anything else is never used as a path part. */
export const WORKFLOW_RUN_ID = /^wf_[A-Za-z0-9_-]{1,64}$/;

/** A workflow agent's id (`a0d1040568bcdbfe4`), as in `agent-<id>.jsonl`. */
export const WORKFLOW_AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `agent-<id>.jsonl` / `agent-<id>.meta.json` in a run folder; group 1 = the id, group 2 = `meta.json` or `jsonl`. */
export const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,64})\.(meta\.json|jsonl)$/;

type Json = Readonly<Record<string, unknown>>;

function record(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Epoch ms (the CLI's numbers) or an ISO text → ISO; `null` for anything else. */
function iso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function runId(value: unknown): string | null {
  return typeof value === 'string' && WORKFLOW_RUN_ID.test(value) ? value : null;
}

function agentIdOf(value: unknown): string | null {
  return typeof value === 'string' && WORKFLOW_AGENT_ID.test(value) ? value : null;
}

// ── launch ───────────────────────────────────────────────────────────────

/** What a `Workflow` launch told the main agent (its `tool_result`). */
export interface WorkflowLaunch {
  readonly runId: string;
  readonly taskId: string | null;
  readonly name: string | null;
  readonly summary: string | null;
}

const LAUNCH_TASK = /Workflow launched (?:in background|in a remote CCR session)\. Task ID: ([A-Za-z0-9_-]+)/;
const LAUNCH_RUN = /(?:^|\n)Run ID: (wf_[A-Za-z0-9_-]+)/;
const LAUNCH_DIR = /(?:^|\n)Transcript dir: [^\n]*[\\/](wf_[A-Za-z0-9_-]+)\s*(?:\n|$)/;
const LAUNCH_SUMMARY = /(?:^|\n)Summary: ([^\n]+)/;

/**
 * A `Workflow` call's result → the run it launched: the structured result's `runId`
 * (else the text's `Run ID:`, else the run folder at the end of `Transcript dir:`),
 * task id, name and summary. `null` when it launched nothing (an error, a script
 * that did not compile) or names no valid run id. Only the run id is ever used to
 * find files: the transcript dir's path is not followed.
 */
export function workflowLaunch(text: string, detail: unknown): WorkflowLaunch | null {
  const structured = record(detail);
  if (typeof structured?.['error'] === 'string') return null;
  const id = runId(structured?.['runId']) ?? runId(LAUNCH_RUN.exec(text)?.[1]) ?? runId(LAUNCH_DIR.exec(text)?.[1]);
  if (id === null) return null;
  if (structured === null && !LAUNCH_TASK.test(text)) return null;
  return {
    runId: id,
    taskId: str(structured?.['taskId']) ?? LAUNCH_TASK.exec(text)?.[1] ?? null,
    name: str(structured?.['workflowName']),
    summary: str(structured?.['summary']) ?? str(LAUNCH_SUMMARY.exec(text)?.[1]),
  };
}

// ── progress (stream snapshot and run file) ──────────────────────────────

/** One `workflow_agent` entry of a progress list. */
export interface ProgressAgent {
  readonly index: number;
  readonly label: string | null;
  readonly phaseIndex: number | null;
  readonly phaseTitle: string | null;
  readonly agentId: string | null;
  readonly model: string | null;
  /** `start` / `progress` / `done` / `error` (CLI 2.1.284); kept verbatim. */
  readonly state: string | null;
  readonly startedAt: string | null;
  readonly queuedAt: string | null;
  readonly lastToolName: string | null;
  readonly lastToolSummary: string | null;
  readonly lastProgressAt: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly resultPreview: string | null;
}

/** A progress list: its agents (one per index, the latest entry wins) and phases. */
export interface WorkflowProgress {
  readonly agents: readonly ProgressAgent[];
  readonly phases: readonly { readonly index: number; readonly title: string }[];
}

/** Parses a `workflow_progress` / `workflowProgress` list; unknown entries (`workflow_log`, …) are skipped. */
export function parseWorkflowProgress(value: unknown): WorkflowProgress {
  const agents = new Map<number, ProgressAgent>();
  const phases = new Map<number, string>();
  for (const item of Array.isArray(value) ? value : []) {
    const entry = record(item);
    const index = num(entry?.['index']);
    if (!entry || index === null) continue;
    if (entry['type'] === 'workflow_phase') {
      const title = str(entry['title']);
      if (title) phases.set(index, title);
    } else if (entry['type'] === 'workflow_agent') {
      agents.set(index, {
        index,
        label: str(entry['label']),
        phaseIndex: num(entry['phaseIndex']),
        phaseTitle: str(entry['phaseTitle']),
        agentId: agentIdOf(entry['agentId']),
        model: str(entry['model']),
        state: str(entry['state']),
        startedAt: iso(entry['startedAt']),
        queuedAt: iso(entry['queuedAt']),
        lastToolName: str(entry['lastToolName']),
        lastToolSummary: str(entry['lastToolSummary']),
        lastProgressAt: iso(entry['lastProgressAt']),
        durationMs: num(entry['durationMs']),
        error: str(entry['error']),
        resultPreview: str(entry['resultPreview']),
      });
    }
  }
  return {
    agents: [...agents.values()].sort((a, b) => a.index - b.index),
    phases: [...phases].sort((a, b) => a[0] - b[0]).map(([index, title]) => ({ index, title })),
  };
}

/** The run file (`workflows/<runId>.json`, written when the run ends). */
export interface RunFileFacts {
  readonly runId: string;
  readonly taskId: string | null;
  readonly name: string | null;
  readonly summary: string | null;
  /** `completed`, `failed`, `killed`, … verbatim. */
  readonly status: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly phases: readonly string[];
  readonly defaultModel: string | null;
  readonly progress: WorkflowProgress;
}

/** Parses a run file's JSON; `null` when it is not one (no valid `runId`). */
export function parseRunFile(value: unknown): RunFileFacts | null {
  const file = record(value);
  const id = runId(file?.['runId']);
  if (!file || id === null) return null;
  const start = num(file['startTime']);
  const duration = num(file['durationMs']);
  const phases = (Array.isArray(file['phases']) ? file['phases'] : []).map((phase) => str(record(phase)?.['title'])).filter((title): title is string => title !== null);
  return {
    runId: id,
    taskId: str(file['taskId']),
    name: str(file['workflowName']),
    summary: str(file['summary']),
    status: str(file['status']) ?? (file['error'] ? 'failed' : 'completed'),
    startedAt: iso(start) ?? iso(file['timestamp']),
    endedAt: start !== null && duration !== null ? iso(start + duration) : iso(file['timestamp']),
    phases,
    defaultModel: str(file['defaultModel']),
    progress: parseWorkflowProgress(file['workflowProgress']),
  };
}

// ── journal, meta, script ────────────────────────────────────────────────

/** One journal line (`subagents/workflows/<runId>/journal.jsonl`). */
export type JournalEntry =
  | { readonly type: 'started'; readonly agentId: string; readonly label: string | null; readonly phase: string | null }
  | { readonly type: 'result'; readonly agentId: string; readonly result: unknown }
  | { readonly type: 'failed'; readonly agentId: string };

/** Parses the journal's text; `launched`, unknown and cut lines are skipped. */
export function parseJournal(text: string): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let entry: Json | null;
    try {
      entry = record(JSON.parse(trimmed));
    } catch {
      continue; // cut by the writer: complete on the next read
    }
    const agentId = agentIdOf(entry?.['agentId']);
    if (!entry || agentId === null) continue;
    if (entry['type'] === 'started') out.push({ type: 'started', agentId, label: str(entry['label']), phase: str(entry['phase']) });
    else if (entry['type'] === 'result') out.push({ type: 'result', agentId, result: entry['result'] });
    else if (entry['type'] === 'failed') out.push({ type: 'failed', agentId });
  }
  return out;
}

/** An agent's meta file (`agent-<id>.meta.json`): its label and phase. */
export interface AgentMeta {
  readonly label: string | null;
  readonly phase: string | null;
}

export function parseAgentMeta(value: unknown): AgentMeta | null {
  const meta = record(value);
  return meta ? { label: str(meta['description']), phase: str(meta['workflowPhase']) } : null;
}

/** What the script file says about itself (`export const meta = { name, description, phases: [{ title }] }`). */
export interface ScriptMeta {
  readonly name: string | null;
  readonly summary: string | null;
  readonly phases: readonly string[];
}

/** One quoted literal (', " or `) without escapes inside; group 1 = its text. */
const QUOTED = String.raw`(?:'([^'\\\n]*)'|"([^"\\\n]*)"|\x60([^\x60\\]*)\x60)`;

function quoted(match: RegExpExecArray | null): string | null {
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

/**
 * The script's `meta` (read, never run): `name`, `description` and the phase
 * titles, from the object literal after `export const meta =`; `null` fields when
 * the script is not written that plainly.
 */
export function parseScriptMeta(text: string): ScriptMeta {
  const at = text.search(/export\s+const\s+meta\s*=\s*\{/);
  if (at < 0) return { name: null, summary: null, phases: [] };
  // The meta object: up to the first `}` that closes it at depth 0 (strings with braces are rare in metas).
  let depth = 0;
  let end = text.length;
  for (let i = text.indexOf('{', at); i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const body = text.slice(at, end);
  const phasesAt = body.search(/phases\s*:/);
  const head = phasesAt < 0 ? body : body.slice(0, phasesAt);
  const phases = phasesAt < 0 ? [] : [...body.slice(phasesAt).matchAll(new RegExp(String.raw`title\s*:\s*${QUOTED}`, 'g'))].map((m) => m[1] ?? m[2] ?? m[3] ?? '').filter((t) => t !== '');
  return {
    name: quoted(new RegExp(String.raw`\bname\s*:\s*${QUOTED}`).exec(head)),
    summary: quoted(new RegExp(String.raw`\bdescription\s*:\s*${QUOTED}`).exec(head)),
    phases,
  };
}

/** The run's name in a script file's name (`<name>-<runId>.js`), `null` when it is not one. */
export function scriptFileName(file: string, id: string): string | null {
  const suffix = `-${id}.js`;
  return file.endsWith(suffix) && file.length > suffix.length ? file.slice(0, -suffix.length) : null;
}

// ── an agent's transcript ────────────────────────────────────────────────

/** What the run's views need from an agent's transcript (read in part: its head, then what was appended). */
export interface AgentTranscriptFacts {
  readonly cwd: string | null;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  /** The model of its last assistant line. */
  readonly model: string | null;
  /** Its last tool call. */
  readonly lastTool: { readonly name: string; readonly summary: string | null; readonly at: string | null } | null;
  /** Bytes read so far (the chat's `version`). */
  readonly bytes: number;
}

/** Facts of a transcript nothing was read of yet. */
export const NO_TRANSCRIPT: AgentTranscriptFacts = { cwd: null, firstAt: null, lastAt: null, model: null, lastTool: null, bytes: 0 };

/** `prev` updated with the parsed `entries` read from it (in file order), now `bytes` long. */
export function scanAgentEntries(prev: AgentTranscriptFacts, entries: readonly Json[], bytes: number): AgentTranscriptFacts {
  let { cwd, firstAt, lastAt, model, lastTool } = prev;
  for (const entry of entries) {
    const at = iso(entry['timestamp']);
    if (at) {
      firstAt ??= at;
      if (lastAt === null || at > lastAt) lastAt = at;
    }
    cwd ??= str(entry['cwd']);
    if (entry['type'] !== 'assistant') continue;
    const message = record(entry['message']);
    const name = str(message?.['model']);
    if (name && name !== '<synthetic>') model = name;
    for (const block of Array.isArray(message?.['content']) ? (message['content'] as unknown[]) : []) {
      const b = record(block);
      const tool = str(b?.['name']);
      if (b?.['type'] === 'tool_use' && tool) lastTool = { name: tool, summary: toolSummary(tool, record(b['input']) ?? {}), at };
    }
  }
  return { cwd, firstAt, lastAt, model, lastTool, bytes };
}

// ── the run and its agents ───────────────────────────────────────────────

/** Everything known about one run (the server gathers it; see the module comment). */
export interface WorkflowRunInput {
  readonly runId: string;
  /** From the `Workflow` call's result (this process saw it). */
  readonly launch: WorkflowLaunch | null;
  /** When the launch was seen (ISO). */
  readonly launchedAt?: string | null;
  readonly runFile: RunFileFacts | null;
  /** The latest `task_progress` snapshot of this process. */
  readonly progress: WorkflowProgress | null;
  readonly journal: readonly JournalEntry[];
  readonly metas: ReadonlyMap<string, AgentMeta>;
  readonly transcripts: ReadonlyMap<string, AgentTranscriptFacts>;
  readonly script: ScriptMeta | null;
  /** The task's final status on stdout (`task_updated` / `task_notification`), `null` while none came. */
  readonly ended: string | null;
  /** The run may still be running: the process that launched it is alive and has not reported its end, or its files changed a moment ago. */
  readonly running: boolean;
}

/** One agent of a run, as {@link deriveWorkflowRun} returns it. */
export interface WorkflowAgentView {
  readonly id: string;
  readonly label: string;
  readonly status: SessionStatus;
  /** `queued` for an agent waiting for its turn; `null` otherwise. */
  readonly statusText: string | null;
  readonly workflow: AgentWorkflow;
  /** Its return value or error for its chat; `null` while it runs. */
  readonly result: { readonly text: string; readonly isError: boolean } | null;
}

/** The API id of a workflow agent: `<runId>.<agentId>`, or `<runId>.q<index>` while it is queued. */
export function workflowAgentKey(id: string, agentId: string | null, index: number | null): string {
  return agentId !== null ? `${id}.${agentId}` : `${id}.q${index ?? 0}`;
}

/** The status a progress `state` means: `start` without a start time is queued (`idle`), `start` / `progress` run, `done`, `error` fails. */
export function progressStatus(agent: Pick<ProgressAgent, 'state' | 'startedAt' | 'agentId'>): { status: SessionStatus; queued: boolean } {
  switch (agent.state) {
    case 'done':
      return { status: 'done', queued: false };
    case 'error':
      return { status: 'fail', queued: false };
    case 'progress':
      return { status: 'run', queued: false };
    default:
      return agent.startedAt !== null || agent.agentId !== null ? { status: 'run', queued: false } : { status: 'idle', queued: true };
  }
}

/** A run file's / task's final status → the run's: `completed` → done, `failed` / `error` → fail, anything else (killed, stopped) → idle. */
export function runStatus(status: string): SessionStatus {
  const mapped = agentStatusFromTask(status);
  return mapped === 'run' ? 'idle' : mapped;
}

/** The result text an agent's chat shows: a string as it is, anything else as a JSON code block (cut long). */
export function resultText(result: unknown): string {
  if (typeof result === 'string') return clip(result).text;
  const json = JSON.stringify(result, null, 2) ?? String(result);
  return `\`\`\`json\n${clip(json).text}\n\`\`\``;
}

interface Draft {
  index: number | null;
  agentId: string | null;
  label: string | null;
  phase: string | null;
  phaseIndex: number | null;
  model: string | null;
  status: SessionStatus;
  queued: boolean;
  startedAt: string | null;
  endedAt: string | null;
  action: WorkflowAgentAction | null;
  error: string | null;
  result: unknown;
  hasResult: boolean;
  order: number;
}

function draftFromProgress(agent: ProgressAgent, order: number): Draft {
  const { status, queued } = progressStatus(agent);
  const ended = status === 'done' || status === 'fail';
  const endedAt = ended && agent.startedAt !== null && agent.durationMs !== null ? new Date(Date.parse(agent.startedAt) + agent.durationMs).toISOString() : null;
  return {
    index: agent.index,
    agentId: agent.agentId,
    label: agent.label,
    phase: agent.phaseTitle,
    phaseIndex: agent.phaseIndex,
    model: agent.model,
    status,
    queued,
    startedAt: agent.startedAt,
    endedAt: endedAt ?? (ended ? agent.lastProgressAt : null),
    action: status === 'run' && agent.lastToolName ? { tool: agent.lastToolName, summary: agent.lastToolSummary, since: agent.lastProgressAt ?? agent.startedAt ?? agent.queuedAt ?? '' } : null,
    error: agent.error,
    result: undefined,
    hasResult: false,
    order,
  };
}

/**
 * One run and its agents from everything known about it (`docs/derivations.md` →
 * *Workflow agents*):
 * - **agents:** the run file's progress list once it exists (final), else this
 *   process's latest `task_progress` snapshot, else nothing; then every agent the
 *   journal started that neither lists (matched by agent id, else a queued entry of
 *   the same label), then every agent with only a meta file; the journal's
 *   `result` / `failed` end an agent (done / failed);
 * - **status:** `start` without a start time → queued (`idle`, "queued"); `start` /
 *   `progress` → `run`; `done`; `error` → `fail`. Once the run is no longer running,
 *   agents still running or queued were cut off → `idle`;
 * - **the run's status:** the run file's (`completed` → done, `failed` → fail, else
 *   idle), else the task's end on stdout, else `run` while {@link WorkflowRunInput.running},
 *   else `idle` (it stopped: its process ended before the run did);
 * - **phase:** the phase of the newest agent that started (in script order), else
 *   the first phase; times, model and the current action from the progress entry,
 *   else the transcript (its newer last tool wins).
 */
export function deriveWorkflowRun(input: WorkflowRunInput): { run: WorkflowRun; agents: WorkflowAgentView[] } {
  const listed = input.runFile?.progress.agents.length ? input.runFile.progress : (input.progress ?? input.runFile?.progress ?? null);
  const drafts: Draft[] = (listed?.agents ?? []).map((agent, order) => draftFromProgress(agent, order));
  const byAgent = new Map<string, Draft>();
  for (const draft of drafts) if (draft.agentId !== null) byAgent.set(draft.agentId, draft);
  let order = drafts.length;
  const adopt = (agentId: string, label: string | null, phase: string | null): Draft => {
    const known = byAgent.get(agentId);
    if (known) return known;
    // A queued entry of an older snapshot that has started since: the same agent.
    const waiting = drafts.find((draft) => draft.agentId === null && draft.label !== null && draft.label === label);
    const draft: Draft = waiting ?? {
      index: null,
      agentId,
      label,
      phase,
      phaseIndex: null,
      model: null,
      status: 'run',
      queued: false,
      startedAt: null,
      endedAt: null,
      action: null,
      error: null,
      result: undefined,
      hasResult: false,
      order: order++,
    };
    if (waiting) {
      waiting.agentId = agentId;
      if (waiting.queued) {
        waiting.status = 'run';
        waiting.queued = false;
      }
    } else {
      drafts.push(draft);
    }
    draft.label ??= label;
    draft.phase ??= phase;
    byAgent.set(agentId, draft);
    return draft;
  };
  for (const entry of input.journal) {
    if (entry.type === 'started') {
      adopt(entry.agentId, entry.label, entry.phase);
    } else {
      const meta = input.metas.get(entry.agentId);
      const draft = adopt(entry.agentId, meta?.label ?? null, meta?.phase ?? null);
      if (entry.type === 'result') {
        draft.status = 'done';
        draft.result = entry.result;
        draft.hasResult = true;
      } else if (draft.status !== 'done') {
        draft.status = 'fail';
      }
      draft.queued = false;
      draft.action = null;
    }
  }
  for (const [agentId, meta] of input.metas) adopt(agentId, meta.label, meta.phase);

  const ended = input.runFile !== null || input.ended !== null || !input.running;
  const status: SessionStatus = input.runFile?.status
    ? runStatus(input.runFile.status)
    : input.ended !== null
      ? runStatus(input.ended)
      : input.running
        ? 'run'
        : 'idle';

  const agents: WorkflowAgentView[] = [];
  const sorted = [...drafts].sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER) || a.order - b.order);
  for (const draft of sorted) {
    const facts = draft.agentId !== null ? input.transcripts.get(draft.agentId) ?? null : null;
    const meta = draft.agentId !== null ? input.metas.get(draft.agentId) ?? null : null;
    let agentStatus = draft.status;
    let queued = draft.queued;
    // The run is over: whatever still runs or waits was cut off.
    if (ended && (agentStatus === 'run' || queued)) {
      agentStatus = 'idle';
      queued = false;
    }
    const running = agentStatus === 'run';
    let action = running ? draft.action : null;
    const last = facts?.lastTool ?? null;
    if (running && last && (action === null || (last.at !== null && last.at >= action.since))) {
      action = { tool: last.name, summary: last.summary, since: last.at ?? action?.since ?? draft.startedAt ?? '' };
    }
    const startedAt = draft.startedAt ?? facts?.firstAt ?? null;
    const endedAt = agentStatus === 'done' || agentStatus === 'fail' || agentStatus === 'idle' ? (draft.endedAt ?? (queued ? null : facts?.lastAt ?? null)) : null;
    const label = draft.label ?? meta?.label ?? (draft.index !== null ? `agent ${draft.index}` : (draft.agentId ?? 'agent'));
    const result = draft.hasResult ? { text: resultText(draft.result), isError: false } : agentStatus === 'fail' ? { text: draft.error ?? 'The agent failed.', isError: true } : null;
    agents.push({
      id: workflowAgentKey(input.runId, draft.agentId, draft.index),
      label,
      status: agentStatus,
      statusText: queued ? 'queued' : null,
      workflow: {
        runId: input.runId,
        index: draft.index,
        agentId: draft.agentId,
        phase: draft.phase ?? meta?.phase ?? null,
        model: draft.model ?? facts?.model ?? input.runFile?.defaultModel ?? null,
        startedAt: queued ? null : startedAt,
        endedAt,
        action: action && action.since !== '' ? action : action ? { ...action, since: startedAt ?? new Date(0).toISOString() } : null,
        cwd: facts?.cwd ?? null,
        version: facts?.bytes ?? 0,
      },
      result,
    });
  }

  const phases = input.runFile?.phases.length
    ? input.runFile.phases
    : listed?.phases.length
      ? listed.phases.map((phase) => phase.title)
      : input.script?.phases.length
        ? input.script.phases
        : [...new Set(agents.map((agent) => agent.workflow.phase).filter((phase): phase is string => phase !== null))];
  const started = agents.filter((agent) => agent.workflow.startedAt !== null || agent.status === 'done' || agent.status === 'fail');
  const newest = started.reduce<string | null>((phase, agent) => {
    const at = agent.workflow.phase;
    if (at === null) return phase;
    if (phase === null) return at;
    return phases.indexOf(at) >= phases.indexOf(phase) ? at : phase;
  }, null);
  const startTimes = agents.map((agent) => agent.workflow.startedAt).filter((at): at is string => at !== null).sort();
  const endTimes = agents.map((agent) => agent.workflow.endedAt).filter((at): at is string => at !== null).sort();
  const run: WorkflowRun = {
    runId: input.runId,
    taskId: input.runFile?.taskId ?? input.launch?.taskId ?? null,
    name: input.runFile?.name ?? input.launch?.name ?? input.script?.name ?? input.runId,
    summary: input.runFile?.summary ?? input.launch?.summary ?? input.script?.summary ?? null,
    status,
    phase: newest ?? phases[0] ?? null,
    phases,
    agentCount: agents.length,
    doneCount: agents.filter((agent) => agent.status === 'done').length,
    failedCount: agents.filter((agent) => agent.status === 'fail').length,
    startedAt: input.runFile?.startedAt ?? input.launchedAt ?? startTimes[0] ?? null,
    endedAt: status === 'run' ? null : (input.runFile?.endedAt ?? endTimes.at(-1) ?? null),
  };
  return { run, agents };
}

/**
 * A run's agents as `Session.agents` entries (`kind: 'workflow'`): named by their
 * label, described by their phase; `solutionPath` from `solutionOf(cwd)` (the
 * server maps the transcript's cwd to a solution folder, `null` for the workspace
 * root or an unknown cwd).
 */
export function workflowAgents(views: readonly WorkflowAgentView[], solutionOf: (cwd: string) => string | null = () => null): Agent[] {
  return views.map((view) => ({
    id: view.id,
    kind: 'workflow',
    name: view.label,
    description: view.workflow.phase,
    solutionPath: view.workflow.cwd !== null ? solutionOf(view.workflow.cwd) : null,
    branch: null,
    status: view.status,
    statusText: view.statusText,
    toolUseId: null,
    workflow: view.workflow,
  }));
}

/** The progress line of a run: `3/7 agents done · phase Review` (without a phase: the counts only). */
export function workflowProgressText(run: Pick<WorkflowRun, 'doneCount' | 'agentCount' | 'phase'>): string {
  const counts = `${run.doneCount}/${run.agentCount} agents done`;
  return run.phase ? `${counts} · phase ${run.phase}` : counts;
}

// ── an agent's chat ──────────────────────────────────────────────────────

/** The frame the CLI puts around a workflow agent's brief (its first user line). */
const HARNESS_FRAME = '[Workflow harness';
const HARNESS_TEXT_FOLLOWS = /The computed task text follows:\n/;

/**
 * A workflow agent's brief without the CLI's frame: the frame's text is dropped and
 * the brief, which the CLI indents by two spaces, is dedented. Any other text is
 * kept as it is.
 */
export function cleanWorkflowBrief(text: string): string {
  if (!text.startsWith(HARNESS_FRAME)) return text;
  const match = HARNESS_TEXT_FOLLOWS.exec(text);
  if (!match) return text;
  const body = text.slice(match.index + match[0].length);
  return body
    .split('\n')
    .map((line) => (line.startsWith('  ') ? line.slice(2) : line))
    .join('\n')
    .trim();
}

/**
 * A workflow agent's conversation from its transcript entries (sidechain lines,
 * one chain), in the event shapes the stream produces (`docs/derivations.md` →
 * *Events*): its first prompt is the brief (an `agent-prompt`, without the CLI's
 * frame), later prompts too; assistant text blocks of one message merge; tool calls
 * are paired with their results. Ids count from 1 (local to this answer).
 */
export function workflowAgentEvents(entries: readonly Json[], sessionId: string, agentId: string): SessionEvent[] {
  // The agent's file is one sidechain: read it as a main chain.
  const chain = newestChain(entries.map((entry) => ({ ...entry, isSidechain: false })));
  const events: SessionEvent[] = [];
  const texts = new Map<string, number>();
  const tools = new Map<string, number>();
  let prompts = 0;
  const push = (event: Omit<SessionEvent, 'id' | 'sessionId' | 'agentId'>): number => {
    events.push({ id: events.length + 1, sessionId, agentId, ...event });
    return events.length - 1;
  };
  for (const item of transcriptItems(chain)) {
    const ts = item.ts ?? new Date(0).toISOString();
    switch (item.kind) {
      case 'prompt': {
        const text = prompts++ === 0 ? cleanWorkflowBrief(item.text) : item.text;
        const payload: AgentPromptPayload = { type: 'agent-prompt', text: clip(text).text };
        push({ ts, endTs: null, kind: 'text', label: textLabel(text), payload });
        break;
      }
      case 'text': {
        const key = item.messageId ?? item.uuid;
        const at = texts.get(key);
        const before = at !== undefined ? events[at] : undefined;
        if (at !== undefined && before) {
          const text = `${(before.payload as { text: string }).text}\n\n${item.text}`;
          events[at] = { ...before, label: textLabel(text), payload: { type: 'assistant', text: clip(text).text, messageId: item.messageId } };
        } else {
          texts.set(key, push({ ts, endTs: null, kind: 'text', label: textLabel(item.text), payload: { type: 'assistant', text: clip(item.text).text, messageId: item.messageId } }));
        }
        break;
      }
      case 'tool-use': {
        const { input, truncated } = clipInput(item.input);
        const payload: ToolPayload = { type: 'tool', name: item.name, toolUseId: item.toolUseId, input, ...(truncated ? { inputTruncated: true } : {}) };
        tools.set(item.toolUseId, push({ ts, endTs: null, kind: toolEventKind(item.name), label: toolLabel(item.name, item.input), payload }));
        break;
      }
      case 'tool-result': {
        const at = tools.get(item.toolUseId);
        const event = at !== undefined ? events[at] : undefined;
        if (at === undefined || !event) break;
        const cut = clip(item.text);
        events[at] = {
          ...event,
          endTs: item.ts ?? ts,
          payload: { ...(event.payload as ToolPayload), result: cut.text, ...(cut.truncated ? { resultTruncated: true } : {}), isError: item.isError },
        };
        break;
      }
    }
  }
  return events;
}
