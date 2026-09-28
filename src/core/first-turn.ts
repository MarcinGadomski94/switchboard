import type { NewSession } from './api.ts';
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
 */

/** Outbox kind (`pending_messages.kind`) of the answers block when the task is empty. */
export const SESSION_START_KIND = 'session-start';

/** One worktree the session starts with (gap #1). */
export interface FirstTurnWorktree {
  /** Workspace folder of the solution, `/`-separated (`microfrontends/web-front`, `mobile`). */
  readonly folder: string;
  /** Absolute worktree path, in the OS's form (gap #17). */
  readonly path: string;
  /** `session/{name}`. */
  readonly branch: string;
}

/**
 * The validated NewSession fields the block reads (the router fields are `null`
 * only for a repo folder's session, which gets no block, D14).
 */
export type FirstTurnSession = Pick<NewSession, 'solutions' | 'coordination' | 'qa' | 'worktrees' | 'ultracode'> & {
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
 */
export function sessionStartBlock(answers: SessionStartAnswers): string {
  const { session } = answers;
  const lines: string[] = [...SESSION_START_HEADER];
  const item = (label: string, value: string): void => {
    lines.push(`- ${label}: ${value}`);
  };
  item('Work type', session.workType === 'qa' ? 'test-authoring (QA)' : 'feature-building');
  item('Mode', session.mode === 'orchestrator' ? 'workspace orchestrator' : 'single-solution');
  item('Solutions in scope', answers.folders.length > 0 ? answers.folders.join(', ') : NONE);
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
  } else if (asksMobileCoordination(session) && session.coordination !== null) {
    item('Mobile coordination', COORDINATION_TERMS[session.coordination]);
  }
  item('Ultracode', session.ultracode ? 'on' : 'off');
  if (session.worktrees && answers.worktrees.length > 0) {
    lines.push('- Worktrees (one per solution; make every change there, not in the main checkout):');
    for (const worktree of answers.worktrees) lines.push(`  - ${worktree.folder}: ${worktree.path} (branch ${worktree.branch})`);
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
  /** `session/{name}`. */
  readonly branch: string;
  /** The branch (or commit) it was made from. */
  readonly base: string;
  /** The repository's main checkout. */
  readonly repoPath: string;
}

/**
 * The only thing a repo folder's session gets appended to its first message
 * (D14: no router answers): which worktree it runs in and that the main
 * checkout is not its working tree. Lines are `- Label: value`.
 */
export function repoWorktreeNote(worktree: RepoWorktree): string {
  return [
    REPO_WORKTREE_NOTE_HEADER,
    `- Worktree: ${worktree.path} (branch ${worktree.branch}, from ${worktree.base}); it is your working folder: make every change here.`,
    `- Main checkout: ${worktree.repoPath} (leave it as it is).`,
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
 * (or the repo worktree note, D14) Switchboard appended ({@link firstTurnPayload}).
 * The block goes to the agent unchanged; the bubble shows what the developer
 * typed, as in the prototype.
 */
export function withoutSessionStartBlock(text: string): string {
  let shown = text;
  for (const header of [SESSION_START_HEADER[0], REPO_WORKTREE_NOTE_HEADER]) {
    if (shown.startsWith(header)) return '';
    const at = shown.indexOf(`\n\n${header}`);
    if (at !== -1) shown = shown.slice(0, at);
  }
  return shown;
}
