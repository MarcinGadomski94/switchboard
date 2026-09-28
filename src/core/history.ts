/**
 * History rows (M7.4, SPEC → History, `docs/spike-m0.md` → *What History needs*
 * and *Terminal-started sessions*), shared by the server's `GET /api/history?q=`
 * and the UI: which sessions are listed, their name, mode line, summary,
 * solutions / branches, outcome, and the search match. Pure: the server passes in
 * the stored sessions and the parsed transcript facts (`transcript.ts`).
 * `docs/derivations.md` → *History*.
 */
import type { BranchRef, HistoryItem } from './api.ts';
import type { FolderKind, Phase, SessionMode, SessionOrigin, SessionStatus, WorkType } from './model.ts';
import type { TranscriptFacts } from './transcript.ts';

/** The mode line of a session moved in from a terminal (D16; developer ruling 2026-09-28). */
export const MOVED_MODE_LINE = 'terminal · moved';

/** A transcript that changed less than this long ago belongs to an active session (gap #5's 2 minutes). */
export const ACTIVE_WINDOW_MS = 2 * 60_000;

/** Longest name taken from a prompt or a command (characters, then `…`). */
export const NAME_MAX = 60;

/** Longest summary shown (characters, then `…`); search still sees the whole stored text. */
export const SUMMARY_MAX = 240;

/** Outcome words for a session's status (SPEC tokens: needs you / running / done / failed / idle / paused). */
export const STATUS_OUTCOME: Readonly<Record<SessionStatus, string>> = {
  need: 'needs you',
  run: 'running',
  done: 'done',
  fail: 'failed',
  idle: 'idle',
  paused: 'paused',
};

/** Workspace group folders whose children are the solutions (router layout). */
const GROUP_FOLDERS = new Set(['microfrontends', 'nugets', 'microservices', 'functions', 'other']);

/** One worktree of a stored session (M2.2): its solution, branch and PR state. */
export interface HistoryWorktree {
  readonly repo: string;
  readonly branch: string;
  readonly prNumber: number | null;
  /** Verbatim from gh (`OPEN`, `MERGED`, …). */
  readonly prState: string | null;
}

/** What History reads from a stored (Switchboard-started) session. */
export interface HistorySession {
  readonly id: string;
  readonly name: string;
  /** D22: the session's title (`null` / absent = none); the row shows it, and the search matches it. */
  readonly title?: string | null;
  readonly claudeSessionId: string;
  readonly status: SessionStatus;
  readonly task: string;
  readonly workType: WorkType | null;
  readonly mode: SessionMode | null;
  readonly phase: Phase | null;
  readonly solutions: readonly string[];
  readonly createdAt: string;
  /** Oldest first, removed ones included (the branch is kept, gap #3). */
  readonly worktrees: readonly HistoryWorktree[];
  /** D14: the saved folder the session started in (`null` once removed from the list). */
  readonly folder: string | null;
  /** D14: the session's folder path (its root). */
  readonly folderPath: string | null;
  /** D16: `terminal` when the session was moved in from a terminal (optional: `switchboard` when absent). */
  readonly origin?: SessionOrigin;
}

/**
 * A folder History reads terminal sessions under (D14): every saved folder and
 * every session's folder, each in the form(s) a transcript's `cwd` may use.
 */
export interface HistoryRoot {
  /** An absolute folder path (as saved, or as resolved on disk: either may match a transcript's `cwd`). */
  readonly path: string;
  readonly kind: FolderKind;
  /** The saved folder's id; `null` for a session's folder that is not saved. */
  readonly folder: string | null;
  /** The folder path rows name ({@link HistoryItem.folderPath}). */
  readonly folderPath: string;
  /** A repo folder's one solution (its name); `null` for a workspace. */
  readonly repoName: string | null;
}

/** A parsed transcript file and its modification time. */
export interface HistoryTranscript {
  readonly facts: TranscriptFacts;
  readonly mtimeMs: number;
}

