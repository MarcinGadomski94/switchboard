import { useState } from 'react';
import type { TeamCharter } from '../../core/team.ts';
import { refusalText, teamApi } from './api.ts';
import { CHARTER_ROWS } from './model.ts';

/**
 * D105 · a member's charter proposal (`docs/team.md` → *Better charters*): a compact
 * before → after per field (owns, produces, how it works, never does; unchanged fields
 * say so), the agent's notes, and **Accept** / **Edit…** / **Dismiss**. Shown in Needs
 * you and above the member's Settings form. Accept replaces the charter (its agent gets
 * it with its next message); Edit… opens the member's Settings with the proposal filled
 * in; Dismiss records it.
 */
export function CharterProposal({
  requestId,
  before,
  after,
  notes,
  onEdit,
  onDecided,
}: {
  readonly requestId: string;
  readonly before: TeamCharter;
  readonly after: TeamCharter;
  readonly notes: string;
  readonly onEdit: () => void;
  readonly onDecided: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: 'approve' | 'dismiss'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await teamApi.decide(requestId, decision);
      onDecided();
    } catch (caught) {
      setError(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sb-team-charter" data-testid="team-charter-proposal" data-request-id={requestId}>
      <dl className="sb-team-charter__rows">
        {CHARTER_ROWS.map((row) => {
          const was = (before[row.key] ?? '').trim();
          const now = (after[row.key] ?? '').trim();
          return (
            <div key={row.key} className="sb-team-charter__row" data-field={row.key} data-changed={was !== now}>
              <dt className="sb-team-charter__label">{row.label}</dt>
              <dd className="sb-team-charter__value">
                {was === now ? (
                  <span className="sb-team-muted">{now === '' ? '—' : `${now} (unchanged)`}</span>
                ) : (
                  <>
                    <span className="sb-team-charter__before" data-testid="team-charter-before">
                      {was === '' ? '—' : was}
                    </span>
                    <span className="sb-team-charter__arrow" aria-hidden="true">
                      {' → '}
                    </span>
                    <span className="sb-team-charter__after" data-testid="team-charter-after">
                      {now === '' ? '—' : now}
                    </span>
                  </>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {notes ? (
        <div className="sb-team-charter__notes" data-testid="team-charter-notes">
          Notes: {notes}
        </div>
      ) : null}
      <div className="sb-team-need__actions">
        <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-charter-accept" disabled={busy} onClick={() => void decide('approve')}>
          Accept
        </button>
        <button type="button" className="sb-button sb-team-btn" data-testid="team-charter-edit" disabled={busy} onClick={onEdit}>
          Edit…
        </button>
        <button type="button" className="sb-button sb-team-btn sb-team-btn--ghost" data-testid="team-charter-dismiss" disabled={busy} onClick={() => void decide('dismiss')}>
          Dismiss
        </button>
      </div>
      {error ? (
        <div className="sb-team-error" role="alert" data-testid="team-charter-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
