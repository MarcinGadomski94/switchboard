import { useRef } from 'react';
import type { InboxItem } from '../../core/api.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useRouter } from '../router.tsx';
import { type QuestionBatchEvent, notifyOs, playChime, questionNotice } from './notify.ts';
import type { Toast } from './ToastHost.tsx';

/** The batch's Inbox item (id = batch id), `null` when it is not listed or the list cannot be read. */
async function inboxItem(batchId: string): Promise<InboxItem | null> {
  try {
    return (await api.inbox()).find((item) => item.id === batchId) ?? null;
  } catch {
    return null;
  }
}

/** The session's name from the session list, `null` when it cannot be read. */
async function sessionName(sessionId: string): Promise<string | null> {
  try {
    return (await api.listSessions()).find((session) => session.id === sessionId)?.name ?? null;
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
 */
export function useQuestionNotifications(show: (toast: Toast) => void, dismiss: (id: string) => void): void {
  const { navigate } = useRouter();
  const seen = useRef(new Set<string>());
  useHubEvent('questionBatch', (event: QuestionBatchEvent) => {
    if (seen.current.has(event.batchId)) return;
    seen.current.add(event.batchId);
    void (async () => {
      const item = await inboxItem(event.batchId);
      const name = item ? null : await sessionName(event.sessionId);
      const notice = questionNotice(event, item, name);
      show(notice.toast);
      void playChime();
      notifyOs(notice.os, () => {
        window.focus();
        dismiss(notice.toast.id);
        navigate({ view: 'session', id: event.sessionId, tab: 'chat' });
      });
    })();
  });
}
