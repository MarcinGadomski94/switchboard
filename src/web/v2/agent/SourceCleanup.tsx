import { useEffect, useState } from 'react';
import type { Session } from '../../../core/api.ts';
import { CLEANUP_CHECKBOX_HINT, CLEANUP_SOURCE_PREF, SOURCE_CLEANUP_KIND_LABELS, type SourceCleanupItem, type SourceCleanupReport, cleanupCheckboxLabel, cleanupSummary, manualListText } from '../../../core/source-cleanup.ts';
import { ApiError, api } from '../../api/client.ts';
import { Button, Checkbox, Dialog } from '../components/index.ts';
import { openStore } from '../shared/open-store.ts';

/**
 * D156 (`docs/peers.md` → *Cleaning up the source after a move (D156)*): the move
 * dialogs' "Clean up on <source> after a successful move" (remembered on this
 * computer), the clean-up's result with the list of what is left to remove by hand,
 * and **Clean up on this computer…** for an agent that was already moved.
 */

function readPref(): boolean {
  try {
    return window.localStorage.getItem(CLEANUP_SOURCE_PREF) === '1';
  } catch {
    return false;
  }
}

/** The checkbox's state, remembered on this computer (off by default). */
export function useCleanupSourcePref(): readonly [boolean, (next: boolean) => void] {
  const [on, setOn] = useState<boolean>(readPref);
  const set = (next: boolean): void => {
    setOn(next);
    try {
      window.localStorage.setItem(CLEANUP_SOURCE_PREF, next ? '1' : '0');
    } catch {
      // Storage refused (private mode): the choice holds for this dialog only.
    }
  };
  return [on, set] as const;
}

/** "Clean up on <source> after a successful move" with what it does. */
export function CleanupSourceOption({ source, checked, onChange, disabled }: { readonly source: string; readonly checked: boolean; readonly onChange: (next: boolean) => void; readonly disabled?: boolean }) {
  return (
    <div className="v2-mv-facts" data-testid="v2-move-cleanup" data-tour="v2-move-cleanup">
      <Checkbox label={cleanupCheckboxLabel(source)} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} data-testid="v2-move-cleanup-check" />
      <p className="v2-muted v2-c-small">{CLEANUP_CHECKBOX_HINT}</p>
    </div>
  );
}

function ItemList({ items, testId }: { readonly items: readonly SourceCleanupItem[]; readonly testId: string }) {
  return (
    <ul className="v2-mv-cleanup-list" data-testid={testId}>
      {items.map((item) => (
        <li key={`${item.kind}:${item.path}`} data-testid={`${testId}-item`} data-kind={item.kind}>
          <span className="v2-muted">{SOURCE_CLEANUP_KIND_LABELS[item.kind] ?? item.kind}: </span>
          <code>{item.path}</code>
          <span className="v2-muted"> — {item.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** What a clean-up removed (or would remove) and the manual list, with a copy of it as plain text. */
export function CleanupReportView({ report }: { readonly report: SourceCleanupReport }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(manualListText(report.manual)).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div className={report.error ? 'v2-mv-warn' : 'v2-mv-facts'} data-testid="v2-move-cleanup-report" data-ran={report.ran ? 'true' : 'false'}>
      <p data-testid="v2-move-cleanup-summary">
        <b>{cleanupSummary(report)}</b>
      </p>
      {report.derived ? <p className="v2-muted v2-c-small">This agent was moved by an older Switchboard, so what travelled was not recorded: only what is certainly safe is removed, the rest is listed.</p> : null}
      {report.removed.length > 0 ? (
        <>
          <p className="v2-muted">{report.ran ? 'Removed:' : 'Removes:'}</p>
          <ItemList items={report.removed} testId="v2-move-cleanup-removed" />
        </>
      ) : null}
      {report.manual.length > 0 ? (
        <>
          <p className="v2-muted">Left for you to remove by hand (Switchboard deletes none of these):</p>
          <ItemList items={report.manual} testId="v2-move-cleanup-manual" />
          <Button size="sm" variant="ghost" icon="copy" onClick={copy} data-testid="v2-move-cleanup-copy">
            {copied ? 'Copied' : 'Copy the list'}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** The dialog of **Clean up on this computer…** (`sessionId`: a moved agent of this computer). */
export const movedCleanupDialog = openStore<{ readonly sessionId: string; readonly title: string }>();

/** Whether a session offers **Clean up on this computer…**: this computer's agent that was moved away. */
export function offersMovedCleanup(session: Pick<Session, 'movedTo' | 'machine'> | null | undefined): boolean {
  return Boolean(session?.movedTo) && !session?.machine;
}

/** The button (an agent's page, an Archived row). */
export function MovedCleanupButton({ session, title, size }: { readonly session: Pick<Session, 'id' | 'movedTo' | 'machine'>; readonly title: string; readonly size?: 'sm' }) {
  if (!offersMovedCleanup(session)) return null;
  return (
    <Button size={size ?? 'sm'} icon="trash" onClick={() => movedCleanupDialog.open({ sessionId: session.id, title })} data-testid="v2-moved-cleanup" data-tour="v2-moved-cleanup">
      {session.movedTo?.cleanedAt ? 'Clean up again…' : 'Clean up on this computer…'}
    </Button>
  );
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | null;
    if (body && typeof body.message === 'string') return body.message;
    return error.status === 0 ? 'Switchboard could not be reached' : `HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Mounted once (`MoveDialogsHost`). */
export function MovedCleanupHost() {
  const open = movedCleanupDialog.use();
  return open ? <MovedCleanupDialog key={open.sessionId} sessionId={open.sessionId} title={open.title} /> : null;
}

function MovedCleanupDialog({ sessionId, title }: { readonly sessionId: string; readonly title: string }) {
  const [report, setReport] = useState<SourceCleanupReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.moveCleanupPreview(sessionId).then(
      (answer) => alive && setReport(answer),
      (caught: unknown) => alive && setError(errorText(caught)),
    );
    return () => {
      alive = false;
    };
  }, [sessionId]);
  const run = (): void => {
    setBusy(true);
    setError(null);
    api
      .moveCleanupRun(sessionId)
      .then(setReport, (caught: unknown) => setError(errorText(caught)))
      .finally(() => setBusy(false));
  };
  const close = (): void => {
    if (!busy) movedCleanupDialog.close();
  };
  const done = report?.ran === true;
  return (
    <Dialog
      open
      onClose={close}
      title="Clean up on this computer"
      icon="trash"
      width={680}
      testId="v2-moved-cleanup-dialog"
      footer={
        <>
          <span className="v2-grow" />
          <Button onClick={close} disabled={busy} data-testid="v2-moved-cleanup-close">
            {done ? 'Close' : 'Cancel'}
          </Button>
          {!done ? (
            <Button variant="primary" icon="trash" disabled={busy || report === null} aria-busy={busy || undefined} onClick={run} data-testid="v2-moved-cleanup-run">
              Clean up
            </Button>
          ) : null}
        </>
      }
    >
      <div className="v2-mv" data-testid="v2-moved-cleanup-body">
        <p className="v2-muted v2-mv-sub">
          {title}
          {report ? ` · moved to ${report.movedTo}` : ''}
        </p>
        {!report && !error ? <p className="v2-muted">Checking what is left on this computer…</p> : null}
        {report ? <CleanupReportView report={report} /> : null}
        {error ? (
          <div className="v2-mv-error" role="alert" data-testid="v2-moved-cleanup-error">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
