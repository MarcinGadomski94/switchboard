/**
 * D50 · Stop the current turn in the composer (`docs/chat.md` → *Stop*): when the
 * ■ Stop button replaces Send, and when Esc stops the turn. Pure, so it can be
 * unit-tested; ChatTab reads the page and calls these.
 */
import type { BackgroundTask } from '../../../core/api.ts';
import type { SessionStatus } from '../../../core/model.ts';
import { stoppableTask } from '../../../core/stop-turn.ts';

/** What {@link canStop} reads of the session. */
export interface StoppableSession {
  /** A live supervised process (`Session.live`). */
  readonly live: boolean;
  readonly status: SessionStatus;
  /** D19 / D30: what the running turn does; state `background` = no turn runs, only background work waits. */
  readonly activity?: { readonly state: string; readonly background?: readonly BackgroundTask[] } | null;
  /** D48 P4: a hooked terminal session: its turns are stopped in the terminal, never from here. */
  readonly hooked?: boolean;
}

/**
 * `true` while a turn runs, so Stop applies: a live process whose status is `run`
 * (a turn runs, or a message waits for its turn) or `need` (the turn waits on a
 * question or permission). Not while only background work keeps the session
 * working (D30 / D43: activity `background`, no turn to stop), and never for a
 * paused, idle, done or failed session.
 */
export function canStop(session: StoppableSession | null): boolean {
  if (!session || !session.live || session.hooked === true) return false;
  if (session.status !== 'run' && session.status !== 'need') return false;
  return session.activity?.state !== 'background';
}

/** A key press as {@link escStops} reads it. */
export interface StopKeyPress {
  readonly key: string;
  readonly defaultPrevented: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}

/** Where the page is when Esc comes (read from the DOM by the composer). */
export interface StopKeyContext {
  /** A turn runs ({@link canStop}). */
  readonly stoppable: boolean;
  /** A Stop already waits for the CLI (a second Esc does nothing). */
  readonly stopping: boolean;
  /** A modal, dialog, popover or menu is open (`role="dialog"` / `"alertdialog"`, `aria-modal`): Esc closes it first. */
  readonly overlayOpen: boolean;
  /** Focus is in a text field other than the composer's message field (a title, an own answer, a setting): Esc is that field's. */
  readonly editingElsewhere: boolean;
}

/**
 * D50: Esc stops the running turn when nothing else owns the key: no modal,
 * dialog or popover is open (Esc closes it), focus is not in another text field
 * (the composer's own field is fine), no modifier is held, no IME composes and no
 * other handler took it. Nothing happens while no turn runs or a Stop already
 * waits. (A subagent's chat has no composer: there Esc goes back, D36.)
 */
export function escStops(press: StopKeyPress, context: StopKeyContext): boolean {
  if (press.key !== 'Escape' || press.defaultPrevented || press.isComposing) return false;
  if (press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) return false;
  if (!context.stoppable || context.stopping) return false;
  return !context.overlayOpen && !context.editingElsewhere;
}

/**
 * D50 ruling (background): the background tasks the composer offers to stop: when
 * no turn runs (nothing for Stop) but the live session waits on background work
 * (activity `background`, D30 / D43), its pending tasks, oldest first; `[]`
 * otherwise, and for a hooked session. Only tasks `stop_task` can end count
 * (`stoppableTask`: not a wake-up); with none there is no offer.
 */
export function stoppableBackground(session: StoppableSession | null): readonly BackgroundTask[] {
  if (!session || !session.live || session.hooked === true || canStop(session)) return [];
  if (session.activity?.state !== 'background') return [];
  const tasks = session.activity.background ?? [];
  return tasks.some(stoppableTask) ? tasks : [];
}
