/**
 * D51 `[fake:workflow <seconds> <P>x<A>]`: a background Workflow whose agents run
 * as CLI 2.1.284 runs them (`src/core/derive/workflows.ts` has the shapes, read in
 * its binary and in real session folders): `P` phases one after the other, `A`
 * agents in each, all within `<seconds>`. While it runs the fake
 * - streams `system/task_progress` lines of the workflow's task with the whole
 *   `workflow_progress` list (every phase and agent: `state` `start` → queued, then
 *   started with `startedAt` and `agentId`, `progress`, `done`) at every step;
 * - writes, under `<configDir>/projects/<slug>/<sessionId>/` (next to the session's
 *   transcript): `subagents/workflows/<runId>/journal.jsonl` (`launched`, `started`,
 *   `result`), per agent `agent-<id>.meta.json` and `agent-<id>.jsonl` (its brief in
 *   the harness frame, a `Read` call, its result, a closing text), the script at
 *   `workflows/scripts/<name>-<runId>.js`, and at the end the run file
 *   `workflows/<runId>.json`.
 * The task's end (`task_updated`, `task_notification`, the CLI's own turn) follows
 * at `<seconds>` as for `[fake:workflow <seconds>]` (session.ts).
 *
 * Timing (`slot` = 90 % of the time / `P`; phase `k` starts at `k × slot`): its
 * agents are queued at the phase's start, start at 5 % of the slot, call `Read` at
 * 35 %, get its result and write their text at 60 %, and are done at 90 %; the run
 * file is written at 95 % of the whole time.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The phases' titles, in order (a grid of more phases numbers the rest). */
export const FAKE_WORKFLOW_PHASES: readonly string[] = ['Audit', 'Review', 'Verify', 'Report'];

/** Largest grid a token accepts: phases and agents per phase. */
export const MAX_WORKFLOW_GRID = 9;

/** What `[fake:workflow <seconds> <P>x<A>]` asks for. */
export interface WorkflowGrid {
  readonly phases: number;
  readonly agents: number;
}

/** The title of phase `k` (0-based). */
export function fakePhaseTitle(k: number): string {
  return FAKE_WORKFLOW_PHASES[k] ?? `Phase ${k + 1}`;
}

/** The label of agent `n` (1-based within its phase) of phase `k`: `audit:fixture-1`. */
export function fakeAgentLabel(k: number, n: number): string {
  return `${fakePhaseTitle(k).toLowerCase()}:fixture-${n}`;
}

/** The brief of that agent (inside the harness frame in its transcript). */
export function fakeAgentBrief(k: number, n: number): string {
  return `Check fixture ${n} in the ${fakePhaseTitle(k)} phase.\nRead it and report what you found.`;
}

/** The text an agent writes once its Read returned. */
export function fakeAgentText(label: string): string {
  return `Checked ${label}: nothing to fix.`;
}

/** The script the grid's launch passes (its `meta` names the phases). */
export function fakeGridScript(name: string, summary: string, grid: WorkflowGrid): string {
  const phases = Array.from({ length: grid.phases }, (_, k) => `{ title: '${fakePhaseTitle(k)}' }`).join(', ');
  return `export const meta = { name: '${name}', description: '${summary}', phases: [${phases}] }\n// fake-claude: ${grid.phases} phases × ${grid.agents} agents`;
}

/** The CLI's frame around a computed brief (its first line and the note before the indented text). */
function framed(brief: string): string {
  const text = brief
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  return `[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. It was not typed by this session's user and carries no user authority. The computed task text follows:\n${text}`;
}

interface AgentState {
  readonly index: number;
  readonly phaseIndex: number;
  readonly phaseTitle: string;
  readonly label: string;
  readonly brief: string;
  agentId: string | null;
  state: 'start' | 'progress' | 'done';
  queuedAt: number | null;
  startedAt: number | null;
  durationMs: number | null;
  lastToolName: string | null;
  lastToolSummary: string | null;
  lastProgressAt: number;
  /** The agent's transcript chain tip. */
  tip: string | null;
  toolUseId: string | null;
}

