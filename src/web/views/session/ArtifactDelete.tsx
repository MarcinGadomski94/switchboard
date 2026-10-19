import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../api/client.ts';
import { deleteQuestion } from './artifacts.ts';
import { actionErrorText } from './session-header.ts';
import '../../components/close-session.css';
import './artifacts.css';

/** An API failure in words (the refusal's message, else the status). */
export function deleteErrorText(caught: unknown): string {
  return caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null);
}

/** Props of {@link ArtifactDeleteConfirm}. */
export interface ArtifactDeleteConfirmProps {
  /** The artifacts to delete: one asks by its title, several by their count. */
  readonly titles: readonly string[];
  readonly busy: boolean;
  /** Why the delete failed (shown in the dialog), else `null`. */
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * D89 · Delete's confirmation, shared by the viewer, a row's ⋯ (the session's
 * Artifacts tab, the Artifacts page) and the Artifacts page's bulk Delete: the
 * Close confirmation's look; Cancel has the focus; Esc or a click outside cancels.
 */
export function ArtifactDeleteConfirm({ titles, busy, error = null, onConfirm, onCancel }: ArtifactDeleteConfirmProps) {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!busy) onCancel();
    }
  };
  return createPortal(
    <div className="sb-close-overlay" onClick={busy ? undefined : onCancel} onKeyDown={onKeyDown}>
      <div className="sb-close-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sb-artv-delete-text" data-testid="artifact-delete-confirm" onClick={(event) => event.stopPropagation()}>
        <div className="sb-close-text" id="sb-artv-delete-text">
          {deleteQuestion(titles)}
        </div>
        {error ? (
          <div className="sb-close-error" role="alert" data-testid="artifact-delete-error">
            {error}
          </div>
        ) : null}
        <div className="sb-close-actions">
          <button type="button" className="sb-button sb-close-primary" data-testid="artifact-delete-yes" disabled={busy} aria-busy={busy || undefined} onClick={onConfirm}>
            Delete
          </button>
          <button type="button" className="sb-button sb-close-outlined" data-testid="artifact-delete-cancel" disabled={busy} autoFocus onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Props of {@link ArtifactRowMenu}. */
export interface ArtifactRowMenuProps {
  readonly title: string;
  /** D48: why the artifact's machine cannot be reached (Delete is off, the menu says why), else `null`. */
  readonly blocked: string | null;
  /** Deletes it (rejects with the refusal). */
  readonly remove: () => Promise<void>;
  /** After a delete went through. */
  readonly onDeleted?: () => void;
}

/** Where the open menu sits in the window (fixed, so a scrolling list never clips it). */
interface Placement {
  readonly top: number;
  readonly right: number;
}

/**
 * D89 follow-up · a list row's ⋯ (the session's Artifacts tab, the Artifacts
 * page): a menu with **Delete…**, which asks first ({@link ArtifactDeleteConfirm}).
 * The menu opens under the ⋯ (above it near the window's bottom), placed in the
 * window; ↑ ↓ move, Esc closes (focus back on ⋯), a click outside or a scroll
 * closes. The ⋯ never opens the row.
 */
export function ArtifactRowMenu({ title, blocked, remove, onDeleted }: ArtifactRowMenuProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = (focus: boolean): void => {
    setOpen(false);
    setPlacement(null);
    if (focus) toggle.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = toggle.current?.getBoundingClientRect();
    const height = menu.current?.offsetHeight ?? 0;
    if (!anchor) return;
    const below = anchor.bottom + 4;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - 4 - height) : below;
    setPlacement({ top, right: Math.max(8, window.innerWidth - anchor.right) });
  }, [open]);

  // The first entry takes the focus once the menu is placed (a hidden menu cannot take it).
  const placed = placement !== null;
  useEffect(() => {
    if (!open || !placed) return;
    const first = menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)');
    (first ?? menu.current)?.focus();
  }, [open, placed]);

  useEffect(() => {
    if (!open) return undefined;
    const down = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!menu.current?.contains(target) && !toggle.current?.contains(target)) close(false);
    };
    const away = (): void => close(false);
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) close(true);
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open]);

  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const confirm = (): void => {
    setBusy(true);
    setError(null);
    remove().then(
      () => {
        setBusy(false);
        setConfirming(false);
        onDeleted?.();
      },
      (caught: unknown) => {
        setBusy(false);
        setError(deleteErrorText(caught));
      },
    );
  };

  return (
    <>
      <button
        ref={toggle}
        type="button"
        className="sb-button sb-art-more"
        data-testid="artifact-row-menu"
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (open) close(false);
          else setOpen(true);
        }}
      >
        ⋯
      </button>
      {open
        ? createPortal(
            <div
              ref={menu}
              className="sb-art-menu"
              role="menu"
              tabIndex={-1}
              aria-label={`Actions for ${title}`}
              data-testid="artifact-row-menu-list"
              style={placement ? { top: placement.top, right: placement.right } : { visibility: 'hidden' }}
              onKeyDown={keys}
            >
              <button
                type="button"
                role="menuitem"
                className="sb-button sb-art-menu-item"
                data-danger="true"
                data-testid="artifact-row-delete"
                disabled={blocked !== null}
                title={blocked ?? undefined}
                onClick={() => {
                  close(false);
                  setError(null);
                  setConfirming(true);
                }}
              >
                Delete…
              </button>
              {blocked ? (
                <div className="sb-art-menu-note" data-testid="artifact-row-blocked">
                  {blocked}
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
      {confirming ? (
        <ArtifactDeleteConfirm
          titles={[title]}
          busy={busy}
          error={error}
          onConfirm={confirm}
          onCancel={() => {
            setConfirming(false);
            setError(null);
            toggle.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
