import { useEffect, useRef } from 'react';
import type { InboxItem } from '../../core/api.ts';
import { displayTitle } from '../../core/session-title.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useRouter } from '../router.tsx';
import { type OpenNotice, type QuestionBatchEvent, noticesToClear, notifyOs, playChime, questionNotice } from './notify.ts';
import type { Toast } from './ToastHost.tsx';

/** The batch's Inbox item (id = batch id), `null` when it is not listed or the list cannot be read. */
async function inboxItem(batchId: string): Promise<InboxItem | null> {
  try {
    return (await api.inbox()).find((item) => item.id === batchId) ?? null;
  } catch {
    return null;
  }
}

/** The session's display title (D22: its title, else its name) from the session list, `null` when it cannot be read. */
async function sessionName(sessionId: string): Promise<string | null> {
  try {
    const session = (await api.listSessions()).find((s) => s.id === sessionId);
    return session ? displayTitle(session) : null;
  } catch {
    return null;
  }
}

/**
 * M3.4: on every `/hub` `questionBatch` (contract: "UI plays the sound, shows a
 * toast and sends an OS notification") this page, once per batch, reads the
 * batch's Inbox item for the session name and branch chips, then shows the toast,
 * plays the chime and sends the OS notification together (`docs/notifications.md`).
 * A click on the OS notification focuses the page and jumps to the session, like
 * "Jump to session".
 *
 * Developer request 2026-09-28: a toast (and its OS notification) goes away once
 * the developer opens its session, by any way, or once its batch leaves the Inbox
 * (answered, withdrawn, stale: the `/hub` `inboxChanged` event). A batch of the
 * session the page already shows raises no toast; the chime still plays, and the
 * OS notification only while the page is hidden.
 */
export function useQuestionNotifications(show: (toast: Toast) => void, dismiss: (id: string) => void): void {
  const { navigate, route } = useRouter();
  const seen = useRef(new Set<string>());
  const open = useRef(new Map<string, OpenNotice>());
  const viewing = route.view === 'session' ? route.id : null;
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;

  const clear = (batchIds: readonly string[]): void => {
    for (const batchId of batchIds) {
      open.current.get(batchId)?.os?.close();
      open.current.delete(batchId);
      dismiss(batchId);
    }
  };

  // Opening a session (sidebar, palette, Inbox, a link, Jump to session) takes its toasts away
  // (`clear` only reads refs and the stable `dismiss`), and so does coming back to the page on it.
  useEffect(() => {
    if (viewing !== null) clear(noticesToClear(open.current, viewing, null));
    const onVisible = (): void => {
      if (!document.hidden && viewingRef.current !== null) clear(noticesToClear(open.current, viewingRef.current, null));
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [viewing]);

  // An answered, withdrawn or stale batch leaves the Inbox: its toast goes too.
  useHubEvent('inboxChanged', () => {
    if (open.current.size === 0) return;
    const readStartedAt = Date.now();
    void (async () => {
      try {
        const ids = new Set((await api.inbox()).map((item) => item.id));
        clear(noticesToClear(open.current, null, { ids, readStartedAt }));
      } catch {
        // The Inbox cannot be read now; the next change tries again.
      }
    })();
  });

  useHubEvent('questionBatch', (event: QuestionBatchEvent) => {
    if (seen.current.has(event.batchId)) return;
    seen.current.add(event.batchId);
    void (async () => {
      const item = await inboxItem(event.batchId);
      const name = item ? null : await sessionName(event.sessionId);
      const notice = questionNotice(event, item, name);
      const onScreen = viewingRef.current === event.sessionId;
      void playChime();
      if (onScreen && !document.hidden) return;
      if (!onScreen) show(notice.toast);
      const os = notifyOs(notice.os, () => {
        window.focus();
        clear([event.batchId]);
        navigate({ view: 'session', id: event.sessionId, tab: 'chat' });
      });
      open.current.set(event.batchId, { sessionId: event.sessionId, shownAt: Date.now(), os });
    })();
  });
}
