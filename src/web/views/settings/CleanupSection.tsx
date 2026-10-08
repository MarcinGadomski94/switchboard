import { type MouseEvent, useEffect, useMemo, useState } from 'react';
import {
  CLEANUP_CONFIRM_LABELS,
  CLEANUP_GROUP_HINTS,
  CLEANUP_GROUP_LABELS,
  CLEANUP_REASON_LABELS,
  CLOSED_SESSION_DAYS_MAX,
  CLOSED_SESSION_DAYS_MIN,
  type CleanupConfirm,
  type CleanupItem,
  type CleanupRun,
  type CleanupScan,
  defaultSelection,
  inRunOrder,
  neededConfirmations,
  parseClosedSessionDays,
  runRequestOf,
} from '../../../core/cleanup.ts';
import { ApiError, api, onDeviceOrigin } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { ageLine, groupState, groupsOf, runSummary, selectionLine, sizeText, stepMark, toggled, toggledGroup } from './cleanup.ts';
import { refusalText } from './machines.ts';
import { Row, SectionTitle } from './rows.tsx';
import './cleanup.css';

/** How often a running clean-up is read. */
const RUN_POLL_MS = 400;

function errorText(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) return refusalText(caught.body, fallback);
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

/**
 * Settings → Clean-up (D84, `docs/cleanup.md`): the dry run grouped (worktrees,
 * local branches, remote branches, closed sessions, old data) with sizes, ages
 * and exactly what each item removes; **Clean up selected** confirms (with the
 * extra confirmations uncommitted changes, unmerged branches and remote branches
 * need), then shows the progress and the result. This machine only; on a paired
 * device it only says so.
 */
export function CleanupSection() {
  if (onDeviceOrigin()) {
    return (
      <>
        <SectionTitle>Clean-up</SectionTitle>
        <div className="sb-set-note" data-testid="cleanup-device-note" data-tour="cleanup">
          Clean-up runs only on the computer itself: open Switchboard there.
        </div>
      </>
    );
  }
  return <LocalCleanup />;
}

