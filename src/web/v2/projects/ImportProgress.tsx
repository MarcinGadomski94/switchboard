import { useState } from 'react';
import type { JiraImportProgress } from '../../../core/api.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { importProgressView } from './import-progress.ts';

/**
 * D185 · a Jira import's progress after Create: the step in words ("Creating steps · 4 of 12") and
 * a bar, from the server's `planImportProgress` events for this form's `progressId`. Nothing shows
 * before the first event.
 */
export function ImportProgress({ progressId }: { readonly progressId: string | null }) {
  const [last, setLast] = useState<JiraImportProgress | null>(null);
  useHubEvent('planImportProgress', (progress) => {
    if (progressId !== null && progress.id === progressId) setLast(progress);
  });
  if (progressId === null || last === null || last.id !== progressId) return null;
  const view = importProgressView(last);
  return (
    <div className="v2-import-progress" role="status" aria-live="polite" data-testid="v2-import-progress" data-step={last.step} data-failed={view.failed ? 'true' : undefined}>
      <span className={view.failed ? 'v2-field-error' : 'v2-muted'}>{view.text}</span>
      {view.fraction !== null ? (
        <div className="v2-import-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(view.fraction * 100)}>
          <span style={{ width: `${Math.round(view.fraction * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}