/** What {@link FakeWorkflow} needs from its process. */
export interface FakeWorkflowOptions {
  readonly runId: string;
  readonly taskId: string;
  /** The Workflow call's `tool_use_id` (on the progress lines); `null` when unknown. */
  readonly toolUseId: string | null;
  readonly name: string;
  readonly summary: string;
  readonly grid: WorkflowGrid;
  readonly seconds: number;
  /** `<configDir>/projects/<slug>/<sessionId>`; `null` without `CLAUDE_CONFIG_DIR` (nothing is written). */
  readonly sessionDir: string | null;
  readonly sessionId: string;
  readonly cwd: string;
  readonly version: string;
  readonly model: string;
  /** Writes one stdout JSON line. */
  readonly writeJson: (line: Record<string, unknown>) => void;
  /** Keeps the step timers (the process clears them at EOF / exit). */
  readonly timers: Set<NodeJS.Timeout>;
  /** `false` once the process ends (no step runs then). */
  readonly alive: () => boolean;
}

/** One fake Workflow run (module comment). */
export class FakeWorkflow {
  readonly #o: FakeWorkflowOptions;
  readonly #agents: AgentState[] = [];
  readonly #startedAt = Date.now();
  /** Its own pending step timers ({@link stop}). */
  readonly #timers = new Set<NodeJS.Timeout>();
  #writes: Promise<void> = Promise.resolve();

