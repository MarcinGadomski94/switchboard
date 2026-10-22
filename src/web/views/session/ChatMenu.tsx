import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { NewSessionPrefill, Session } from '../../../core/api.ts';
import { CONTINUE_AS_SESSION_LABEL, LOOK_AT_FOLDERS_LABEL, RENAME_CHAT_LABEL } from '../../../core/chats.ts';
import { parseRemoteId } from '../../../core/peers.ts';
import { displayTitle } from '../../../core/session-title.ts';
import { ApiError, api } from '../../api/client.ts';
import { useSavedFolders } from '../../folders/useFolders.ts';
import { useModals } from '../../modals/ModalHost.tsx';
import { useRouter } from '../../router.tsx';
import { actionErrorText } from './session-header.ts';

/** The ⋯ menu's Delete item. */
export const DELETE_CHAT_LABEL = 'Delete chat…';

/**
 * D106: what **Continue as session…** opens the New-session form with: the chat
 * (`fromChat`, its own id on its machine; its title for the form's note), its CLI
 * and model / effort, and the first folder it looks at when that is a saved folder.
 */
export function continuePrefill(chat: Session, savedFolders: ReadonlyArray<{ readonly id: string; readonly path: string; readonly canonicalPath: string }>): NewSessionPrefill {
  const raw = parseRemoteId(chat.id)?.id ?? chat.id;
  const folder = chat.machine ? undefined : savedFolders.find((saved) => (chat.lookAt ?? []).some((path) => path === saved.canonicalPath || path === saved.path));
  return {
    fromChat: raw,
    fromChatTitle: displayTitle(chat),
    ...(chat.provider ? { provider: chat.provider } : {}),
    ...(chat.model?.current ? { model: chat.model.current } : {}),
    ...(chat.model?.effort ? { effort: chat.model.effort } : {}),
    ...(folder ? { folder: folder.id } : {}),
  };
}

/**
 * D106 · a chat header's ⋯ (`docs/chats.md` → *The chat's header*): **Rename…**
 * (`onRename`: the header's title turns into its field, 2026-10-22), **Continue as
 * session…** (the New-session form, pre-filled, carrying the chat over), **Look at
 * folders…** (the folders it may read) and **Delete chat…** (asks first; the chat,
 * its conversation and its scratch folder go). `button` goes in the header's top row,
 * `panel` (the delete confirmation and a refusal) under it.
 */
export function useChatMenu(session: Session | null, sessionId: string, onRename?: () => void): { readonly button: ReactNode; readonly panel: ReactNode } {
  const modals = useModals();
  const { navigate } = useRouter();
  const saved = useSavedFolders();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const down = (event: PointerEvent): void => {
      if (!holder.current?.contains(event.target as Node | null)) setOpen(false);
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  useEffect(() => {
    setOpen(false);
    setConfirming(false);
    setError(null);
  }, [sessionId]);

  if (!session) return { button: null, panel: null };
  const title = displayTitle(session);
  const closed = session.closedAt != null;

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteChat(sessionId, true);
      setConfirming(false);
      navigate({ view: 'inbox' });
    } catch (caught) {
      setError(caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null));
    } finally {
      setBusy(false);
    }
  };

  const item = (label: string, testId: string, onClick: () => void, disabled = false, why?: string): ReactNode => (
    <button
      type="button"
      role="menuitem"
      className="sb-button sb-chat-menu-item"
      data-testid={testId}
      disabled={disabled}
      title={why}
      onClick={() => {
        setOpen(false);
        onClick();
      }}
    >
      {label}
    </button>
  );

  const button = (
    <div className="sb-chat-menu-holder" ref={holder}>
      <button
        type="button"
        className="sb-button sb-sv-action sb-chat-menu-toggle"
        data-testid="chat-menu"
        aria-label="Chat actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open ? (
        <div className="sb-chat-menu" role="menu" data-testid="chat-menu-list">
          {onRename ? item(RENAME_CHAT_LABEL, 'chat-rename', onRename) : null}
          {item(CONTINUE_AS_SESSION_LABEL, 'chat-continue-as-session', () => modals.open('new-session', { prefill: continuePrefill(session, saved.data ?? []), machine: session.machine?.id ?? null }))}
          {item(LOOK_AT_FOLDERS_LABEL, 'chat-look-at', () => modals.open('look-at', { chat: { id: sessionId, title, lookAt: session.lookAt ?? [] } }), closed, closed ? 'Reopen the chat first' : undefined)}
          {item(DELETE_CHAT_LABEL, 'chat-delete', () => setConfirming(true))}
        </div>
      ) : null}
    </div>
  );

  const panel =
    confirming || error ? (
      <div className="sb-sv-warning" role="alertdialog" aria-label="Delete chat" data-testid="chat-delete-confirm">
        {confirming ? (
          <>
            <div className="sb-sv-warning-text">Delete “{title}”? Its conversation, attachments and scratch folder are removed. This cannot be undone.</div>
            <div className="sb-sv-warning-actions">
              <button type="button" className="sb-button sb-sv-primary" data-testid="chat-delete-yes" disabled={busy} onClick={() => void remove()}>
                Delete chat
              </button>
              <button type="button" className="sb-button sb-sv-outlined" data-testid="chat-delete-no" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : null}
        {error ? (
          <div className="sb-sv-error" role="alert" data-testid="chat-menu-error">
            {error}
          </div>
        ) : null}
      </div>
    ) : null;

  return { button, panel };
}
