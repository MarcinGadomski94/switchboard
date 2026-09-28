import type { AttachWarningReason, ContinueConversation, FolderCheck, HistoryItem, Session } from '../../core/api.ts';
import { displayTitle } from '../../core/session-title.ts';
import { folderName } from '../folders/folders.ts';

/**
 * D16 in the UI (`docs/derivations.md` → *History* → *Continue in Switchboard*):
 * moving terminal conversations into Switchboard from History (one row, or the
 * selected rows) and from the New-session form. Pure: the copy, what the
 * service's answer means for each conversation, and when a run of moves is over.
 * The prototype has none of this; the copy follows the SPEC copy rules (plain,
 * factual, sentence case) and the Attach-here warning's wording.
 */

/** The row button of a terminal conversation. */
export const CONTINUE_IN_SWITCHBOARD = 'Continue in Switchboard';
/** The terminal warning's button (the Attach warning's "Attach anyway"). */
export const CONTINUE_ANYWAY = 'Continue anyway';
export const SKIP = 'Skip';

/** `Move selected (3)`. */
export function moveSelectedLabel(count: number): string {
  return `Move selected (${count})`;
}

/** `Add switchboard and continue`: the folder by its name (its last path segment). */
export function addFolderLabel(check: Pick<FolderCheck, 'path'>): string {
  return `Add ${folderName(check.path)} and continue`;
}

/** Where one conversation of a move stands. */
export type MoveState =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'moving' }
  | { readonly kind: 'moved'; readonly sessionId: string; readonly name: string }
  /** 409 `folder-not-saved`: the workspace or repo it sits in can be added (`addFolder`). */
  | { readonly kind: 'needs-folder'; readonly check: FolderCheck }
  /** 409 `terminal-open`: a terminal may still have it (`confirm`). */
  | { readonly kind: 'terminal-open'; readonly reasons: readonly AttachWarningReason[] }
  /** Any other refusal, in words; `sessionId` when it is already in Switchboard. */
  | { readonly kind: 'refused'; readonly reason: string; readonly sessionId?: string }
  | { readonly kind: 'skipped' };

/** One conversation of a move: the row it came from, what the developer chose, where it stands. */
export interface MoveItem {
  readonly claudeSessionId: string;
  readonly title: string;
  readonly addFolder: boolean;
  readonly confirm: boolean;
  readonly state: MoveState;
}

/** A move of these rows (in the list's order), all waiting. */
export function startMoves(rows: ReadonlyArray<Pick<HistoryItem, 'claudeSessionId' | 'name'>>): MoveItem[] {
  return rows.map((row) => ({ claudeSessionId: row.claudeSessionId, title: row.name, addFolder: false, confirm: false, state: { kind: 'waiting' } }));
}

/**
 * The body of the next call for this conversation: only what the developer chose
 * (and, D22, the title typed in the New-session form: the service derives the
 * short name from it).
 */
