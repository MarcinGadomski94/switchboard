import type { NewSession } from './api.ts';
import type { HandoffBranching } from './branching.ts';
import { handoffLines } from './stacking.ts';
import type { Coordination, Phase, QaStack, SessionMode, WorkType } from './model.ts';

/**
 * The first stdin user message of a new session (M5.2, `docs/new-session.md` →
 * *First-turn payload*). The CLI takes no prompt argument (M0.1), so the
 * developer's task and the session-start answers they confirmed in the
 * New-session form go into that first message, and the agent confirms them
 * instead of asking the router's session-start questions again. The terms are
 * the modal summary's (`src/web/modals/new-session.ts` → `summaryLines`).
 *
 * D14: only a session in a **workspace** folder gets the answers block (the
 * router's session-start questions). A session in a **repo** folder gets only
 * the worktree note ({@link repoWorktreeNote}) when it runs in a worktree, and
 * nothing appended otherwise.
 *
 * D38: a workspace session may start without picked solutions; the block then
 * tells the agent to determine them ({@link SOLUTIONS_NOT_CHOSEN}) and, with
 * Worktrees on, to create its own worktree per solution it changes
 * ({@link agentWorktreesInstruction}).
 *
 * D40: a session whose worktrees follow the epic/task branching model gets its
 * Branching lines (`branchingLines` in `branching.ts`) before the worktrees, each
 * worktree names the origin branch it was cut from, and the D38 instruction
 * names the base to cut from and the lazy push rule.
 *
 * D47: a stacked session's Branching lines are `stackedLines` (`stacking.ts`,
 * through `handoffLines`), and the D38 instruction cuts from the parent.
 */

/** Outbox kind (`pending_messages.kind`) of the answers block when the task is empty. */
export const SESSION_START_KIND = 'session-start';

/** One worktree the session starts with (gap #1). */
export interface FirstTurnWorktree {
  /** Workspace folder of the solution, `/`-separated (`microfrontends/web-front`, `mobile`). */
  readonly folder: string;
  /** Absolute worktree path, in the OS's form (gap #17). */
  readonly path: string;
  /** The worktree record's branch: the developer's ticket branch (D32), `session/{name}` for a scheduled run. */
  readonly branch: string;
  /** D40: the origin branch it was cut from (`origin/dev`); omitted or `null` = not cut from origin (shown as before). */
  readonly from?: string | null;
}

/**
 * The validated NewSession fields the block reads (the router fields are `null`
 * only for a repo folder's session, which gets no block, D14). D38: `name` is the
 * session's short name, which the agent's own worktree folders are named after.
 */
export type FirstTurnSession = Pick<NewSession, 'name' | 'solutions' | 'coordination' | 'qa' | 'worktrees' | 'ultracode' | 'branch'> & {
  readonly workType: WorkType | null;
  readonly mode: SessionMode | null;
  readonly phase: Phase | null;
};

/** What the answers block says: the validated NewSession plus what the service resolved. */
export interface SessionStartAnswers {
  readonly session: FirstTurnSession;
  /** One workspace folder per `session.solutions` entry, same order. */
  readonly folders: readonly string[];
  /** The worktrees created for the session; empty when `session.worktrees` is false. */
  readonly worktrees: readonly FirstTurnWorktree[];
  /**
   * D38: the branch the agent's own worktrees get when the session starts with
   * Worktrees on and no solutions picked: the D32 ticket branch, `session/{name}`
   * for a scheduled run. The service always passes it; omitted, `session.branch`.
   */
  readonly agentBranch?: string | null;
  /** D40: the session's branching lines' input; omitted or `null` = no Branching lines (a scheduled run, no worktrees). */
  readonly branching?: HandoffBranching | null;
}

/** Opening lines of the block. */
export const SESSION_START_HEADER = [
  "Session-start answers, confirmed by the developer in Switchboard's new-session form before this session started.",
  'Take them as the answers to the session-start questions: confirm them back in one line instead of asking them again.',
] as const;

/** Value when a field was left empty (the modal summary's `—`). */
const NONE = '—';

const COORDINATION_TERMS: Readonly<Record<Coordination, string>> = {
  sequential: 'sequential',
  'parallel-twin': 'parallel-twin',
  none: 'no counterpart',
};

const STACK_TERMS: Readonly<Record<QaStack, string>> = { web: 'web', mobile: 'mobile', both: 'both' };

/**
 * D38: the `Solutions in scope` answer of a workspace session started without
 * picked solutions: the agent determines them itself.
 */
export const SOLUTIONS_NOT_CHOSEN =
  'not chosen: determine them from the task and the router (AGENTS.md), name them in your one-line confirmation before you change anything, and ask if it is unclear';

