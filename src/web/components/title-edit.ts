import type { Session } from '../../core/api.ts';
import { displayTitle } from '../../core/session-title.ts';

/**
 * Rename in place (D22, `docs/derivations.md` → *Session titles*): the session
 * header's name (click) and a sidebar row's name (double-click) turn into a text
 * field. Enter or leaving the field saves (`PUT /api/sessions/{id}/title`), Esc
 * cancels; the server's refusal is shown under the field, which stays open. Pure
 * rules of that editor, so `tests/web` covers them without a browser.
 */

/** What the editor reads from a session. */
export type TitledSession = Pick<Session, 'id' | 'name'> & Partial<Pick<Session, 'title' | 'displayTitle'>>;

/** What saving the field does. */
export type TitleEditOutcome =
  /** Nothing changed: close without a request. */
  | { readonly kind: 'unchanged' }
  /** Send `{ title }`: the trimmed text, or `null` (an emptied field clears the title: the name is shown again). */
  | { readonly kind: 'save'; readonly title: string | null };

/** The field's text when the editor opens: what the session shows now. */
export function titleDraft(session: TitledSession): string {
  return displayTitle(session);
}

/**
 * What saving `draft` does: nothing when the trimmed text is what the session
 * already shows (or the field was emptied on a session without a title);
 * otherwise send the trimmed text, `null` for an empty field. The length rule
 * is the server's: an over-long title comes back as its refusal.
 */
export function titleEditOutcome(draft: string, session: TitledSession): TitleEditOutcome {
  const text = draft.trim();
  if (text === '') return session.title ? { kind: 'save', title: null } : { kind: 'unchanged' };
  if (text === displayTitle(session)) return { kind: 'unchanged' };
  return { kind: 'save', title: text };
}

/** The line under the field when the rename is refused: the server's own message (422 `errors`, else `message`), else the HTTP status. */
export function renameErrorText(status: number, body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const record = body as { errors?: unknown; message?: unknown };
    if (Array.isArray(record.errors)) {
      const messages = record.errors
        .map((e) => (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : null))
        .filter((m): m is string => m !== null);
      if (messages.length > 0) return `Not renamed: ${messages.join('; ')}`;
    }
    if (typeof record.message === 'string' && record.message !== '') return `Not renamed: ${record.message}`;
  }
  return status === 0 ? 'Not renamed: Switchboard is not reachable.' : `Not renamed: HTTP ${status}`;
}

/**
 * The name's tooltip: what the session is shown as in full (a long title is cut
 * with an ellipsis in the sidebar), the short name behind a title, and how to
 * rename it. `JIRA Ticket handling (jira-ticket-handling) · click to rename`.
 */
export function titleTooltip(session: TitledSession, gesture: 'click' | 'double-click'): string {
  const how = gesture === 'click' ? 'click to rename' : 'double-click to rename';
  const shown = displayTitle(session);
  return shown === session.name ? `${shown} · ${how}` : `${shown} (${session.name}) · ${how}`;
}
