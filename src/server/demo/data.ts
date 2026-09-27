import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactType, ScheduleRunResult, SessionStatus } from '../../core/model.ts';

/**
 * The demo seed's data files (`src/server/demo/data/*.json`, gap #21, D13): the
 * prototype's mock data (`docs/handoff/prototype/Switchboard App.dc.html`,
 * arrays S, INQ, SYS, SG, LED, ARTS, SCH, loops, ART, HIST, the tools, the wizard
 * and scan rows, the footer metrics) with positional arrays turned into named
 * fields. Strings are verbatim; `tests/server/demo/data.test.ts` checks every
 * one against the prototype source. Lanes extend these files when their view
 * needs more demo data (`docs/lanes.md`). Nothing outside `src/server/demo/`
 * reads them, and only when `SWITCHBOARD_DEMO=1`.
 */

/** Folder of the data files. */
export const DEMO_DATA_DIR = path.join(import.meta.dirname, 'data');

/** A session chip (`k v`); loop/workflow chips are blue. */
export interface DemoChip {
  readonly k: string;
  readonly v: string;
  readonly loop?: boolean;
}

/** An agent row of a session. `branch` is empty when the agent works without one. */
export interface DemoAgent {
  readonly name: string;
  readonly description: string;
  readonly solutionPath: string;
  readonly branch: string;
  readonly statusText: string;
  readonly status: SessionStatus;
}

/** A chat message; agent messages may carry mono tool lines. */
export interface DemoMessage {
  readonly from: 'user' | 'agent';
  readonly text: string;
  readonly tools?: readonly string[];
}

/** An open question of a session, verbatim. */
export interface DemoQuestion {
  readonly source: string;
  readonly text: string;
  readonly options: readonly string[];
}

/** A changed file of a session (Diff tab). `branch` is `—` for workspace-root files. */
export interface DemoFile {
  readonly solution: string;
  readonly path: string;
  readonly branch: string;
  /** `+118` or `+51 −12` (U+2212 minus). */
  readonly delta: string;
  readonly lines: readonly string[];
}

/** A per-session artifact row (Artifacts tab). */
export interface DemoSessionArtifact {
  readonly type: ArtifactType;
  readonly name: string;
  readonly meta: string;
}

/** A timeline block, in minutes from the session's `t0`. */
export interface DemoBlock {
  readonly start: number;
  readonly end: number;
  readonly kind: 'plan' | 'impl' | 'loop' | 'ask' | 'ok';
  readonly label: string;
}

/** A timeline lane. */
export interface DemoLane {
  readonly agent: string;
  readonly solution: string;
  readonly blocks: readonly DemoBlock[];
}

/** One prototype session (array S). */
export interface DemoSession {
  readonly name: string;
  readonly status: SessionStatus;
  /** Age of the last activity: `now`, `1m`, `3h`, `2d`. */
  readonly age: string;
  /** The sidebar's second line as the prototype shows it. */
  readonly modeLine: string;
  /** The id shown in `claude --resume <id>`. */
  readonly resumeId: string;
  /** Minutes after 10:00 at which the timeline starts. */
  readonly t0: number;
  /** Timeline length in minutes. */
  readonly duration: number;
  readonly chips: readonly DemoChip[];
  readonly agents: readonly DemoAgent[];
  readonly messages: readonly DemoMessage[];
  readonly questions: readonly DemoQuestion[];
  readonly terminal: readonly string[];
  readonly files: readonly DemoFile[];
  readonly artifacts: readonly DemoSessionArtifact[];
  readonly timeline: readonly DemoLane[];
}

/** An Inbox system item (array SYS). */
export interface DemoSystemItem {
  readonly id: string;
  readonly source: string;
  /** Kind label ("Scheduled run failed", "PR merged"). */
  readonly label: string;
  readonly status: SessionStatus;
  readonly age: string;
  readonly title: string;
  readonly detail: string;
  readonly branches: ReadonlyArray<{ readonly solution: string; readonly branch: string }>;
  readonly actions: readonly string[];
  /** The failed schedule (its latest run). */
  readonly schedule?: string;
  /** The removable worktree. */
  readonly worktree?: { readonly repo: string; readonly branch: string; readonly path: string; readonly prNumber: number };
}

/** `inbox.json`: the simulated incoming question (INQ + its toast) and the system items. */
export interface DemoInbox {
  readonly incoming: {
    readonly session: string;
    readonly question: DemoQuestion;
    readonly toast: { readonly sid: string; readonly title: string; readonly sub: string; readonly branch: string; readonly text: string };
    readonly notification: { readonly title: string; readonly body: string };
  };
  readonly system: readonly DemoSystemItem[];
}

/** A branch of a solution row (array SG). `worktree` is a folder name next to the repo, or `null` (in place). */
export interface DemoSolutionBranch {
  readonly branch: string;
  readonly owner: string;
  readonly status: SessionStatus;
  readonly worktree: string | null;
}

/** A solution row (array SG). */
export interface DemoSolution {
  readonly name: string;
  readonly type: string;
  readonly status: SessionStatus;
  readonly readOnly: boolean;
  readonly phase: string;
  readonly changes: string;
  readonly flag: string;
  /** `warn` = conflict (need color), `muted` = informational. */
  readonly flagKind: 'warn' | 'muted' | null;
  readonly branches: readonly DemoSolutionBranch[];
}