/**
 * D38: the `Worktrees` answer of a workspace session started with Worktrees on
 * and no picked solutions: the agent creates one worktree per solution it
 * changes, on the session's branch, at `<repo parent>/<repo>-wt-<name>` (gap #1's
 * naming, so Switchboard adopts it: `docs/worktrees.md` → *Adopted worktrees*).
 */
export function agentWorktreesInstruction(branch: string, name: string, branching: Pick<HandoffBranching, 'epic' | 'base' | 'stack'> | null = null): string {
  const where = `at <the solution repo's parent>/<repo>-wt-${name}`;
  if (branching === null) {
    return `for each solution you change, create a git worktree on branch ${branch} ${where} (git worktree add -b ${branch} <path>, from the repo's current HEAD) and make every change there, not in the main checkout`;
  }
  // D40: fetch first, cut from origin (never a local branch), reuse an existing task branch, push only at the first code change.
  const reuse = `when ${branch} exists already, on origin or locally, reuse it instead of creating it`;
  if (branching.stack) {
    // D47: stacked: the per-repo base is the parent when it is on origin there (the Per-repo line above).
    return (
      `for each solution you change, run git fetch origin --prune in its repo, then create a git worktree on branch ${branch} ${where}, ` +
      `cut from the base the Per-repo line above names for that repo ` +
      `(git worktree add --no-track -b ${branch} <path> origin/<that branch>; ${reuse}), make every change there, not in the main checkout, ` +
      `and follow the Rule above: push nothing before that repo's first code change`
    );
  }
  if (branching.epic) {
    const epic = branching.epic.branch;
    return (
      `for each solution you change, run git fetch origin in its repo, then create a git worktree on branch ${branch} ${where}, ` +
      `cut from origin/${epic} when it exists on origin, else from origin/${branching.base} ` +
      `(git worktree add --no-track -b ${branch} <path> origin/<that branch>; ${reuse}), make every change there, not in the main checkout, ` +
      `and follow the Rule above: push nothing before that repo's first code change`
    );
  }
  return (
    `for each solution you change, run git fetch origin in its repo, then create a git worktree on branch ${branch} ${where}, ` +
    `cut from origin/master (the repo's origin default branch, origin/HEAD, where it is not master; never a local branch) ` +
    `(git worktree add --no-track -b ${branch} <path> origin/master; ${reuse}), make every change there, not in the main checkout, ` +
    `and push ${branch} (git push -u origin ${branch}) only at that repo's first code change`
  );
}

/** Last segment of a solution name or path (`microfrontends/web-front` → `web-front`). */
function lastSegment(solution: string): string {
  const parts = solution.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? solution;
}

/**
 * Mobile coordination is a session-start question only for feature-building,
 * single-solution sessions with a `*-front` (microfrontend) in scope (router
 * *Session start*; the modal's section 6).
 */
export function asksMobileCoordination(session: Pick<FirstTurnSession, 'workType' | 'mode' | 'solutions'>): boolean {
  return session.workType === 'feature' && session.mode === 'single' && session.solutions.some((s) => lastSegment(s).endsWith('-front'));
}

/**
 * The session-start answers block: work type, mode, solutions in scope (folder
 * paths), phase, then mobile coordination (only when it applies and was given)
 * or the QA stack + Confluence / Figma sources (QA), ultracode, and the absolute
 * worktree paths or "no worktrees · edits in place". Lines are `- Label: value`.
 * D38: without solutions, `Solutions in scope` is {@link SOLUTIONS_NOT_CHOSEN},
 * mobile coordination is not pre-answered, and with Worktrees on the worktree
 * list becomes {@link agentWorktreesInstruction}.
 */