function LocalCleanup() {
  const scan = useApi(api.cleanupScan);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [days, setDays] = useState('');
  const [daysError, setDaysError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!scan.data) return;
    setSelected(defaultSelection(scan.data.items));
    setDays(String(scan.data.closedSessionDays));
  }, [scan.data]);

  const saveDays = async (): Promise<void> => {
    const value = parseClosedSessionDays(Number(days));
    if (value === null || !/^\d+$/.test(days.trim())) {
      setDaysError(`A whole number of days from ${CLOSED_SESSION_DAYS_MIN} to ${CLOSED_SESSION_DAYS_MAX}.`);
      return;
    }
    setDaysError(null);
    if (value === scan.data?.closedSessionDays) return;
    try {
      await api.saveCleanupSettings({ closedSessionDays: value });
      scan.reload();
    } catch (caught) {
      setDaysError(errorText(caught, 'The limit could not be saved.'));
    }
  };

  const data = scan.data;
  const groups = data ? groupsOf(data.items) : [];
  return (
    <>
      <SectionTitle withLede>Clean-up</SectionTitle>
      <div className="sb-set-lede" data-tour="cleanup">
        Finds what Switchboard created and no longer needs: worktrees, branches, old closed sessions and data files. Nothing is removed until you tick it and confirm. This machine only.
      </div>
      <Row id="cleanup-days" label="Closed sessions" description="List closed sessions once they have been closed this long">
        <span className="sb-cleanup-days">
          <input
            className="sb-set-input sb-cleanup-days-input"
            data-testid="cleanup-days"
            type="number"
            inputMode="numeric"
            min={CLOSED_SESSION_DAYS_MIN}
            max={CLOSED_SESSION_DAYS_MAX}
            value={days}
            aria-label="Closed sessions older than, in days"
            onChange={(event) => setDays(event.target.value)}
            onBlur={() => void saveDays()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveDays();
            }}
          />
          <span className="sb-cleanup-days-unit">days</span>
        </span>
      </Row>
      {daysError ? (
        <div className="sb-set-note sb-set-error" data-testid="cleanup-days-error">
          {daysError}
        </div>
      ) : null}
      <div className="sb-cleanup-bar">
        <button type="button" className="sb-set-button" data-testid="cleanup-scan" disabled={scan.loading} onClick={() => scan.reload()}>
          {scan.loading ? 'Scanning…' : 'Scan again'}
        </button>
        <span className="sb-cleanup-muted" data-testid="cleanup-scanned">
          {data ? `Scanned ${new Date(data.scannedAt).toLocaleTimeString()} · nothing is removed by a scan` : scan.loading ? 'Scanning…' : ''}
        </span>
      </div>
      {scan.error && !data ? (
        <div className="sb-set-note sb-set-error" data-testid="cleanup-error">
          {errorText(scan.error, 'The scan failed.')}
        </div>
      ) : null}
      {data && data.notes.length > 0 ? (
        <ul className="sb-cleanup-notes" data-testid="cleanup-notes">
          {data.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {data
        ? groups.map((view) => (
            <section className="sb-cleanup-group" key={view.group} data-group={view.group} data-testid="cleanup-group">
              <div className="sb-cleanup-group-head">
                <label className="sb-cleanup-group-label">
                  {view.items.length > 0 ? (
                    <input
                      type="checkbox"
                      data-testid="cleanup-group-toggle"
                      checked={groupState(view.items, selected) === 'all'}
                      ref={(element) => {
                        if (element) element.indeterminate = groupState(view.items, selected) === 'some';
                      }}
                      onChange={() => setSelected(toggledGroup(view.items, selected))}
                    />
                  ) : null}
                  <span>{CLEANUP_GROUP_LABELS[view.group]}</span>
                </label>
                <span className="sb-cleanup-muted" data-testid="cleanup-group-summary">
                  {view.summary}
                </span>
              </div>
              <div className="sb-cleanup-hint">{CLEANUP_GROUP_HINTS[view.group]}</div>
              {view.items.length === 0 ? <div className="sb-cleanup-empty">Nothing to clean up here.</div> : null}
              {view.items.map((item) => (
                <ItemRow key={item.id} item={item} checked={selected.has(item.id)} onToggle={() => setSelected(toggled(selected, item.id))} />
              ))}
            </section>
          ))
        : null}
      {data ? (
        <div className="sb-cleanup-footer">
          <span data-testid="cleanup-selection">{selectionLine(data.items, selected)}</span>
          <button type="button" className="sb-set-button sb-cleanup-go" data-testid="cleanup-start" disabled={selected.size === 0} onClick={() => setConfirming(true)}>
            Clean up selected
          </button>
        </div>
      ) : null}
      {confirming && data ? (
        <CleanupDialog
          scan={data}
          selected={selected}
          onClose={(ran) => {
            setConfirming(false);
            if (ran) scan.reload();
          }}
        />
      ) : null}
    </>
  );
}

function ItemRow({ item, checked, onToggle }: { readonly item: CleanupItem; readonly checked: boolean; readonly onToggle: () => void }) {
  const size = sizeText(item);
  const age = ageLine(item);
  return (
    <div className="sb-cleanup-item" data-testid="cleanup-item" data-id={item.id} data-confirm={item.confirm ?? undefined}>
      <input type="checkbox" className="sb-cleanup-check" checked={checked} onChange={onToggle} aria-label={`Clean up ${item.title}`} data-testid="cleanup-item-check" />
      <div className="sb-cleanup-item-main">
        <div className="sb-cleanup-item-title" title={item.title}>
          {item.title}
        </div>
        <div className="sb-cleanup-item-sub">{item.subtitle}</div>
        <div className="sb-cleanup-chips">
          {item.reasons.map((reason) => (
            <span key={reason} className="sb-cleanup-chip" data-reason={reason}>
              {CLEANUP_REASON_LABELS[reason]}
            </span>
          ))}
        </div>
        {item.warnings.map((warning) => (
          <div key={warning.kind} className="sb-cleanup-warning" data-kind={warning.kind} data-testid="cleanup-warning">
            ⚠ {warning.message}
            {warning.files.length > 0 ? (
              <ul className="sb-cleanup-files">
                {warning.files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
        <details className="sb-cleanup-what">
          <summary>What goes</summary>
          <ul className="sb-cleanup-removes" data-testid="cleanup-removes">
            {item.removes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {item.keeps.length > 0 ? <div className="sb-cleanup-keeps">Kept: {item.keeps.join('; ')}</div> : null}
        </details>
      </div>
      <div className="sb-cleanup-item-meta">
        {size ? <span data-testid="cleanup-item-size">{size}</span> : null}
        {age ? <span>{age}</span> : null}
      </div>
    </div>
  );
}

/** The confirmation, then the progress and the result. */
function CleanupDialog({ scan, selected, onClose }: { readonly scan: CleanupScan; readonly selected: ReadonlySet<string>; readonly onClose: (ran: boolean) => void }) {
  const picked = useMemo(() => inRunOrder(scan.items.filter((item) => selected.has(item.id))), [scan, selected]);
  const needed = useMemo(() => neededConfirmations(scan.items, selected), [scan, selected]);
  const [ticked, setTicked] = useState<Set<CleanupConfirm>>(new Set());
  const [run, setRun] = useState<CleanupRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allConfirmed = [...needed.keys()].every((kind) => ticked.has(kind));
  const running = run !== null && run.finishedAt === null;

  useEffect(() => {
    if (!run || run.finishedAt !== null) return undefined;
    const timer = window.setTimeout(() => {
      api.cleanupRun(run.id).then(setRun, (caught: unknown) => setError(errorText(caught, 'The progress could not be read.')));
    }, RUN_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [run]);

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setRun(await api.startCleanup(runRequestOf(scan.items, selected)));
    } catch (caught) {
      setError(errorText(caught, 'The clean-up could not start.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sb-cleanup-overlay" data-testid="cleanup-overlay" onClick={() => (running ? undefined : onClose(run !== null))}>
      <div
        className="sb-cleanup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Clean up"
        data-testid="cleanup-dialog"
        data-state={run ? (run.finishedAt ? 'done' : 'running') : 'confirm'}
        onClick={(event: MouseEvent) => event.stopPropagation()}
      >
        <div className="sb-cleanup-dialog-head">
          <div className="sb-cleanup-dialog-title">{run ? (run.finishedAt ? 'Clean-up finished' : 'Cleaning up…') : `Clean up ${picked.length} ${picked.length === 1 ? 'item' : 'items'}?`}</div>
          <div className="sb-cleanup-muted" data-testid="cleanup-dialog-sub">
            {run ? runSummary(run) : 'Exactly this is removed. Everything else stays.'}
          </div>
        </div>
        <div className="sb-cleanup-dialog-body">
          {run ? (
            <ul className="sb-cleanup-progress" data-testid="cleanup-progress">
              {run.items.map((item) => (
                <li key={item.id} data-status={item.status} data-testid="cleanup-step">
                  <span className="sb-cleanup-mark">{stepMark(item.status)}</span>
                  <span className="sb-cleanup-step-title">
                    {CLEANUP_GROUP_LABELS[item.group]}: {item.title}
                  </span>
                  {item.error ? <span className="sb-cleanup-step-error">{item.error}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <>
              <ul className="sb-cleanup-preview" data-testid="cleanup-preview">
                {picked.flatMap((item) => item.removes.map((line) => <li key={`${item.id}:${line}`}>{line}</li>))}
              </ul>
              {[...needed].map(([kind, items]) => (
                <div key={kind} className="sb-cleanup-confirm" data-kind={kind} data-testid="cleanup-confirm">
                  <ul className="sb-cleanup-files">
                    {items.map((item) => (
                      <li key={item.id}>
                        {item.title}
                        {item.warnings
                          .filter((warning) => warning.kind === kind)
                          .map((warning) => (
                            <span key={warning.kind} className="sb-cleanup-muted">
                              {' '}
                              — {warning.message}
                              {warning.files.length > 0 ? `: ${warning.files.join(', ')}` : ''}
                            </span>
                          ))}
                      </li>
                    ))}
                  </ul>
                  <label className="sb-cleanup-confirm-label">
                    <input type="checkbox" data-testid="cleanup-confirm-check" checked={ticked.has(kind)} onChange={() => setTicked((now) => toggled(now as Set<string>, kind) as Set<CleanupConfirm>)} />
                    {CLEANUP_CONFIRM_LABELS[kind]}
                  </label>
                </div>
              ))}
            </>
          )}
          {error ? (
            <div className="sb-set-note sb-set-error" data-testid="cleanup-dialog-error">
              {error}
            </div>
          ) : null}
        </div>
        <div className="sb-cleanup-dialog-actions">
          {run ? (
            <button type="button" className="sb-set-button" data-testid="cleanup-done" disabled={running} onClick={() => onClose(true)}>
              Done
            </button>
          ) : (
            <>
              <button type="button" className="sb-set-button" data-testid="cleanup-cancel" onClick={() => onClose(false)}>
                Cancel
              </button>
              <button type="button" className="sb-set-button sb-cleanup-go" data-testid="cleanup-confirm-go" disabled={busy || !allConfirmed} onClick={() => void start()}>
                {busy ? 'Starting…' : 'Clean up'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
