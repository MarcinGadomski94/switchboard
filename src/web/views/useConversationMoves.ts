import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryItem } from '../../core/api.ts';
import { ApiError, api } from '../api/client.ts';
import {
  type MoveItem,
  continueBody,
  lastMoved,
  movedState,
  nextWaiting,
  opensByItself,
  refusalState,
  skipRemaining,
  startMoves,
  updateMove,
} from './history-move.ts';

/** What {@link useConversationMoves} gives its view. */
export interface ConversationMoves {
  /** The conversations of the current move, `null` when none runs. */
  readonly items: readonly MoveItem[] | null;
  /** A call to the service is running. */
  readonly busy: boolean;
  /** Moves these rows, one at a time, in order; `name` (a single row) is the typed session name. */
  start(rows: ReadonlyArray<Pick<HistoryItem, 'claudeSessionId' | 'name'>>, name?: string): void;
  /** "Add <folder> and continue": the same call again with `addFolder`. */
  addFolder(claudeSessionId: string): void;
  /** "Continue anyway": the same call again with `confirm`. */
  confirm(claudeSessionId: string): void;
  skip(claudeSessionId: string): void;
  /** Cancel: skips every conversation not moved yet; the move is then over. */
  cancel(): void;
  /** Closes a finished move (the dialog). */
  close(): void;
}

/**
 * Runs moves of terminal conversations into Switchboard (D16) through
 * `POST /api/history/{id}/continue`: one call at a time, in order. A conversation
 * the service refuses with `folder-not-saved` or `terminal-open` waits for the
 * developer (add the folder / continue anyway / skip) while the others go on. When
 * every conversation moved, `onOpen` gets the last one's session and the move is
 * over; otherwise the settled move stays for the dialog (Open / Close).
 */
export function useConversationMoves(onOpen: (sessionId: string) => void): ConversationMoves {
  const [items, setItems] = useState<MoveItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const name = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const open = useRef(onOpen);
  open.current = onOpen;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!items || running.current) return;
    const next = nextWaiting(items);
    if (!next) {
      if (opensByItself(items)) {
        const last = lastMoved(items);
        setItems(null);
        if (last) open.current(last.sessionId);
      } else if (items.every((item) => item.state.kind === 'skipped')) {
        // Everything skipped: nothing to show or open.
        setItems(null);
      }
      return;
    }
    running.current = true;
    setBusy(true);
    const id = next.claudeSessionId;
    setItems((current) => (current ? updateMove(current, id, { state: { kind: 'moving' } }) : current));
    api.continueConversation(id, continueBody(next, items.length === 1 ? name.current : undefined)).then(
      (session) => {
        running.current = false;
        if (!mounted.current) return;
        setBusy(false);
        setItems((current) => (current ? updateMove(current, id, { state: movedState(session) }) : current));
      },
      (error: unknown) => {
        running.current = false;
        if (!mounted.current) return;
        setBusy(false);
        const apiError = error instanceof ApiError ? error : new ApiError(0, String(error));
        setItems((current) => (current ? updateMove(current, id, { state: refusalState(apiError.status, apiError.body) }) : current));
      },
    );
  }, [items]);

  const start = useCallback((rows: ReadonlyArray<Pick<HistoryItem, 'claudeSessionId' | 'name'>>, typed?: string) => {
    if (running.current || rows.length === 0) return;
    name.current = typed && typed.trim() !== '' ? typed.trim() : undefined;
    setItems(startMoves(rows));
  }, []);
  const retry = (claudeSessionId: string, patch: Partial<Pick<MoveItem, 'addFolder' | 'confirm'>>): void => {
    setItems((current) => (current ? updateMove(current, claudeSessionId, { ...patch, state: { kind: 'waiting' } }) : current));
  };
  return {
    items,
    busy,
    start,
    addFolder: (claudeSessionId) => retry(claudeSessionId, { addFolder: true }),
    confirm: (claudeSessionId) => retry(claudeSessionId, { confirm: true }),
    skip: (claudeSessionId) => setItems((current) => (current ? updateMove(current, claudeSessionId, { state: { kind: 'skipped' } }) : current)),
    cancel: () => setItems((current) => (current ? skipRemaining(current) : current)),
    close: () => {
      if (!running.current) setItems(null);
    },
  };
}
