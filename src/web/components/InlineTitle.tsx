import { type FocusEvent, type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from 'react';
import type { Session } from '../../core/api.ts';
import { displayTitle } from '../../core/session-title.ts';
import { ApiError, api } from '../api/client.ts';
import { type TitledSession, renameErrorText, titleDraft, titleEditOutcome, titleTooltip } from './title-edit.ts';
import './title-edit.css';

/** Props of {@link InlineTitle}. */
export interface InlineTitleProps {
  readonly session: TitledSession;
  /** What opens the editor: a click (session header) or a double-click (sidebar row). */
  readonly gesture: 'click' | 'double-click';
  /** Class of the name as shown (the editor's wrapper takes it too, so the field keeps the name's font). */
  readonly className: string;
  /** `data-testid` of the name as shown. */
  readonly testId?: string;
  /** The element the name is shown in. */
  readonly as?: 'div' | 'span';
  /** The rename was saved (the server's answer). */
  readonly onRenamed?: (session: Session) => void;
}

/**
 * A session's name that can be renamed in place (D22): shown as its display title
 * (the title, else the name); the gesture turns it into a text field with the
 * current text selected. Enter or leaving the field saves through
 * `PUT /api/sessions/{id}/title` (an emptied field clears the title), Esc
 * cancels; a refusal is shown under the field (`data-testid="title-error"`) and
 * the field stays open. Rules: `title-edit.ts`. Inside a link (the sidebar row)
 * clicks in the field do not navigate.
 */
export function InlineTitle({ session, gesture, className, testId, as = 'span', onRenamed }: InlineTitleProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The saved title until the next props show it (the list reloads after `sessionUpdated`). */
  const [saved, setSaved] = useState<string | null>(null);
  /** Set once the editor is closing, so a late blur (e.g. the field leaving the page) does not save again. */
  const closing = useRef(false);
  const shownByProps = displayTitle(session);
  useEffect(() => setSaved(null), [shownByProps]);

  const open = (event: MouseEvent): void => {
    event.preventDefault();
    closing.current = false;
    setError(null);
    setDraft(saved ?? titleDraft(session));
  };
  const close = (): void => {
    closing.current = true;
    setDraft(null);
    setError(null);
  };
  const save = async (): Promise<void> => {
    if (draft === null || busy || closing.current) return;
    const outcome = titleEditOutcome(draft, saved !== null ? { ...session, title: saved, displayTitle: saved } : session);
    if (outcome.kind === 'unchanged') return close();
    setBusy(true);
    try {
      const renamed = await api.renameSession(session.id, outcome.title);
      setSaved(displayTitle(renamed));
      close();
      onRenamed?.(renamed);
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
      setError(renameErrorText(apiError.status, apiError.body));
    } finally {
      setBusy(false);
    }
  };

  if (draft === null) {
    const Tag = as;
    const handler = gesture === 'click' ? { onClick: open } : { onDoubleClick: open };
    return (
      <Tag className={className} data-testid={testId} data-renamable={gesture} title={titleTooltip(session, gesture)} {...handler}>
        {saved ?? shownByProps}
      </Tag>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  // Inside the sidebar row's link: a click in the field must not follow it.
  const stay = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <span className={`${className} sb-title-edit`} data-testid="title-edit" onClick={stay} onDoubleClick={stay}>
      <input
        className="sb-title-input"
        data-testid="title-input"
        aria-label="Session title"
        aria-invalid={error ? true : undefined}
        aria-busy={busy || undefined}
        value={draft}
        readOnly={busy}
        autoFocus
        spellCheck={false}
        onFocus={(event: FocusEvent<HTMLInputElement>) => event.currentTarget.select()}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => void save()}
      />
      {error ? (
        <span className="sb-title-error" data-testid="title-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