/** Input of {@link buildHistoryRows}. */
export interface HistoryInput {
  readonly sessions: readonly HistorySession[];
  readonly transcripts: readonly HistoryTranscript[];
  /**
   * The folders terminal sessions may have started in (D14: saved folders and
   * sessions' folders); empty = no terminal rows.
   */
  readonly roots: readonly HistoryRoot[];
  /** Case-insensitive path comparison (macOS, Windows). */
  readonly caseInsensitive: boolean;
  readonly now: number;
}

/** A row plus the text the search looks in. */
export interface HistoryRow {
  readonly item: HistoryItem;
  /** Lower-cased search text: what the row shows plus task, prompts, last text, folders, ids. */
  readonly search: string;
}

/** Collapses whitespace and cuts at `max` characters with `…`. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The sidebar's mode line (`src/web/shell/format.ts` `modeLine`, the prototype's
 * new-session wording): `orch|single · QA|feature · UI-first|integration`.
 */
export function sessionModeLine(session: Pick<HistorySession, 'mode' | 'workType' | 'phase'> & { readonly origin?: HistorySession['origin'] }): string {
  // D16: a session moved in from a terminal has no session-start answers (developer ruling 2026-09-28).
  if (session.origin === 'terminal') return MOVED_MODE_LINE;
  const parts: string[] = [];
  if (session.mode) parts.push(session.mode === 'orchestrator' ? 'orch' : 'single');
  if (session.workType) parts.push(session.workType === 'qa' ? 'QA' : 'feature');
  if (session.phase) parts.push(session.phase === 'ui-first' ? 'UI-first' : 'integration');
  return parts.join(' · ');
}

/** `/loop 1h Watch the build` → `/loop 1h` (the command and its first argument). */
export function commandHead(command: string): string {
  return command.split(' ').slice(0, 2).join(' ');
}

function trimSeparators(root: string): string {
  return root.length > 1 ? root.replace(/[\\/]+$/, '') : root;
}

/** The part of `cwd` below `root` (`''` for the root itself), or `null` when `cwd` is not the root or under it. */
export function relativeToRoot(cwd: string, root: string, caseInsensitive: boolean): string | null {
  const base = trimSeparators(root);
  const a = caseInsensitive ? cwd.toLowerCase() : cwd;
  const b = caseInsensitive ? base.toLowerCase() : base;
  if (a === b) return '';
  if (!a.startsWith(b)) return null;
  const next = cwd[base.length];
  if (next !== '/' && next !== '\\') return null;
  return cwd.slice(base.length + 1);
}

/**
 * The solution a workspace-relative folder belongs to, by the router layout:
 * `microfrontends/<repo>/…`, `nugets/…`, `microservices/…`, `functions/…`,
 * `other/<repo>/…` → `<repo>`; `deprecated/<type>/<repo>/…` → `<repo>`
 * (`deprecated/mobile/…` → `mobile`); any other top folder (`mobile`,
 * `infrastructure`, …) → itself; the root → `null`.
 */
export function solutionOfPath(relative: string): string | null {
  const [first, second, third] = relative.split(/[\\/]+/).filter(Boolean);
  if (!first) return null;
  if (first === 'deprecated') return second === 'mobile' ? 'mobile' : (third ?? second ?? first);
  if (GROUP_FOLDERS.has(first)) return second ?? first;
  return first;
}

/** `sol ⎇ branch · sol ⎇ branch · sol` (the prototype's `sols` line): branches first, then solutions without one. */
export function historyBranchLine(item: Pick<HistoryItem, 'branches' | 'solutions'>): string {
  return [...item.branches.map((ref) => `${ref.solution} ⎇ ${ref.branch}`), ...(item.solutions ?? [])].join(' · ');
}

/** `09-26 16:40` (month-day hour:minute, local time), the prototype's date column. */
export function formatHistoryDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function uniqueRefs(refs: readonly BranchRef[]): BranchRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.solution}\n${ref.branch}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withoutBranch(solutions: readonly string[], branches: readonly BranchRef[]): string[] {
  const covered = new Set(branches.map((ref) => ref.solution));
  return [...new Set(solutions)].filter((solution) => !covered.has(solution));
}

