import { useState } from 'react';
import { availableText, phaseText } from '../../core/updates.ts';
import { api } from '../api/client.ts';
import { useModals } from '../modals/ModalHost.tsx';
import { bannerKind, canUpdate, hideKey } from './updates-view.ts';
import { useUpdates } from './useUpdates.ts';
import './updates.css';

/**
 * D55's slim banner at the top of the app (`docs/updates.md` → *The UI*):
 * "Switchboard <v> is available" with **What's new** and, for a release install,
 * **Update** (both open the dialog; Update at its confirmation), and × (hides
 * that version's banner on every tab: the service remembers it); an update's
 * progress while it runs; "Switchboard was updated to <v>" with **Reload** once
 * the service restarted into another version than the page was loaded with.
 * Nothing when the updater is off (the demo, `SWITCHBOARD_UPDATES=off`).
 */
export function UpdateBanner() {
  const { status, pageVersion, set } = useUpdates();
  const { open } = useModals();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const kind = bannerKind(status, pageVersion, hidden);
  if (!status || !kind) return null;
  const close = (): void => {
    const key = hideKey(status, kind);
    if (key) setHidden(new Set([...hidden, key]));
    else if (status.latest) void api.dismissUpdate(status.latest.version).then(set, () => undefined);
  };
  let text: string;
  if (kind === 'reload') text = `Switchboard was updated to ${status.current}`;
  else if (kind === 'progress') text = phaseText(status.progress);
  else text = availableText(status.latest?.version ?? '');
  return (
    <div className="sb-update-banner" role="status" data-testid="update-banner" data-kind={kind} data-phase={status.progress.phase}>
      <span className="sb-update-banner-dot" aria-hidden="true" />
      <span className="sb-update-banner-text" data-testid="update-banner-text">
        {text}
      </span>
      {kind === 'reload' ? (
        <button type="button" className="sb-button sb-update-banner-action" data-testid="update-banner-reload" onClick={() => window.location.reload()}>
          Reload
        </button>
      ) : (
        <button type="button" className="sb-button sb-update-banner-action" data-testid="update-banner-whats-new" onClick={() => open('update')}>
          {kind === 'progress' ? 'Details' : "What's new"}
        </button>
      )}
      {kind === 'available' && canUpdate(status) ? (
        <button type="button" className="sb-button sb-update-banner-action sb-update-banner-primary" data-testid="update-banner-update" onClick={() => open('update', { updateConfirm: true })}>
          Update
        </button>
      ) : null}
      {kind !== 'progress' || status.progress.phase === 'failed' || status.progress.phase === 'restart-manually' ? (
        <button type="button" className="sb-button sb-update-banner-close" aria-label="Dismiss" data-testid="update-banner-dismiss" onClick={close}>
          ×
        </button>
      ) : null}
    </div>
  );
}
