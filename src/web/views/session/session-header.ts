import type { AttachWarningReason, Session } from '../../../core/api.ts';
import { folderName, samePath } from '../../folders/folders.ts';

/** A session tab (the router's `SessionTab`, restated so this module has no JSX import). */
export type HeaderTab = 'chat' | 'timeline' | 'diff' | 'artifacts';

/**
 * Copy and rules of the session header (M4.1, SPEC → Session; prototype `ss`,
 * `pauseLabel`, `attachLabel`, `tabs`, `handoff`). Pure, so `tests/web` can check
 * them without a browser.
 */

/** "⇄ Continue in terminal" while attached, "⇄ Attach here" while a terminal owns the session (prototype `attachLabel`). */
export const CONTINUE_IN_TERMINAL = '⇄ Continue in terminal';
export const ATTACH_HERE = '⇄ Attach here';

/** The session's folder facts the root line reads (D14). */
export type SessionPlace = Pick<Session, 'cwd' | 'folderPath' | 'folderKind'>;

/**
 * What the session's working folder is (D14): `workspace root` for a workspace
 * folder (the prototype's words: the router applies there), `git repo` for a repo
 * session in the repo, `worktree of <repo>` for one in its worktree.
 */
export function placeLabel(session: SessionPlace): string {
  if (session.folderKind !== 'repo') return 'workspace root';
  const repo = session.folderPath ? folderName(session.folderPath) : null;
  if (session.cwd && session.folderPath && !samePath(session.cwd, session.folderPath)) return repo ? `worktree of ${repo}` : 'worktree';
  return 'git repo';
}

/**
 * The root path line: `<cwd> · workspace root` (prototype `D:\acme ·
 * workspace root`), and for a repo folder (D14) `<cwd> · git repo` or `<cwd> ·
 * worktree of <repo>`.
 */
export function rootLine(session: SessionPlace): string {
  const label = placeLabel(session);
  return session.cwd ? `${session.cwd} · ${label}` : label;
}

/** What the Pause / Resume button does for the session. */
export interface PauseButton {
  readonly action: 'pause' | 'resume';
  readonly label: 'Pause' | 'Resume';
  /** Resume is refused while a terminal owns the session (409 `detached`): Attach here first. */
  readonly disabled: boolean;
}

/**
 * Pause while the session has a live process, or while its stored status still
 * says it runs or waits (`run` / `need`); Resume otherwise (paused, ended, failed:
 * D7 `--resume` + "Continue."). Disabled while detached.
 */
export function pauseButton(session: Pick<Session, 'live' | 'status' | 'attached'>): PauseButton {
  const running = session.live || session.status === 'run' || session.status === 'need';
  if (running) return { action: 'pause', label: 'Pause', disabled: !session.attached };
  return { action: 'resume', label: 'Resume', disabled: !session.attached };
}

/** One header tab (prototype `TABS`: `Chat`, `Timeline`, `Diff · n`, `Artifacts · n`). */
export interface TabLabel {
  readonly tab: HeaderTab;
  readonly label: string;
}

/** The tabs with their counts: changed files (gap #10) and the session's artifacts (gap #9). */
export function tabLabels(files: number, artifacts: number): TabLabel[] {
  return [
    { tab: 'chat', label: 'Chat' },
    { tab: 'timeline', label: 'Timeline' },
    { tab: 'diff', label: `Diff · ${files}` },
    { tab: 'artifacts', label: `Artifacts · ${artifacts}` },
  ];
}

/** The handoff card (prototype `handoff`): state, its color and the explanation, verbatim. */
export interface Handoff {
  readonly state: 'attached' | 'in terminal';
  /** A SPEC status token (`done` attached, `need` in a terminal). */
  readonly status: 'done' | 'need';
  readonly text: string;
}

export function handoff(attached: boolean): Handoff {
  return attached
    ? {
        state: 'attached',
        status: 'done',
        text: 'Running in the background and attached here. Detach to continue in a terminal. The conversation stays in sync both ways.',
      }
    : {
        state: 'in terminal',
        status: 'need',
        text: 'Detached. Continue in any terminal with the command below. Switchboard keeps showing notifications and syncs back when you attach.',
      };
}

/** Seconds / minutes since `iso` (`12 s`, `1 min`), for the warning. */
function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return 'moments';
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}

/**
 * The Attach warning (gap #5, M0.4): why a terminal may still hold the session,
 * then what attaching now does. The prototype has no warning; the copy follows
 * the SPEC copy rules (plain, factual, sentence case).
 */
export function attachWarningText(reasons: readonly AttachWarningReason[], now: number = Date.now()): string {
  const why = reasons.map((reason) => {
    switch (reason.kind) {
      case 'transcript-recent':
        return `The transcript changed ${ago(reason.modifiedAt, now)} ago.`;
      case 'terminal-live':
        return `A claude process (pid ${reason.pid}) has this session open.`;
      case 'liveness-unknown':
        return 'Switchboard could not check whether a terminal still has this session open.';
    }
  });
  return [...why, 'Attaching while a terminal still has the session open forks the conversation. Close it there first, or attach anyway.'].join(' ');
}

/** Attach warning buttons. */
export const ATTACH_ANYWAY = 'Attach anyway';
export const CANCEL = 'Cancel';

/** A refused header action, in words (the server's `message` when it has one). */
export function actionErrorText(status: number, body: unknown): string {
  const message = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : null;
  if (status === 0) return 'Switchboard is not reachable.';
  return message ?? `The request failed (HTTP ${status}).`;
}