/** A stored session's outcome: its worktree PR (`PR #231 merged`, `+n` for more), else a transcript PR link, else its status. */
function sessionOutcome(session: HistorySession, facts: TranscriptFacts | null): string {
  const prs = session.worktrees.filter((wt) => wt.prNumber !== null);
  const first = prs[0];
  if (first) {
    const state = first.prState ? ` ${first.prState.toLowerCase()}` : '';
    return `PR #${first.prNumber}${state}${prs.length > 1 ? ` +${prs.length - 1}` : ''}`;
  }
  if (facts?.prNumber != null) return `PR #${facts.prNumber}`;
  return STATUS_OUTCOME[session.status];
}

function searchText(parts: ReadonlyArray<string | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join('\n')
    .toLowerCase();
}

/** Transcripts by session id; a duplicate id keeps the most recently modified file. */
function latestById(transcripts: readonly HistoryTranscript[]): Map<string, HistoryTranscript> {
  const byId = new Map<string, HistoryTranscript>();
  for (const transcript of transcripts) {
    const known = byId.get(transcript.facts.sessionId);
    if (!known || transcript.mtimeMs > known.mtimeMs) byId.set(transcript.facts.sessionId, transcript);
  }
  return byId;
}

function sessionRow(session: HistorySession, transcript: HistoryTranscript | undefined): HistoryRow {
  const facts = transcript?.facts ?? null;
  const branches = uniqueRefs(session.worktrees.map((wt) => ({ solution: wt.repo, branch: wt.branch })));
  const solutions = withoutBranch(session.solutions, branches);
  const fullSummary = facts?.lastText ?? session.task;
  const item: HistoryItem = {
    claudeSessionId: session.claudeSessionId,
    sessionId: session.id,
    startedAt: session.createdAt,
    name: session.name,
    displayTitle: session.title ?? session.name,
    mode: sessionModeLine(session),
    summary: clip(fullSummary, SUMMARY_MAX),
    branches,
    solutions,
    outcome: sessionOutcome(session, facts),
    status: session.status,
    folder: session.folder,
    folderPath: session.folderPath,
  };
  return {
    item,
    search: searchText([
      item.name,
      session.title,
      item.mode,
      fullSummary,
      historyBranchLine(item),
      item.outcome,
      session.task,
      facts?.prompts,
      facts?.lastPrompt,
      facts?.customTitle,
      facts?.aiTitle,
      ...(facts?.cwds ?? []),
      session.claudeSessionId,
    ]),
  };
}

/** Where a `cwd` is: the most specific root that contains it (a repo inside a saved workspace wins), and the part below it. */
interface Located {
  readonly root: HistoryRoot;
  readonly relative: string;
}

function locate(cwd: string, input: HistoryInput): Located | null {
  let best: Located | null = null;
  for (const root of input.roots) {
    const relative = relativeToRoot(cwd, root.path, input.caseInsensitive);
    if (relative === null) continue;
    if (!best || trimSeparators(root.path).length > trimSeparators(best.root.path).length) best = { root, relative };
  }
  return best;
}

/** The solution a located `cwd` belongs to: a repo folder's one solution, else the router layout's (`solutionOfPath`). */
function solutionAt(where: Located): string | null {
  return where.root.kind === 'repo' ? where.root.repoName : solutionOfPath(where.relative);
}

/**
 * A transcript of a conversation typed in an interactive terminal (gap #5): it
 * knows where it started, its first prompt (else its first command) has
 * `entrypoint: "cli"`, and it has a prompt or a command (not a stub). D16 moves
 * only these into Switchboard.
 */
export function isTerminalConversation(facts: Pick<TranscriptFacts, 'startCwd' | 'entrypoint' | 'firstPrompt' | 'firstCommand'>): boolean {
  return facts.startCwd !== null && facts.entrypoint === 'cli' && (facts.firstPrompt !== null || facts.firstCommand !== null);
}

