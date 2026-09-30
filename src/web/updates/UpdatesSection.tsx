import { useState } from 'react';
import { gitUpdateCommands, installKindLabel, lastCheckText, phaseText } from '../../core/updates.ts';
import { ApiError, api } from '../api/client.ts';
import { useModals } from '../modals/ModalHost.tsx';
import { Row, SectionTitle, Value } from '../views/settings/rows.tsx';
import { ReleaseNotes } from './ReleaseNotes.tsx';
import { canUpdate, formatWhen, latestDescription, restartRow } from './updates-view.ts';
import { useUpdates } from './useUpdates.ts';
import './updates.css';

/**
 * Settings → Updates (D55, `docs/updates.md` → *The UI*): this version and
 * install kind, the last check (time and result), the latest release and its
 * notes, how the restart happens, the version kept for a rollback; **Check for
 * updates**, **Update…** (a release install with a newer release) or the git
 * commands (a git checkout); an error line for a failed check or update.
 */
export function UpdatesSection() {
  const { status, off, set } = useUpdates();
  const { open } = useModals();
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const check = async (): Promise<void> => {
    setChecking(true);
    setCheckError(null);
    try {
      set(await api.checkUpdates());
    } catch (error) {
      setCheckError(error instanceof ApiError && error.unreachable ? 'Switchboard is not reachable.' : 'The check could not be started.');
    } finally {
      setChecking(false);
    }
  };
  if (off) {
    return (
      <>
        <SectionTitle>Updates</SectionTitle>
        <div className="sb-set-note" data-testid="updates-off">
          Updates are off here (SWITCHBOARD_UPDATES=off, or the demo).
        </div>
      </>
    );
  }
  if (!status) return <SectionTitle>Updates</SectionTitle>;
  const restart = restartRow(status);
  const error = status.progress.phase === 'failed' ? phaseText(status.progress) : status.lastCheck && !status.lastCheck.ok ? status.lastCheck.error : checkError;
  const busyCheck = checking || status.checking;
  return (
    <>
      <SectionTitle>Updates</SectionTitle>
      <Row id="updates-version" label="Version" description={`Releases of github.com/${status.repo}`}>
        <Value>{status.current}</Value>
      </Row>
      <Row id="updates-install" label="Install" description={status.install.dir} mono>
        <Value>{installKindLabel(status.install.kind)}</Value>
      </Row>
      <Row id="updates-last-check" label="Last check" description="On start, every hour, and with Check for updates">
        <Value>{busyCheck ? 'checking…' : lastCheckText(status.lastCheck, formatWhen(status.lastCheck?.at ?? null))}</Value>
      </Row>
      <Row id="updates-latest" label="Latest release" description={latestDescription(status)}>
        <Value color={status.available ? 'var(--status-done)' : undefined}>{status.latest?.version ?? '—'}</Value>
      </Row>
      <Row id="updates-restart" label="Restart" description={restart.description}>
        <Value>{restart.value}</Value>
      </Row>
      {status.previous ? (
        <Row id="updates-previous" label="Previous version" description={status.previous.dir} mono>
          <Value>{status.previous.version}</Value>
        </Row>
      ) : null}
      {status.progress.phase !== 'idle' && status.progress.phase !== 'failed' ? (
        <div className="sb-set-note" data-testid="updates-progress">
          {phaseText(status.progress)}
        </div>
      ) : null}
      {error ? (
        <div className="sb-set-note sb-set-error" role="alert" data-testid="updates-error">
          {error}
        </div>
      ) : null}
      <div className="sb-set-actions">
        <button type="button" className="sb-set-button" data-testid="updates-check" disabled={busyCheck} onClick={() => void check()}>
          {busyCheck ? 'Checking…' : 'Check for updates'}
        </button>
        {canUpdate(status) ? (
          <button type="button" className="sb-set-button sb-update-set-primary" data-testid="updates-update" onClick={() => open('update', { updateConfirm: true })}>
            {`Update to ${status.latest?.version ?? ''}…`}
          </button>
        ) : null}
      </div>
      {status.install.kind === 'git' && status.available && status.latest ? (
        <div className="sb-update-git" data-testid="updates-git">
          <div>This is a git checkout, so Switchboard only tells you about new releases. Update it with:</div>
          <pre className="sb-update-code">{gitUpdateCommands(status.latest.tag).join('\n')}</pre>
        </div>
      ) : null}
      {status.latest ? (
        <div className="sb-update-section-notes">
          <div className="sb-update-section-label">{`What's new in ${status.latest.version}`}</div>
          <ReleaseNotes notes={status.latest.notes} />
        </div>
      ) : null}
    </>
  );
}
