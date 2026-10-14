import { useState } from 'react';
import { CI_LIMITS, CI_MERGE_METHODS, type CiMergeMethod } from '../../../core/ci.ts';
import type { KnownSettings } from '../../../core/settings.ts';
import { Row, SectionTitle, ToggleValue } from './rows.tsx';
import type { SaveSettings } from './sections.tsx';

/** The choices of the numeric rows (whole numbers in their bounds; the stored value is kept even when it is not one of them). */
const CHOICES = {
  'ci.pendingPollMinutes': [1, 2, 3, 5, 10, 15, 30],
  'ci.idlePollMinutes': [5, 10, 15, 30, 60, 120],
  'ci.maxAttempts': [1, 2, 3, 4, 5, 7, 10],
  'ci.logTailLines': [50, 100, 150, 200, 300, 500, 1000],
} as const;

/** What the merge methods read as. */
const METHOD_LABELS: { readonly [K in CiMergeMethod]: string } = {
  repo: "the repository's default (else squash)",
  squash: 'squash',
  merge: 'merge commit',
  rebase: 'rebase',
};

function options(key: keyof typeof CHOICES, value: number): number[] {
  const { min, max } = CI_LIMITS[key];
  const list: number[] = CHOICES[key].filter((n) => n >= min && n <= max);
  return list.includes(value) ? list : [...list, value].sort((a, b) => a - b);
}

/**
 * D109 · Settings → **CI & pull requests** (`docs/ci.md`, `docs/settings.md`): whether red checks
 * go back to the session, how often the PR watcher reads a PR (checks running / otherwise), how
 * many failures it sends per PR, how much of the failing job's log, and how Merge PR merges.
 */
export function CiSection({ settings, save }: { readonly settings: KnownSettings; readonly save: SaveSettings }) {
  const [busy, setBusy] = useState(false);
  const put = (patch: Partial<KnownSettings>): void => {
    setBusy(true);
    void save(patch).finally(() => setBusy(false));
  };
  const select = (key: keyof typeof CHOICES, label: string, unit: (n: number) => string) => (
    <select className="sb-set-select" data-testid={`setting-${key}`} aria-label={label} value={settings[key]} disabled={busy} onChange={(event) => put({ [key]: Number(event.target.value) })}>
      {options(key, settings[key]).map((n) => (
        <option key={n} value={n}>
          {unit(n)}
        </option>
      ))}
    </select>
  );
  const minutes = (n: number): string => (n === 1 ? 'every minute' : `every ${n} min`);
  return (
    <>
      <SectionTitle>CI &amp; pull requests</SectionTitle>
      <Row
        id="ci-send-failures"
        tour="settings-ci-send"
        label="Send CI failures to the session"
        description="When a check of a session's pull request fails, send the end of the failing job's log to the session (queued while it works) and ask it to fix and push"
      >
        <ToggleValue label="Send CI failures to the session" value={settings['ci.sendFailures']} disabled={busy} onToggle={() => put({ 'ci.sendFailures': !settings['ci.sendFailures'] })} />
      </Row>
      <Row id="ci-max-attempts" label="Fixes per pull request" description="After this many failures sent for one PR, or the same failure twice in a row, Switchboard stops and asks you in the Inbox">
        {select('ci.maxAttempts', 'Fixes per pull request', (n) => (n === 1 ? '1 attempt' : `${n} attempts`))}
      </Row>
      <Row id="ci-log-lines" label="Log lines sent" description="How much of the end of the failing job's log goes with the message">
        {select('ci.logTailLines', 'Log lines sent', (n) => `${n} lines`)}
      </Row>
      <Row id="ci-pending-poll" label="While checks run" description="How often a pull request whose checks are still running is read again (gh pr view)">
        {select('ci.pendingPollMinutes', 'While checks run', minutes)}
      </Row>
      <Row id="ci-idle-poll" label="Otherwise" description="How often any other open pull request is read again; watching stops once it is merged or closed">
        {select('ci.idlePollMinutes', 'Otherwise', minutes)}
      </Row>
      <Row id="ci-merge-method" label="Merge method" description="How Merge PR on a “ready to merge” Inbox item merges (gh pr merge). Nothing is merged without your click">
        <select className="sb-set-select" data-testid="setting-ci.mergeMethod" aria-label="Merge method" value={settings['ci.mergeMethod']} disabled={busy} onChange={(event) => put({ 'ci.mergeMethod': event.target.value as CiMergeMethod })}>
          {CI_MERGE_METHODS.map((method) => (
            <option key={method} value={method}>
              {METHOD_LABELS[method]}
            </option>
          ))}
        </select>
      </Row>
    </>
  );
}