export function continueBody(item: Pick<MoveItem, 'addFolder' | 'confirm'>, title?: string): ContinueConversation {
  return {
    ...(title ? { title } : {}),
    ...(item.addFolder ? { addFolder: true } : {}),
    ...(item.confirm ? { confirm: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a refused call means (`status` 0 = not reachable; `body` the parsed JSON). */
export function refusalState(status: number, body: unknown): MoveState {
  const record = isRecord(body) ? body : {};
  const error = record['error'];
  if (error === 'folder-not-saved' && isRecord(record['check'])) return { kind: 'needs-folder', check: record['check'] as unknown as FolderCheck };
  if (error === 'terminal-open' && Array.isArray(record['reasons'])) return { kind: 'terminal-open', reasons: record['reasons'] as AttachWarningReason[] };
  if (error === 'already-in-switchboard' && typeof record['sessionId'] === 'string') {
    return { kind: 'refused', reason: 'Already in Switchboard.', sessionId: record['sessionId'] };
  }
  return { kind: 'refused', reason: refusalText(status, body) };
}

/** A refusal in words: the validation messages, the server's `message`, else the HTTP status. */
export function refusalText(status: number, body: unknown): string {
  if (isRecord(body)) {
    if (Array.isArray(body['errors'])) {
      const messages = body['errors'].map((e) => (isRecord(e) && typeof e['message'] === 'string' ? e['message'] : null)).filter((m): m is string => m !== null);
      if (messages.length > 0) return messages.join('; ');
    }
    if (typeof body['message'] === 'string' && body['message'] !== '') return body['message'];
  }
  return status === 0 ? 'Switchboard is not reachable.' : `The move failed (HTTP ${status}).`;
}

/** The state after a successful call: the session and what it is shown as (D22: its title, else its name). */
export function movedState(session: Pick<Session, 'id' | 'name'> & Partial<Pick<Session, 'title' | 'displayTitle'>>): MoveState {
  return { kind: 'moved', sessionId: session.id, name: displayTitle(session) };
}

/** `items` with the one conversation changed. */
export function updateMove(items: readonly MoveItem[], claudeSessionId: string, patch: Partial<Omit<MoveItem, 'claudeSessionId'>>): MoveItem[] {
  return items.map((item) => (item.claudeSessionId === claudeSessionId ? { ...item, ...patch } : item));
}

/** The next conversation to call the service for, in order. */
export function nextWaiting(items: readonly MoveItem[]): MoveItem | null {
  return items.find((item) => item.state.kind === 'waiting') ?? null;
}

/** A conversation waits for the developer (add the folder, or confirm the warning). */
export function needsInput(items: readonly MoveItem[]): boolean {
  return items.some((item) => item.state.kind === 'needs-folder' || item.state.kind === 'terminal-open');
}

/** Every conversation is moved, refused or skipped. */
export function movesSettled(items: readonly MoveItem[]): boolean {
  return items.every((item) => item.state.kind === 'moved' || item.state.kind === 'refused' || item.state.kind === 'skipped');
}

/** The last conversation (in the list's order) that was moved: the session to open once the move is over. */
export function lastMoved(items: readonly MoveItem[]): { readonly sessionId: string; readonly name: string } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const state = items[i]?.state;
    if (state?.kind === 'moved') return { sessionId: state.sessionId, name: state.name };
  }
  return null;
}

/** Skips every conversation that is not moved or refused yet (Cancel). */
export function skipRemaining(items: readonly MoveItem[]): MoveItem[] {
  return items.map((item) => (item.state.kind === 'moved' || item.state.kind === 'refused' || item.state.kind === 'moving' ? item : { ...item, state: { kind: 'skipped' } }));
}

/**
 * Whether the dialog shows: a conversation waits for the developer or was
 * refused, or several move at once (their progress). A single move that simply
 * works opens its session without a dialog.
 */
export function showsDialog(items: readonly MoveItem[]): boolean {
  return items.length > 1 || needsInput(items) || items.some((item) => item.state.kind === 'refused');
}

/**
 * Opens the (last) moved session by itself once every conversation moved. When
 * one was refused or skipped (Skip, Cancel), the settled dialog stays, so the
 * reasons can be read, with **Open <last moved>** and Close.
 */
export function opensByItself(items: readonly MoveItem[]): boolean {
  return items.length > 0 && items.every((item) => item.state.kind === 'moved');
}

/** Seconds / minutes since `iso` (`12 s`, `1 min`). */
function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return 'moments';
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}

/**
 * The terminal warning (D16; the Attach-here reasons, M4.1): why a terminal may
 * still have the conversation, then what moving it now does.
 */
export function moveWarningText(reasons: readonly AttachWarningReason[], now: number = Date.now()): string {
  const why = reasons.map((reason) => {
    switch (reason.kind) {
      case 'transcript-recent':
        return `The transcript changed ${ago(reason.modifiedAt, now)} ago.`;
      case 'terminal-live':
        return `A claude process (pid ${reason.pid}) has this conversation open.`;
      case 'liveness-unknown':
        return 'Switchboard could not check whether a terminal still has this conversation open.';
    }
  });
  return [...why, 'Two processes on one conversation split it. Close it in the terminal first, or continue anyway.'].join(' ');
}

/** The folder line of `needs-folder`: where it sits and what that folder is. */
export function needsFolderText(check: Pick<FolderCheck, 'path' | 'kind'>): string {
  const kind = check.kind === 'repo' ? 'git repository' : 'workspace';
  return `No saved folder holds this conversation. It sits in the ${kind} ${check.path}.`;
}

/** One line per state, for the dialog (the actions come with it). */
export function moveStateText(state: MoveState): string {
  switch (state.kind) {
    case 'waiting':
      return 'waiting';
    case 'moving':
      return 'moving…';
    case 'moved':
      return `✓ moved as ${state.name}`;
    case 'needs-folder':
      return needsFolderText(state.check);
    case 'terminal-open':
      return moveWarningText(state.reasons);
    case 'refused':
      return `✕ ${state.reason}`;
    case 'skipped':
      return 'skipped';
  }
}

/** The terminal conversations of `folder` (a saved folder's id) that are not in Switchboard yet, newest first (the New-session form's list). */
export function terminalConversations(rows: readonly HistoryItem[], folder: string | null): HistoryItem[] {
  if (!folder) return [];
  return rows.filter((row) => row.terminal === true && row.sessionId === null && row.folder === folder);
}

/** Selected ids that are still terminal rows (the list changed: moved or gone rows leave the selection). */
export function pruneSelection(selected: ReadonlySet<string>, rows: readonly HistoryItem[]): Set<string> {
  const movable = new Set(rows.filter((row) => row.terminal === true && row.sessionId === null).map((row) => row.claudeSessionId));
  return new Set([...selected].filter((id) => movable.has(id)));
}