export function sessionStartBlock(answers: SessionStartAnswers): string {
  const { session } = answers;
  const lines: string[] = [...SESSION_START_HEADER];
  const item = (label: string, value: string): void => {
    lines.push(`- ${label}: ${value}`);
  };
  item('Work type', session.workType === 'qa' ? 'test-authoring (QA)' : 'feature-building');
  item('Mode', session.mode === 'orchestrator' ? 'workspace orchestrator' : 'single-solution');
  const chosen = session.solutions.length > 0;
  item('Solutions in scope', !chosen ? SOLUTIONS_NOT_CHOSEN : answers.folders.length > 0 ? answers.folders.join(', ') : NONE);
  item('Phase', session.phase === 'integration' ? 'integration' : 'UI-first');
  if (session.workType === 'qa') {
    const qa = session.qa ?? null;
    item('Stack under test', qa ? STACK_TERMS[qa.stack] : NONE);
    item('Confluence page', qa && qa.confluenceUrl.trim() !== '' ? qa.confluenceUrl.trim() : NONE);
    const figma = (qa?.figmaUrls ?? []).map((url) => url.trim()).filter((url) => url !== '');
    if (figma.length === 0) item('Figma frames', NONE);
    else {
      lines.push('- Figma frames:');
      for (const url of figma) lines.push(`  - ${url}`);
    }
  } else if (chosen && asksMobileCoordination(session) && session.coordination !== null) {
    item('Mobile coordination', COORDINATION_TERMS[session.coordination]);
  }
  item('Ultracode', session.ultracode ? 'on' : 'off');
  // D40: the branching model, before the worktrees it applies to.
  const branching = session.worktrees ? (answers.branching ?? null) : null;
  if (branching) lines.push(...handoffLines(branching));
  const agentBranch = answers.agentBranch ?? session.branch ?? null;
  if (session.worktrees && answers.worktrees.length > 0) {
    lines.push('- Worktrees (one per solution; make every change there, not in the main checkout):');
    for (const worktree of answers.worktrees) lines.push(`  - ${worktree.folder}: ${worktree.path} (branch ${worktree.branch}${worktree.from ? `, from ${worktree.from}` : ''})`);
  } else if (session.worktrees && !chosen && agentBranch !== null) {
    item('Worktrees', agentWorktreesInstruction(agentBranch, session.name, branching));
  } else {
    item('Worktrees', 'no worktrees · edits in place');
  }
  return lines.join('\n');
}

/** First line of the repo-folder worktree note (D14). */
export const REPO_WORKTREE_NOTE_HEADER = 'Worktree note from Switchboard: this session runs in a git worktree, not in the main checkout of the repository.';

/** The worktree a repo folder's session runs in (D14). */
export interface RepoWorktree {
  /** Absolute worktree path (the session's cwd), in the OS's form. */
  readonly path: string;
  /** The worktree record's branch: the developer's ticket branch (D32), `session/{name}` for a scheduled run. */
  readonly branch: string;
  /** The branch (or commit) it was made from. */
  readonly base: string;
  /** The repository's main checkout. */
  readonly repoPath: string;
  /** D40: the session's branching lines' input; omitted or `null` = none. */
  readonly branching?: HandoffBranching | null;
}

/**
 * The only thing a repo folder's session gets appended to its first message
 * (D14: no router answers): which worktree it runs in and that the main
 * checkout is not its working tree. Lines are `- Label: value`. D40: then the
 * session's Branching lines, when it has them.
 */
export function repoWorktreeNote(worktree: RepoWorktree): string {
  return [
    REPO_WORKTREE_NOTE_HEADER,
    `- Worktree: ${worktree.path} (branch ${worktree.branch}, from ${worktree.base}); it is your working folder: make every change here.`,
    `- Main checkout: ${worktree.repoPath} (leave it as it is).`,
    ...(worktree.branching ? handoffLines(worktree.branching) : []),
  ].join('\n');
}

/**
 * The first stdin user message: the task text (the router lets the developer
 * define the task first), a blank line, then the answers block (or a repo
 * folder's worktree note, D14). An empty block leaves the task alone. An empty
 * task gives `''`: the process starts idle and the block waits in the outbox
 * ({@link SESSION_START_KIND}) for the developer's first message.
 */
export function firstTurnPayload(task: string, block: string): string {
  const text = task.trim();
  if (text === '') return '';
  return block === '' ? text : `${text}\n\n${block}`;
}

/**
 * A user message as the chat shows it: without the session-start answers block
 * (or the repo worktree note, D14) Switchboard added. The block goes to the agent
 * unchanged; the bubble shows what the developer typed, as in the prototype.
 *
 * The block is one paragraph (no blank line inside) that starts with its header,
 * and sits either after the task ({@link firstTurnPayload}) or, when the session
 * started without a task, in front of the developer's first message (the outbox
 * goes first, `SessionSupervisor` joins with a blank line). Only that paragraph
 * is removed; the text before and after it stays.
 */
export function withoutSessionStartBlock(text: string): string {
  let shown = text;
  for (const header of [SESSION_START_HEADER[0], REPO_WORKTREE_NOTE_HEADER]) {
    const atStart = shown.startsWith(header);
    const inside = atStart ? -1 : shown.indexOf(`\n\n${header}`);
    if (!atStart && inside === -1) continue;
    const blockStart = atStart ? 0 : inside + 2;
    const blockEnd = shown.indexOf('\n\n', blockStart);
    const before = atStart ? '' : shown.slice(0, inside);
    const after = blockEnd === -1 ? '' : shown.slice(blockEnd + 2);
    shown = before !== '' && after !== '' ? `${before}\n\n${after}` : before + after;
  }
  return shown;
}