/** `solutions.json` (SG, LED, ARTS, the dirty list, the New-session groups and draft). */
export interface DemoSolutions {
  readonly groups: ReadonlyArray<{ readonly folder: string; readonly note: string; readonly solutions: readonly DemoSolution[] }>;
  /** The branch as it looks after "Move … to worktree". */
  readonly conflictFixedBranch: { readonly solution: string; readonly branch: string; readonly worktree: string };
  readonly phaseLedgers: Readonly<
    Record<string, ReadonlyArray<{ readonly interface: string; readonly phase: string; readonly status: SessionStatus; readonly seam: string }>>
  >;
  readonly artifacts: Readonly<Record<string, ReadonlyArray<{ readonly type: string; readonly name: string; readonly meta: string }>>>;
  readonly codebaseMemoryDirty: ReadonlyArray<{ readonly project: string; readonly ts: string }>;
  readonly newSessionGroups: ReadonlyArray<{ readonly folder: string; readonly solutions: readonly string[] }>;
  readonly newSessionDraft: Readonly<Record<string, unknown>>;
}

/** A schedule (array SCH); `runs` oldest first. */
export interface DemoSchedule {
  readonly name: string;
  readonly description: string;
  readonly cron: string;
  readonly cronLabel: string;
  readonly runs: readonly ScheduleRunResult[];
  readonly last: string;
  readonly next: string;
  readonly status: SessionStatus;
}

/** A loop card (loops). */
export interface DemoLoop {
  readonly session: string;
  readonly kind: string;
  readonly loopKind: string;
  readonly iterations: readonly ScheduleRunResult[];
  readonly facts: ReadonlyArray<{ readonly k: string; readonly v: string }>;
  readonly note: string;
  readonly iteration: number | null;
  readonly cap: number | null;
  readonly breakerCount: number | null;
  readonly breakerState: string | null;
  readonly nextFireInMinutes: number | null;
  readonly expiresInDays: number | null;
}

/** A global artifact row (ART). `solution` is `root` for workspace-root files. */
export interface DemoArtifact {
  readonly type: ArtifactType;
  readonly name: string;
  readonly solution: string;
  readonly branch?: string;
  readonly session: string;
  readonly meta: string;
  readonly age: string;
}

/** A History row (HIST). `branches` is `sol ⎇ branch · sol ⎇ branch` or `various`. */
export interface DemoHistoryRow {
  readonly date: string;
  readonly name: string;
  readonly mode: string;
  readonly summary: string;
  readonly branches: string;
  readonly outcome: string;
  readonly status: SessionStatus;
}

/** An embedded tool (TOOLS + the default URLs). */
export interface DemoTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly url: string | null;
}

/** `setup.json`: wizard checks + scan rows. */
export interface DemoSetup {
  readonly wizardChecks: ReadonlyArray<{ readonly label: string; readonly detail: string }>;
  readonly scan: ReadonlyArray<{ readonly folder: string; readonly count: number; readonly examples: string; readonly rule: string }>;
}

/**
 * `system.json`: the sidebar footer as the prototype shows it + CLI / gh status.
 * `processes` is the prototype's `sessions + 3` (its footer reads "9 bg processes").
 */
export interface DemoSystem {
  readonly footer: { readonly service: string; readonly processes: number; readonly cpu: string; readonly ram: string; readonly max: string };
  readonly cli: string;
  readonly signedIn: boolean;
  readonly ghSignedIn: boolean;
}

/** Every demo data file. */
export interface DemoData {
  readonly sessions: readonly DemoSession[];
  readonly inbox: DemoInbox;
  readonly solutions: DemoSolutions;
  readonly schedules: readonly DemoSchedule[];
  readonly loops: readonly DemoLoop[];
  readonly artifacts: readonly DemoArtifact[];
  readonly history: readonly DemoHistoryRow[];
  readonly tools: readonly DemoTool[];
  readonly setup: DemoSetup;
  readonly system: DemoSystem;
}

/** The data file names, relative to {@link DEMO_DATA_DIR}. */
export const DEMO_DATA_FILES = [
  'sessions.json',
  'inbox.json',
  'solutions.json',
  'schedules.json',
  'loops.json',
  'artifacts.json',
  'history.json',
  'tools.json',
  'setup.json',
  'system.json',
] as const;

async function readJson(dir: string, file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(dir, file), 'utf8')) as unknown;
}

/** Reads the data files (startup only; demo mode). */
export async function loadDemoData(dir: string = DEMO_DATA_DIR): Promise<DemoData> {
  const [sessions, inbox, solutions, schedules, loops, artifacts, history, tools, setup, system] = await Promise.all(
    DEMO_DATA_FILES.map((file) => readJson(dir, file)),
  );
  return {
    sessions: (sessions as { sessions: DemoSession[] }).sessions,
    inbox: inbox as DemoInbox,
    solutions: solutions as DemoSolutions,
    schedules: (schedules as { schedules: DemoSchedule[] }).schedules,
    loops: (loops as { loops: DemoLoop[] }).loops,
    artifacts: (artifacts as { artifacts: DemoArtifact[] }).artifacts,
    history: (history as { history: DemoHistoryRow[] }).history,
    tools: (tools as { tools: DemoTool[] }).tools,
    setup: setup as DemoSetup,
    system: system as DemoSystem,
  };
}

/** Minutes behind "now" of a prototype age (`now`, `38m`, `3h`, `6d`). */
export function ageMinutes(age: string): number {
  if (age === 'now') return 0;
  const match = /^(\d+)(m|h|d)$/.exec(age);
  if (!match) throw new Error(`demo seed: unreadable age "${age}"`);
  const value = Number(match[1]);
  return match[2] === 'm' ? value : match[2] === 'h' ? value * 60 : value * 1440;
}