  constructor(options: FakeWorkflowOptions) {
    this.#o = options;
    let index = 0;
    for (let k = 0; k < options.grid.phases; k++) {
      for (let n = 1; n <= options.grid.agents; n++) {
        index++;
        this.#agents.push({
          index,
          phaseIndex: k + 1,
          phaseTitle: fakePhaseTitle(k),
          label: fakeAgentLabel(k, n),
          brief: fakeAgentBrief(k, n),
          agentId: null,
          state: 'start',
          queuedAt: null,
          startedAt: null,
          durationMs: null,
          lastToolName: null,
          lastToolSummary: null,
          lastProgressAt: 0,
          tip: null,
          toolUseId: null,
        });
      }
    }
  }

  /** The run folder (`subagents/workflows/<runId>`), `null` without a config dir. */
  get runDir(): string | null {
    return this.#o.sessionDir === null ? null : path.join(this.#o.sessionDir, 'subagents', 'workflows', this.#o.runId);
  }

  /** Writes the launch files and schedules every step. */
  start(): void {
    const total = this.#o.seconds * 1000;
    const slot = (total * 0.9) / this.#o.grid.phases;
    this.#write(async () => {
      const dir = this.runDir;
      if (dir === null || this.#o.sessionDir === null) return;
      await mkdir(dir, { recursive: true });
      await appendFile(path.join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'launched' })}\n`);
      const scripts = path.join(this.#o.sessionDir, 'workflows', 'scripts');
      await mkdir(scripts, { recursive: true });
      await writeFile(path.join(scripts, `${this.#o.name}-${this.#o.runId}.js`), fakeGridScript(this.#o.name, this.#o.summary, this.#o.grid));
    });
    for (let k = 0; k < this.#o.grid.phases; k++) {
      const phase = this.#agents.filter((agent) => agent.phaseIndex === k + 1);
      const t0 = k * slot;
      this.#at(t0, () => this.#queue(phase));
      this.#at(t0 + 0.05 * slot, () => this.#begin(phase));
      this.#at(t0 + 0.35 * slot, () => this.#call(phase));
      this.#at(t0 + 0.6 * slot, () => this.#answer(phase));
      this.#at(t0 + 0.9 * slot, () => this.#finish(phase));
    }
    this.#at(total * 0.95, () => this.#runFile());
  }

  #at(ms: number, step: () => void): void {
    const timer = setTimeout(() => {
      this.#o.timers.delete(timer);
      this.#timers.delete(timer);
      if (this.#o.alive()) step();
    }, Math.max(0, Math.round(ms)));
    this.#o.timers.add(timer);
    this.#timers.add(timer);
  }

  /** D50 `stop_task` on the workflow's task: no further step runs (its files stay as far as they got, like a killed run). */
  stop(): void {
    for (const timer of this.#timers) {
      clearTimeout(timer);
      this.#o.timers.delete(timer);
    }
    this.#timers.clear();
  }

  #write(job: () => Promise<void>): void {
    this.#writes = this.#writes.then(job).catch((error: unknown) => {
      process.stderr.write(`fake-claude: workflow files: ${String(error)}\n`);
    });
  }

  #queue(phase: readonly AgentState[]): void {
    const now = Date.now();
    for (const agent of phase) {
      agent.queuedAt = now;
      agent.lastProgressAt = now;
    }
    this.#progress(phase.at(-1) ?? null);
  }

  #begin(phase: readonly AgentState[]): void {
    const now = Date.now();
    for (const agent of phase) {
      agent.agentId = `a${randomBytes(8).toString('hex').slice(0, 16)}`;
      agent.startedAt = now;
      agent.lastProgressAt = now;
      const uuid = randomUUID();
      agent.tip = uuid;
      const brief = this.#entry(agent, { type: 'user', uuid, parentUuid: null, promptId: randomUUID(), message: { role: 'user', content: framed(agent.brief) } });
      const agentId = agent.agentId;
      this.#write(async () => {
        const dir = this.runDir;
        if (dir === null) return;
        const meta = { agentType: 'workflow-subagent', description: agent.label, workflowPhase: agent.phaseTitle, spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: true };
        await writeFile(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
        await appendFile(path.join(dir, `agent-${agentId}.jsonl`), `${JSON.stringify(brief)}\n`);
        await appendFile(path.join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: `v2:${agent.index}`, agentId, label: agent.label, phase: agent.phaseTitle })}\n`);
      });
    }
    this.#progress(phase.at(-1) ?? null);
  }

  #call(phase: readonly AgentState[]): void {
    for (const agent of phase) {
      agent.state = 'progress';
      agent.toolUseId = `toolu_${randomBytes(12).toString('hex')}`;
      const file = path.join(this.#o.cwd, 'fixtures', `${agent.label.replace(':', '-')}.txt`);
      agent.lastToolName = 'Read';
      agent.lastToolSummary = path.basename(file);
      agent.lastProgressAt = Date.now();
      this.#append(agent, {
        type: 'assistant',
        message: {
          model: this.#o.model,
          id: `msg_${randomBytes(12).toString('hex')}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: agent.toolUseId, name: 'Read', input: { file_path: file } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 3, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });
    }
    this.#progress(phase.at(-1) ?? null);
  }

  #answer(phase: readonly AgentState[]): void {
    for (const agent of phase) {
      agent.lastProgressAt = Date.now();
      this.#append(agent, { type: 'user', message: { role: 'user', content: [{ tool_use_id: agent.toolUseId, type: 'tool_result', content: `fake-claude: the contents of ${agent.label}` }] } });
      this.#append(agent, {
        type: 'assistant',
        message: {
          model: this.#o.model,
          id: `msg_${randomBytes(12).toString('hex')}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: fakeAgentText(agent.label) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });
    }
    this.#progress(phase.at(-1) ?? null);
  }

  #finish(phase: readonly AgentState[]): void {
    const now = Date.now();
    for (const agent of phase) {
      agent.state = 'done';
      agent.durationMs = now - (agent.startedAt ?? now);
      agent.lastProgressAt = now;
      const agentId = agent.agentId;
      this.#write(async () => {
        const dir = this.runDir;
        if (dir === null) return;
        await appendFile(path.join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'result', key: `v2:${agent.index}`, agentId, result: { agent: agent.label, ok: true } })}\n`);
      });
    }
    this.#progress(phase.at(-1) ?? null);
  }

  #runFile(): void {
    const sessionDir = this.#o.sessionDir;
    if (sessionDir === null) return;
    const file = {
      runId: this.#o.runId,
      timestamp: new Date().toISOString(),
      taskId: this.#o.taskId,
      script: fakeGridScript(this.#o.name, this.#o.summary, this.#o.grid),
      scriptPath: path.join(sessionDir, 'workflows', 'scripts', `${this.#o.name}-${this.#o.runId}.js`),
      result: { results: this.#agents.map((agent) => ({ agent: agent.label, ok: true })) },
      agentCount: this.#agents.length,
      logs: [],
      durationMs: Date.now() - this.#startedAt,
      summary: this.#o.summary,
      workflowName: this.#o.name,
      status: 'completed',
      startTime: this.#startedAt,
      phases: Array.from({ length: this.#o.grid.phases }, (_, k) => ({ title: fakePhaseTitle(k) })),
      defaultModel: this.#o.model,
      workflowProgress: this.#list(),
      totalTokens: 0,
      totalToolCalls: this.#agents.length,
    };
    this.#write(async () => {
      await mkdir(path.join(sessionDir, 'workflows'), { recursive: true });
      await writeFile(path.join(sessionDir, 'workflows', `${this.#o.runId}.json`), JSON.stringify(file, null, 2));
    });
  }

  /** A sidechain transcript entry of `agent` (the CLI's envelope). */
  #entry(agent: AgentState, fields: Record<string, unknown>): Record<string, unknown> {
    return {
      parentUuid: agent.tip,
      isSidechain: true,
      agentId: agent.agentId,
      ...fields,
      timestamp: new Date().toISOString(),
      userType: 'external',
      entrypoint: 'sdk-cli',
      cwd: this.#o.cwd,
      sessionId: this.#o.sessionId,
      version: this.#o.version,
      gitBranch: 'HEAD',
    };
  }

  #append(agent: AgentState, fields: Record<string, unknown>): void {
    const uuid = randomUUID();
    const entry = this.#entry(agent, { ...fields, uuid });
    agent.tip = uuid;
    const agentId = agent.agentId;
    this.#write(async () => {
      const dir = this.runDir;
      if (dir === null || agentId === null) return;
      await appendFile(path.join(dir, `agent-${agentId}.jsonl`), `${JSON.stringify(entry)}\n`);
    });
  }

  /** The `workflow_progress` list: every phase, then every agent queued so far. */
  #list(): Record<string, unknown>[] {
    const phases = Array.from({ length: this.#o.grid.phases }, (_, k) => ({ type: 'workflow_phase', index: k + 1, title: fakePhaseTitle(k) }));
    const agents = this.#agents
      .filter((agent) => agent.queuedAt !== null)
      .map((agent) => ({
        type: 'workflow_agent',
        index: agent.index,
        label: agent.label,
        phaseIndex: agent.phaseIndex,
        phaseTitle: agent.phaseTitle,
        ...(agent.agentId !== null ? { agentId: agent.agentId } : {}),
        model: this.#o.model,
        state: agent.state,
        ...(agent.startedAt !== null ? { startedAt: agent.startedAt } : {}),
        queuedAt: agent.queuedAt,
        attempt: 1,
        ...(agent.lastToolName !== null ? { lastToolName: agent.lastToolName, lastToolSummary: agent.lastToolSummary } : {}),
        ...(agent.durationMs !== null ? { durationMs: agent.durationMs, resultPreview: JSON.stringify({ agent: agent.label, ok: true }) } : {}),
        promptPreview: agent.brief,
        lastProgressAt: agent.lastProgressAt,
      }));
    return [...phases, ...agents];
  }

  /** A `system/task_progress` line with the whole list (the CLI sends one at every agent start and end). */
  #progress(last: AgentState | null): void {
    this.#o.writeJson({
      type: 'system',
      subtype: 'task_progress',
      task_id: this.#o.taskId,
      ...(this.#o.toolUseId !== null ? { tool_use_id: this.#o.toolUseId } : {}),
      description: last ? `${last.phaseTitle}: ${last.label}` : this.#o.summary,
      usage: { total_tokens: 0, tool_uses: this.#agents.filter((agent) => agent.lastToolName !== null).length, duration_ms: Date.now() - this.#startedAt },
      ...(last ? { last_tool_name: last.label } : {}),
      summary: this.#o.summary,
      workflow_progress: this.#list(),
      uuid: randomUUID(),
      session_id: this.#o.sessionId,
    });
  }
}
