import { useCallback, useEffect, useState } from 'react';
import { type SessionCi, ciChip } from '../../core/ci.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import './ci-chip.css';

/** The chip's tooltip: the PR, its checks and what the watcher did. */
function chipTitle(chip: NonNullable<ReturnType<typeof ciChip>>): string {
  const pr = chip.pr;
  const parts = [`${pr.repo} ⎇ ${pr.branch} · PR #${pr.number}`];
  if (pr.summary) parts.push(pr.summary);
  if (pr.state === 'OPEN' && pr.review === 'REVIEW_REQUIRED') parts.push('waiting for a review');
  if (pr.state === 'OPEN' && pr.review === 'CHANGES_REQUESTED') parts.push('changes requested');
  if (pr.attempts > 0) parts.push(`${pr.attempts} of ${pr.maxAttempts} CI failures sent to the session`);
  if (pr.stopped) parts.push(pr.stopped === 'cap' ? 'stopped: attempts used up (see the Inbox)' : 'stopped: the same failure twice (see the Inbox)');
  return parts.join(' · ');
}

/**
 * D109 · the session header's PR chip (`docs/ci.md`): CI running / failed / green (ready to
 * merge) / merged, for the session's watched pull requests; only shown when it has one. A click
 * opens the PR on GitHub. Live through `ciChanged`.
 */
export function CiChip({ sessionId }: { readonly sessionId: string }) {
  const [ci, setCi] = useState<SessionCi | null>(null);
  const load = useCallback(() => {
    api.sessionCi(sessionId).then(
      (answer) => setCi(answer),
      // A paired machine before D109 (404), offline: no chip.
      () => setCi(null),
    );
  }, [sessionId]);
  useEffect(() => {
    setCi(null);
    load();
  }, [load]);
  useHubEvent('ciChanged', (payload) => {
    if (payload.sessionId === sessionId) load();
  });
  const chip = ci ? ciChip(ci.prs) : null;
  if (!chip) return null;
  const label = (
    <>
      <span className="sb-ci-chip-dot" aria-hidden="true" />
      {chip.label}
    </>
  );
  return chip.pr.url ? (
    <a className="sb-ci-chip" data-testid="session-ci-chip" data-tour="session-ci-chip" data-state={chip.state} href={chip.pr.url} target="_blank" rel="noopener noreferrer" title={chipTitle(chip)}>
      {label}
    </a>
  ) : (
    <span className="sb-ci-chip" data-testid="session-ci-chip" data-tour="session-ci-chip" data-state={chip.state} title={chipTitle(chip)}>
      {label}
    </span>
  );
}
