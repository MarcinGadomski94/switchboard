import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionEvent } from '../../../core/api.ts';
import { ApiError, api } from '../../api/client.ts';
import { type CutRef, LOADING_FULL, SHOW_FULL, cutNote, fullTextError, withRestored } from './full-text.ts';

/** Fix · long messages: one cut text's fetch. */
export interface FullTextState {
  readonly busy: boolean;
  readonly error: string | null;
}

/** What a chat passes to its bubbles to restore cut texts. */
export interface FullTextControl {
  readonly state: (eventId: number) => FullTextState | null;
  readonly restore: (eventId: number) => void;
}

/**
 * Fix · long messages: the restored events of one session's chat and the control
 * its notes use. `events` comes back with the restored ones in place
 * ({@link withRestored}); a fetch's result is kept for this chat's life.
 */
export function useFullText(sessionId: string, events: readonly SessionEvent[]): { readonly events: readonly SessionEvent[]; readonly control: FullTextControl } {
  const [restored, setRestored] = useState<ReadonlyMap<number, SessionEvent>>(new Map());
  const [states, setStates] = useState<ReadonlyMap<number, FullTextState>>(new Map());
  const session = useRef(sessionId);
  session.current = sessionId;
  useEffect(() => {
    setRestored(new Map());
    setStates(new Map());
  }, [sessionId]);
  const setState = useCallback((eventId: number, state: FullTextState | null): void => {
    setStates((current) => {
      const next = new Map(current);
      if (state === null) next.delete(eventId);
      else next.set(eventId, state);
      return next;
    });
  }, []);
  const restore = useCallback(
    (eventId: number): void => {
      const forSession = sessionId;
      setState(eventId, { busy: true, error: null });
      api.fullEvent(forSession, eventId).then(
        (answer) => {
          if (session.current !== forSession) return;
          setRestored((current) => new Map(current).set(eventId, answer.event));
          setState(eventId, null);
        },
        (error: unknown) => {
          if (session.current !== forSession) return;
          setState(eventId, { busy: false, error: error instanceof ApiError ? fullTextError(error.status, error.body) : fullTextError(0, null) });
        },
      );
    },
    [sessionId, setState],
  );
  const shown = useMemo(() => withRestored(events, restored), [events, restored]);
  const control = useMemo<FullTextControl>(() => ({ state: (eventId) => states.get(eventId) ?? null, restore }), [states, restore]);
  return { events: shown, control };
}

/**
 * Fix · long messages: the muted line under a cut bubble, "Message cut at 4,000
 * characters · Show full message" (or "Output truncated at … · Show full output"),
 * which fetches the whole text; while it loads, "Loading the full text…"; when it
 * cannot, the reason (e.g. the transcript is gone) and the button again.
 */
export function CutNote({ cut, control }: { readonly cut: CutRef; readonly control: FullTextControl | undefined }) {
  if (!control) return null;
  const state = control.state(cut.eventId);
  return (
    <div className="sb-chat-cut" data-testid="chat-cut" data-kind={cut.kind} data-event-id={cut.eventId} data-state={state?.busy ? 'loading' : state?.error ? 'failed' : undefined}>
      <span data-testid="chat-cut-note">{cutNote(cut)}</span>
      {' · '}
      {state?.busy ? (
        <span data-testid="chat-cut-loading">{LOADING_FULL}</span>
      ) : (
        <button type="button" className="sb-button sb-chat-cut-button" data-testid="chat-cut-show" onClick={() => control.restore(cut.eventId)}>
          {SHOW_FULL[cut.kind]}
        </button>
      )}
      {state?.error ? (
        <div className="sb-chat-cut-error" data-testid="chat-cut-error" role="alert">
          {state.error}
        </div>
      ) : null}
    </div>
  );
}
