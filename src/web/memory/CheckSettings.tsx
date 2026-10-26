import { useCallback, useEffect, useState } from 'react';
import { MEMORY_CHECK_FREQUENCIES, type MemoryCheckSettings, type MemoryCheckStatus, checkFrequencyText, memoryCheckLine } from '../../core/memory-check.ts';
import type { MemoryScope } from '../../core/memory.ts';
import { useHubEvent } from '../api/useHub.ts';
import { Row, SectionTitle, ToggleValue, Value } from '../views/settings/rows.tsx';
import { memoryApi, refusalText } from './api.ts';

/**
 * D136 · Settings → Project memory (`docs/memory.md` → *Checking notes*): "Check notes
 * automatically" (on by default; both the check of a new proposal and the periodic one), the
 * periodic check's frequency (weekly by default) and the per-folder off, each folder with its last
 * check. Classic Settings shows it as its own section; v2 under Settings → Advanced.
 */
export function MemoryCheckSection() {
  const memory = memoryApi(null);
  const [settings, setSettings] = useState<MemoryCheckSettings | null>(null);
  const [folders, setFolders] = useState<ReadonlyArray<{ readonly scope: MemoryScope; readonly status: MemoryCheckStatus }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useHubEvent('memoryChanged', reload);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await memory.checkSettings();
        const scopes = (await memory.scopes()).filter((scope) => scope.approved > 0);
        const rows = await Promise.all(scopes.map(async (scope) => ({ scope, status: await memory.checkStatus(scope.scope) })));
        if (cancelled) return;
        setSettings(next);
        setFolders(rows);
        setError(null);
      } catch (failure) {
        if (!cancelled) setError(refusalText(failure));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const run = (work: () => Promise<unknown>): void => {
    work().then(reload, (failure: unknown) => setError(refusalText(failure)));
  };

  return (
    <>
      <SectionTitle>Project memory</SectionTitle>
      {error ? (
        <div className="sb-set-note sb-set-error" role="alert" data-testid="memory-check-settings-error">
          {error}
        </div>
      ) : null}
      {settings ? (
        <>
          <Row
            id="memory-check"
            label="Check notes automatically"
            description="When an agent proposes a note, a short check looks for duplicates and contradictions. And by itself, a short read-only check per folder verifies the approved notes against the code: notes that are no longer true are removed (you can restore them for 30 days), edits wait for your review. Neither opens a session."
          >
            <ToggleValue value={settings.enabled} label="Check notes automatically" onToggle={() => run(() => memory.setCheckSettings({ enabled: !settings.enabled }))} />
          </Row>
          <Row id="memory-check-frequency" label="How often" description="Per folder with approved notes, only after agents worked there, and never while your usage is at the warning level">
            <select
              className="sb-set-select"
              data-testid="memory-check-frequency"
              aria-label="How often"
              value={settings.frequencyDays}
              disabled={!settings.enabled}
              onChange={(event) => run(() => memory.setCheckSettings({ frequencyDays: Number(event.target.value) }))}
            >
              {MEMORY_CHECK_FREQUENCIES.map((days) => (
                <option key={days} value={days}>
                  {checkFrequencyText(days)}
                </option>
              ))}
            </select>
          </Row>
          {folders.length === 0 ? (
            <Row id="memory-check-folders" label="Folders" description="No folder has approved notes yet.">
              <Value>—</Value>
            </Row>
          ) : (
            folders.map(({ scope, status }) => (
              <Row key={scope.scope} id={`memory-check-folder`} label={scope.label} description={<span data-testid="memory-check-folder-line">{memoryCheckLine(status, Date.now())}</span>}>
                <ToggleValue value={status.enabled} label={`Check the notes of ${scope.label}`} disabled={!settings.enabled} onToggle={() => run(() => memory.setCheckFolder(scope.scope, !status.enabled))} />
              </Row>
            ))
          )}
        </>
      ) : null}
    </>
  );
}
