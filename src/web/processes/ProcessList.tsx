import { useEffect, useState } from 'react';
import type { SessionProcess, SessionProcesses, TrackedProcessTotals } from '../../core/api.ts';
import { ApiError, api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { Link } from '../router.tsx';
import { MachineTag } from '../components/MachineTag.tsx';
import { PROCESSES_POLL_MS, ageLabel, footerLine, kindTag, memoryLabel, processTitle, stopLine } from './processes.ts';
import './processes.css';

/** Reads `fetcher` now and every {@link PROCESSES_POLL_MS} while mounted. */
function usePolled<T>(fetcher: () => Promise<T>, deps: readonly unknown[]) {
  const state = useApi(fetcher, deps);
  const { reload } = state;
  useEffect(() => {
    const timer = setInterval(reload, PROCESSES_POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);
  return state;
}

/**
 * D127 (`docs/processes.md`): the rows of a session's processes: name, kind, RAM, age, and
 * **Stop** / **Keep**. `onChanged` gets the session's list as the action answered it.
 */
export function ProcessRows({ sessionId, view, onChanged }: { readonly sessionId: string; readonly view: SessionProcesses; readonly onChanged: (next: SessionProcesses) => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = (pid: number, work: () => Promise<SessionProcesses>): void => {
    setBusy(pid);
    setError(null);
    work()
      .then(onChanged)
      .catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : String(reason)))
      .finally(() => setBusy(null));
  };
  return (
    <>
      <ul className="sb-procs" data-testid="process-rows">
        {view.processes.map((process: SessionProcess) => (
          <li key={process.pid} className="sb-proc" data-testid="process-row" data-pid={process.pid} data-kind={process.kind} data-keep={String(process.keep)} title={processTitle(process)}>
            <span className="sb-proc-name">{process.name}</span>
            <span className="sb-proc-kind" data-testid="process-kind">
              {kindTag(process.kind)}
            </span>
            <span className="sb-proc-ram" data-testid="process-ram">
              {memoryLabel(process.rssBytes)}
            </span>
            <span className="sb-proc-age">{ageLabel(process.startedAt)}</span>
            <span className="sb-proc-actions">
              <button
                type="button"
                className="sb-button sb-proc-btn"
                data-testid="process-keep"
                aria-pressed={process.keep}
                disabled={busy !== null}
                title={process.keep ? 'Kept: never stopped automatically. Click to let Switchboard stop it when the session is idle or closed.' : 'Keep it running: never stopped automatically'}
                onClick={() => act(process.pid, () => api.keepProcess(sessionId, process.pid, !process.keep))}
              >
                Keep
              </button>
              <button type="button" className="sb-button sb-proc-btn" data-testid="process-stop" disabled={busy !== null} title="Stop it now (and what runs under it)" onClick={() => act(process.pid, () => api.stopProcess(sessionId, process.pid))}>
                {busy === process.pid ? '…' : 'Stop'}
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error ? (
        <div className="sb-proc-error" role="alert" data-testid="process-error">
          {error}
        </div>
      ) : null}
    </>
  );
}

/**
 * D127: the session panel's **Processes** section: what the session's agent left running
 * (build servers, test hosts, dev servers), when it stops by itself, Stop / Keep. Nothing
 * renders while the session has none.
 */
export function SessionProcessesSection({ sessionId }: { readonly sessionId: string }) {
  const { data, reload } = usePolled(() => api.sessionProcesses(sessionId, true), [sessionId]);
  const [view, setView] = useState<SessionProcesses | null>(null);
  useEffect(() => setView(data), [data]);
  if (!view || view.processes.length === 0) return null;
  return (
    <section className="sb-procs-section" data-testid="session-processes" aria-label="Processes">
      <div className="sb-sv-panel-head">
        <span className="sb-sv-panel-label">Processes</span>
        <span className="sb-sv-panel-summary" data-testid="session-processes-summary">
          {view.processes.length} · {memoryLabel(view.rssBytes)}
        </span>
      </div>
      <ProcessRows
        sessionId={sessionId}
        view={view}
        onChanged={(next) => {
          setView(next);
          reload();
        }}
      />
      <div className="sb-procs-note" data-testid="session-processes-note">
        {stopLine(view, null)}
      </div>
    </section>
  );
}

/** D127: the sidebar footer's line ("procs 4.5 GB") while sessions left processes running; a link to Settings → Processes. */
export function ProcessesFooterLine({ totals }: { readonly totals: TrackedProcessTotals | undefined }) {
  const line = footerLine(totals);
  if (!line) return null;
  return (
    <Link to={{ view: 'settings', section: 'processes' }} className="sb-procs-footer" data-testid="processes-footer" data-tour="processes-footer" title={line.title}>
      {line.text}
    </Link>
  );
}

/**
 * D127 · Settings → **Processes**: every session's processes (this machine's and each paired
 * machine's, stopped on their machine), with totals; Stop / Keep per process.
 */
export function ProcessesOverviewList() {
  const { data, reload, error } = usePolled(() => api.processes(true), []);
  if (!data) return error ? <div className="sb-procs-note">{error.message}</div> : null;
  return (
    <div className="sb-procs-overview" data-testid="processes-overview" data-tour="processes-settings">
      <div className="sb-procs-total" data-testid="processes-total">
        {data.count === 0 ? 'No session has processes running.' : `${data.count} ${data.count === 1 ? 'process' : 'processes'} · ${memoryLabel(data.rssBytes)}`}
      </div>
      {data.sessions.map((session) => (
        <section key={session.sessionId} className="sb-procs-group" data-testid="processes-group" data-session-id={session.sessionId}>
          <div className="sb-procs-group-head">
            <Link to={{ view: 'session', id: session.sessionId, tab: 'chat' }} className="sb-procs-group-title">
              {session.title}
            </Link>
            <MachineTag machine={session.machine} />
            <span className="sb-procs-group-ram">{memoryLabel(session.rssBytes)}</span>
          </div>
          <ProcessRows sessionId={session.sessionId} view={session} onChanged={() => reload()} />
          <div className="sb-procs-note">{stopLine(session, data.idleStopMinutes)}</div>
        </section>
      ))}
      {(data.unavailable ?? []).map((item) => (
        <div key={item.machine.id} className="sb-procs-note" data-testid="processes-unavailable">
          {item.machine.name}: not listed ({item.reason}).
        </div>
      ))}
    </div>
  );
}
