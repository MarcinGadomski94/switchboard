import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ArtifactKind, ArtifactSaveResult } from '../../../core/api.ts';
import { ARTIFACT_KINDS, checkArtifactLanguage, checkArtifactTitle, textContentProblem } from '../../../core/artifacts.ts';
import { ApiError, api } from '../../api/client.ts';
import { Link } from '../../router.tsx';
import { KIND_LABELS } from './artifacts.ts';
import { actionErrorText } from './session-header.ts';
import '../../components/close-session.css';
import './save-artifact.css';

/** What Save as artifact starts with (a message's text, or a code block's). */
export interface ArtifactDraft {
  readonly title: string;
  readonly kind: ArtifactKind;
  readonly language: string | null;
  readonly content: string;
}

/** The kinds the developer may save from the chat (an image is the agent's, from a file). */
const TEXT_KINDS = ARTIFACT_KINDS.filter((kind) => kind !== 'image');

/**
 * D89 · Save as artifact (`docs/artifacts.md` → *Saving from the chat*): the
 * proposed title (the message's first heading or line), kind (markdown for a
 * message, code with its language for a code block) and text, all editable, then
 * **Save** (`POST /api/sessions/{id}/artifacts`, saved by the developer). After
 * the save it says so, with **Open** (the Artifacts tab on it). Esc or Cancel
 * closes it without saving.
 */
export function SaveArtifactDialog({ sessionId, draft, onClose }: { readonly sessionId: string; readonly draft: ArtifactDraft; readonly onClose: () => void }) {
  const [title, setTitle] = useState(draft.title);
  const [kind, setKind] = useState<ArtifactKind>(draft.kind);
  const [language, setLanguage] = useState(draft.language ?? '');
  const [content, setContent] = useState(draft.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ArtifactSaveResult | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    titleRef.current?.select();
  }, []);

  const save = (): void => {
    const checkedTitle = checkArtifactTitle(title);
    if (!checkedTitle.ok) return setError(`Title: ${checkedTitle.message}`);
    const checkedLanguage = checkArtifactLanguage(kind === 'code' ? language : null);
    if (!checkedLanguage.ok) return setError(`Language: ${checkedLanguage.message}`);
    const problem = textContentProblem(kind, content);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    api.saveArtifact(sessionId, { title: checkedTitle.value, kind, content, ...(kind === 'code' ? { language: checkedLanguage.value } : {}) }).then(
      (result) => {
        setBusy(false);
        setSaved(result);
      },
      (caught: unknown) => {
        setBusy(false);
        setError(caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null));
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };

  return createPortal(
    <div className="sb-close-overlay" onClick={busy ? undefined : onClose} onKeyDown={onKeyDown}>
      <div
        className="sb-close-dialog sb-save-art"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sb-save-art-title"
        data-testid="save-artifact"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sb-save-art-head" id="sb-save-art-title">
          Save as artifact
        </div>
        {saved ? (
          <>
            <div className="sb-close-text" data-testid="save-artifact-done">
              Saved “{saved.artifact.title}” to this session's Artifacts.
            </div>
            <div className="sb-close-actions">
              <Link
                className="sb-button sb-close-primary"
                data-testid="save-artifact-open"
                to={{ view: 'session', id: sessionId, tab: 'artifacts', artifactId: saved.artifact.id }}
                onClick={onClose}
              >
                Open
              </Link>
              <button type="button" className="sb-button sb-close-outlined" data-testid="save-artifact-close" autoFocus onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="sb-save-art-field">
              <span>Title</span>
              <input ref={titleRef} data-testid="save-artifact-title" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <div className="sb-save-art-row">
              <label className="sb-save-art-field">
                <span>Kind</span>
                <select data-testid="save-artifact-kind" value={kind} onChange={(event) => setKind(event.target.value as ArtifactKind)}>
                  {TEXT_KINDS.map((entry) => (
                    <option key={entry} value={entry}>
                      {KIND_LABELS[entry]}
                    </option>
                  ))}
                </select>
              </label>
              {kind === 'code' ? (
                <label className="sb-save-art-field">
                  <span>Language</span>
                  <input data-testid="save-artifact-language" value={language} placeholder="ts, python, sql…" onChange={(event) => setLanguage(event.target.value)} />
                </label>
              ) : null}
            </div>
            <label className="sb-save-art-field">
              <span>Content</span>
              <textarea data-testid="save-artifact-content" value={content} rows={10} spellCheck={false} onChange={(event) => setContent(event.target.value)} />
            </label>
            {error ? (
              <div className="sb-close-error" role="alert" data-testid="save-artifact-error">
                {error}
              </div>
            ) : null}
            <div className="sb-close-actions">
              <button type="button" className="sb-button sb-close-primary" data-testid="save-artifact-save" disabled={busy} aria-busy={busy || undefined} onClick={save}>
                Save
              </button>
              <button type="button" className="sb-button sb-close-outlined" data-testid="save-artifact-cancel" disabled={busy} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * D89: the ⋯ of an agent's chat message: a small menu with **Save as artifact**.
 * Esc / a click outside close it; on touch screens the ⋯ is always shown,
 * elsewhere on the message's hover or focus. The ⋯ glyph is drawn by CSS, so the
 * message's text (copy, selection) never picks it up.
 */
export function MessageMenu({ onSave }: { readonly onSave: () => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const outside = (event: MouseEvent): void => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (event.key === 'Tab') setOpen(false);
  };
  return (
    <span className="sb-chat-more">
      <button
        ref={button}
        type="button"
        className="sb-button sb-chat-more-button"
        data-testid="chat-message-menu"
        data-tour="message-menu"
        aria-label="Message actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <div ref={menu} className="sb-chat-more-menu" role="menu" aria-label="Message actions" data-testid="chat-message-menu-list" onKeyDown={onKeyDown}>
          <button
            type="button"
            role="menuitem"
            className="sb-button sb-chat-more-item"
            data-testid="chat-save-artifact"
            onClick={() => {
              setOpen(false);
              onSave();
            }}
          >
            Save as artifact
          </button>
        </div>
      ) : null}
    </span>
  );
}
