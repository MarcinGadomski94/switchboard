import { type RefObject, useEffect, useRef } from 'react';
import { parseDraftValue } from '../../core/drafts.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import { pageClientId } from '../pwa/presence.ts';
import { DraftField } from './draft-field.ts';
import { type DraftScope, knownDraft, readDrafts, rememberDraft } from './session-drafts.ts';

/** What a field gives {@link useDraft}. */
export interface UseDraftOptions<T> {
  /** The session; `null` for this machine's own drafts (the New-session form, ruling 2026-10-09). */
  readonly sessionId: DraftScope;
  /** The field key (`src/core/drafts.ts` → `draftField`); `null` = no draft (read-only, answered, offline). */
  readonly field: string | null;
  /** The field's current value (the hook reads it when it saves; keep the component's own state). */
  readonly value: T;
  /** Shows the server's value (parsed), or empties the field for `null`. */
  readonly apply: (value: T | null) => void;
  /** The element whose focus counts as "being typed in" (the focus rule). */
  readonly root: RefObject<Element | null>;
  /** What the field showed when it mounted (from {@link initialDraft}); default: empty. */
  readonly initial?: T | null;
}

/** What {@link useDraft} answers. */
export interface DraftControl {
  /** Clears the draft now (the text was sent, saved or cancelled). */
  clear(): void;
}

/** The draft known to this page for a field, parsed (for a `useState` initializer); `null` when there is none. */
export function initialDraft<T>(sessionId: DraftScope, field: string | null): T | null {
  if (field === null) return null;
  const known = knownDraft(sessionId, field);
  return known === undefined ? null : (parseDraftValue(field, known) as T | null);
}

/**
 * D88 · keeps one field's unsent value as the session's draft on the server
 * (`docs/chat.md` → *Drafts*; the sync rules are `draft-field.ts`). The value stays
 * the component's own state: typing renders nothing else and only arms a timer.
 * Saves on a 400 ms pause, on blur, when the page hides or unloads (`keepalive`)
 * and when the field goes away; restores from the server on mount; follows other
 * devices through `/hub` `draftChanged` (never while the field has focus).
 */
export function useDraft<T>({ sessionId, field, value, apply, root, initial = null }: UseDraftOptions<T>): DraftControl {
  const valueRef = useRef(value);
  valueRef.current = value;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const sync = useRef<DraftField | null>(null);
  const initialRef = useRef(initial);

  useEffect(() => {
    if (field === null) return undefined;
    const focused = (): boolean => {
      const element = root.current;
      return element !== null && typeof document !== 'undefined' && element.contains(document.activeElement);
    };
    const field_ = field;
    const current = new DraftField(
      {
        field: field_,
        value: () => valueRef.current,
        apply: (next) => {
          rememberDraft(sessionId, field_, next);
          applyRef.current(next === null ? null : (parseDraftValue(field_, next) as T | null));
        },
        focused,
        write: async (next, keepalive) => {
          rememberDraft(sessionId, field_, next);
          if (sessionId === null) {
            if (next === null) await api.deleteMachineDraft(field_, pageClientId(), keepalive);
            else await api.putMachineDraft(field_, { value: next, client: pageClientId() }, keepalive);
          } else if (next === null) await api.deleteDraft(sessionId, field_, pageClientId(), keepalive);
          else await api.putDraft(sessionId, field_, { value: next, client: pageClientId() }, keepalive);
        },
        read: async () => (await readDrafts(sessionId)).get(field_) ?? null,
      },
      initialRef.current,
    );
    sync.current = current;
    let live = true;
    // The first read on this page (a revisit already showed what it knew; the read refreshes it).
    void readDrafts(sessionId).then((values) => {
      if (live) current.loaded(values.get(field_) ?? null);
    });

    const element = root.current;
    const onFocusOut = (event: Event): void => {
      const next = (event as FocusEvent).relatedTarget;
      if (element && next instanceof Node && element.contains(next)) return;
      void current.blurred();
    };
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') void current.flush(true);
    };
    const onPageHide = (): void => void current.flush(true);
    element?.addEventListener('focusout', onFocusOut);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      live = false;
      element?.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      current.dispose();
      if (sync.current === current) sync.current = null;
    };
    // `root` is a ref (stable); the element is read when the field mounts.
  }, [sessionId, field, root]);

  // A local change: saved after the pause (nothing renders).
  useEffect(() => {
    sync.current?.changed();
  }, [value]);

  useHubEvent('draftChanged', (payload) => {
    if (payload.sessionId !== sessionId || payload.field !== field || field === null) return;
    if (payload.client !== null && payload.client === pageClientId()) return;
    const current = sync.current;
    if (!current) return;
    const key = field;
    void readDrafts(sessionId).then((values) => {
      if (sync.current === current) current.remote(values.get(key) ?? null);
    });
  });

  return {
    clear: () => {
      void sync.current?.clear();
    },
  };
}