/**
 * A terminal-started session (gap #5): not in the database, started in one of
 * the folders (D14) or below it, its first prompt (or command) typed in an
 * interactive terminal (`entrypoint: "cli"`), and not a stub. Else `null`. The
 * row belongs to the most specific folder its start `cwd` is in. D16: it is
 * marked `terminal` (it can continue in Switchboard) and carries its first prompt
 * and its start `cwd`.
 */
function terminalRow(transcript: HistoryTranscript, input: HistoryInput): HistoryRow | null {
  const { facts, mtimeMs } = transcript;
  if (!isTerminalConversation(facts) || facts.startCwd === null) return null;
  const start = locate(facts.startCwd, input);
  if (start === null) return null;

  const branches: BranchRef[] = [];
  if (facts.gitBranch && facts.gitBranch !== 'HEAD') {
    branches.push({ solution: solutionAt(start) ?? 'root', branch: facts.gitBranch });
  }
  const cwdSolutions = facts.cwds
    .map((cwd) => locate(cwd, input))
    .map((where) => (where === null ? null : solutionAt(where)))
    .filter((solution): solution is string => solution !== null);
  const active = input.now - mtimeMs < ACTIVE_WINDOW_MS;
  const name =
    facts.customTitle ?? facts.aiTitle ?? (facts.firstPrompt !== null ? clip(facts.firstPrompt, NAME_MAX) : clip(facts.firstCommand ?? '', NAME_MAX));
  const fullSummary = facts.lastText ?? facts.lastPrompt ?? facts.firstPrompt ?? '';
  const item: HistoryItem = {
    claudeSessionId: facts.sessionId,
    sessionId: null,
    startedAt: facts.startedAt ?? new Date(mtimeMs).toISOString(),
    name,
    mode: facts.startedWithCommand && facts.firstCommand ? `terminal · ${commandHead(facts.firstCommand)}` : 'terminal',
    summary: clip(fullSummary, SUMMARY_MAX),
    branches,
    solutions: withoutBranch(cwdSolutions, branches),
    outcome: facts.prNumber !== null ? `PR #${facts.prNumber}` : active ? 'active' : 'ended',
    status: active ? 'run' : 'idle',
    folder: start.root.folder,
    folderPath: start.root.folderPath,
    // D16: it can continue in Switchboard as the same conversation.
    terminal: true,
    firstPrompt: clip(facts.firstPrompt ?? facts.firstCommand ?? '', SUMMARY_MAX) || null,
    cwd: facts.startCwd,
  };
  return {
    item,
    search: searchText([
      item.name,
      item.mode,
      fullSummary,
      historyBranchLine(item),
      item.outcome,
      facts.firstCommand,
      facts.prompts,
      facts.lastPrompt,
      ...facts.cwds,
      facts.sessionId,
    ]),
  };
}

/**
 * Every History row, newest first (by start time): each stored session (with its
 * transcript's summary when one is found, whatever its entrypoints) plus the
 * terminal-started sessions from the transcripts. Transcripts outside every folder,
 * stubs (no prompt and no command) and headless (`sdk-cli`) files that are not in
 * the database are left out.
 */
export function buildHistoryRows(input: HistoryInput): HistoryRow[] {
  const transcripts = latestById(input.transcripts);
  const stored = new Set(input.sessions.map((session) => session.claudeSessionId));
  const rows = input.sessions.map((session) => sessionRow(session, transcripts.get(session.claudeSessionId)));
  if (input.roots.length > 0) {
    for (const [id, transcript] of transcripts) {
      if (stored.has(id)) continue;
      const row = terminalRow(transcript, input);
      if (row) rows.push(row);
    }
  }
  return rows.sort(
    (a, b) => b.item.startedAt.localeCompare(a.item.startedAt) || a.item.name.localeCompare(b.item.name) || a.item.claudeSessionId.localeCompare(b.item.claudeSessionId),
  );
}

/** The rows whose search text contains `q` (case-insensitive, trimmed); all rows for a blank `q`. */
export function filterHistory(rows: readonly HistoryRow[], q: string | undefined): HistoryItem[] {
  const needle = (q ?? '').trim().toLowerCase();
  return rows.filter((row) => !needle || row.search.includes(needle)).map((row) => row.item);
}
