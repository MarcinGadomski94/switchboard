import { useEffect, useRef, useState } from 'react';
import type { FolderListing, SetupState, SolutionGroup, SystemInfo, WorkspaceRootCheck } from '../../core/api.ts';
import { ApiError, api } from '../api/client.ts';
import { notifyOs } from '../toast/notify.ts';
import {
  LAST_STEP,
  NOTIFICATIONS_ON,
  SKIPPED_KEY,
  WIZARD_STEPS,
  checkRows,
  currentPermission,
  nextLabel,
  notificationState,
  railItems,
  rootLine,
  scanRows,
  stepPosition,
} from './setup-wizard.ts';
import './setup-wizard.css';

/** How long the root field waits after typing before it checks the folder (ms). */
const CHECK_DELAY_MS = 250;

/** The message of a refused call: the server's `message`, else the error's. */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | null;
    if (body && typeof body.message === 'string' && body.message) return body.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function rememberSkipped(): void {
  try {
    sessionStorage.setItem(SKIPPED_KEY, '1');
  } catch {
    // storage blocked: the wizard may open again on the next load
  }
}

/** Step 1: `claude --version`, `claude auth status`, `gh auth status` through `GET /api/system?fresh=1`. */
function ChecksStep({ system, error }: { readonly system: SystemInfo | null; readonly error: string | null }) {
  if (error) return <div className="sb-wz-error" data-testid="wz-checks-error">{`Could not check: ${error}`}</div>;
  if (!system) return <div className="sb-wz-muted" data-testid="wz-checks-loading">Checking Claude Code and the GitHub CLI…</div>;
  return (
    <div className="sb-wz-checks" data-testid="wz-checks">
      {checkRows(system).map((row) => (
        <div key={row.label} className="sb-wz-check" data-testid="wz-check" data-ok={String(row.ok)}>
          <span className="sb-wz-check-mark">{row.ok ? '✓' : '✕'}</span>
          <div className="sb-wz-check-body">
            <div className="sb-wz-check-label">{row.label}</div>
            <div className="sb-wz-check-detail">{row.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Step 3: the scan table from `GET /api/solutions`. */
function ScanStep({ groups, error }: { readonly groups: readonly SolutionGroup[] | null; readonly error: ApiError | null }) {
  if (error) {
    const code = (error.body as { error?: unknown } | null)?.error;
    const text = code === 'workspace-not-configured' ? 'No workspace root yet. Choose one in step 2.' : `Scan failed: ${errorMessage(error)}`;
    return <div className="sb-wz-error" data-testid="wz-scan-error">{text}</div>;
  }
  if (!groups) return <div className="sb-wz-muted" data-testid="wz-scan-loading">Scanning…</div>;
  const rows = scanRows(groups);
  if (rows.length === 0) return <div className="sb-wz-muted" data-testid="wz-scan-empty">No solutions found in this workspace.</div>;
  return (
    <div className="sb-wz-scan" data-testid="wz-scan">
      {rows.map((row) => (
        <div key={row.folder} className="sb-wz-scan-row" data-testid="wz-scan-row">
          <span className="sb-wz-scan-folder">{row.folder}</span>
          <span className="sb-wz-scan-count">{row.count}</span>
          <span className="sb-wz-scan-examples">{row.examples}</span>
          <span className="sb-wz-scan-rule" data-restricted={String(row.restricted)}>
            {row.rule}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * First-run setup wizard (M5.3, SPEC → Modals → Setup wizard; `docs/setup.md`):
 * 960×620, a steps rail with ✓/number dots, Back / Skip / Continue → Finish.
 * 1. Claude Code CLI + login and the GitHub CLI (`GET /api/system?fresh=1`).
 * 2. The workspace root: typed or picked with Browse…, checked for `AGENTS.md`
 *    as you type; Continue saves it (`PUT /api/setup/root`) and the service uses
 *    it at once. A root set by `SWITCHBOARD_WORKSPACE_ROOT` is shown read-only.
 * 3. The scan of that root (`GET /api/solutions`).
 * 4. Notifications: asks the browser, then confirms with an OS notification.
 * 5. The usage warning threshold; Finish marks the setup done (`POST /api/setup/complete`).
 * No click outside closes it (as in the prototype); Skip or Esc does, and then it
 * does not open by itself again in this tab.
 */
export function SetupWizard({ onClose }: { readonly onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [rootInput, setRootInput] = useState('');
  const [rootCheck, setRootCheck] = useState<WorkspaceRootCheck | null>(null);
  const [browse, setBrowse] = useState<FolderListing | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [groups, setGroups] = useState<SolutionGroup[] | null>(null);
  const [scanError, setScanError] = useState<ApiError | null>(null);
  const [permission, setPermission] = useState(currentPermission);
  const [finishError, setFinishError] = useState<string | null>(null);
  const finished = useRef(false);

  // Closed without Finish (Skip, Esc): not again by itself in this tab.
  useEffect(
    () => () => {
      if (!finished.current) rememberSkipped();
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    api.setup().then(
      (state) => {
        if (cancelled) return;
        setSetup(state);
        setRootInput(state.workspaceRoot.path ?? '');
        setRootCheck(state.workspaceRoot.check);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Step 1 checks again each time it is shown.
  useEffect(() => {
    if (step !== 0) return;
    let cancelled = false;
    setSystemError(null);
    api.systemFresh().then(
      (info) => {
        if (!cancelled) setSystem(info);
      },
      (error: unknown) => {
        if (!cancelled) setSystemError(errorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [step]);

  // Step 3 scans each time it is shown.
  useEffect(() => {
    if (step !== 2) return;
    let cancelled = false;
    setGroups(null);
    setScanError(null);
    api.solutions().then(
      (result) => {
        if (!cancelled) setGroups(result);
      },
      (error: unknown) => {
        if (!cancelled) setScanError(error instanceof ApiError ? error : new ApiError(0, String(error)));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [step]);

  // The root field is checked a moment after typing stops.
  const envLocked = setup?.workspaceRoot.source === 'env';
  useEffect(() => {
    if (!setup || envLocked) return;
    const typed = rootInput.trim();
    if (!typed) {
      setRootCheck(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.checkRoot(typed).then(
        (check) => {
          if (!cancelled) setRootCheck(check);
        },
        () => undefined,
      );
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rootInput, setup, envLocked]);

  const openFolder = (target?: string): void => {
    api.folders(target).then(
      (listing) => {
        setBrowse(listing);
        if (target !== undefined) setRootInput(listing.path);
      },
      (error: unknown) => {
        // A typed folder that is not there: start from the default folder instead.
        if (target !== undefined && error instanceof ApiError && error.status === 404) openFolder(undefined);
        else setRootError(errorMessage(error));
      },
    );
  };

  const toggleBrowse = (): void => {
    if (browse) {
      setBrowse(null);
      return;
    }
    setRootError(null);
    const typed = rootInput.trim();
    api.folders(typed || undefined).then(
      (listing) => setBrowse(listing),
      (error: unknown) => {
        if (typed && error instanceof ApiError && error.status === 404) openFolder(undefined);
        else setRootError(errorMessage(error));
      },
    );
  };

  const saveRootAndContinue = async (): Promise<void> => {
    const typed = rootInput.trim();
    if (envLocked || !typed || typed === setup?.workspaceRoot.path) {
      setStep(2);
      return;
    }
    setSaving(true);
    setRootError(null);
    try {
      const state = await api.saveRoot(typed);
      setSetup(state);
      setRootInput(state.workspaceRoot.path ?? '');
      setRootCheck(state.workspaceRoot.check);
      setBrowse(null);
      setStep(2);
    } catch (error) {
      setRootError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const finish = async (): Promise<void> => {
    setFinishError(null);
    try {
      await api.completeSetup();
      finished.current = true;
      onClose();
    } catch (error) {
      setFinishError(errorMessage(error));
    }
  };

  const next = (): void => {
    if (step === 1) void saveRootAndContinue();
    else if (step === LAST_STEP) void finish();
    else setStep(step + 1);
  };

  const askNotifications = (): void => {
    const Ctor = (globalThis as unknown as { Notification?: { requestPermission(): Promise<string> } }).Notification;
    if (!Ctor) return;
    Ctor.requestPermission().then(
      (result) => {
        setPermission(result);
        if (result === 'granted') notifyOs(NOTIFICATIONS_ON, () => window.focus());
      },
      () => undefined,
    );
  };

  const current = WIZARD_STEPS[step] ?? WIZARD_STEPS[0]!;
  const line = rootLine(rootInput.trim() ? rootCheck : null);
  const notice = notificationState(permission);
  const warnAt = setup?.warnAtPct ?? 90;

  return (
    <div className="sb-overlay" data-modal="setup-wizard">
      <div className="sb-modal-wizard" role="dialog" aria-modal="true" aria-label="Set up Switchboard" data-testid="modal-setup-wizard" data-step={step}>
        <div className="sb-wz-rail">
          <div className="sb-wz-brand">
            <div className="sb-wz-logo">S</div>
            <div className="sb-wz-brand-name">Set up Switchboard</div>
          </div>
          {railItems(step).map((item, index) => (
            <div
              key={item.label}
              className="sb-wz-step"
              role="button"
              tabIndex={0}
              data-testid="wz-rail-step"
              data-state={item.state}
              aria-current={item.state === 'current' ? 'step' : undefined}
              onClick={() => setStep(index)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') setStep(index);
              }}
            >
              <span className="sb-wz-dot">{item.mark}</span>
              <span className="sb-wz-step-label">{item.label}</span>
            </div>
          ))}
          <div className="sb-wz-note">Everything stays on this PC. Switchboard never stores your Claude login.</div>
        </div>

        <div className="sb-wz-main">
          <div className="sb-wz-pos" data-testid="wz-pos">
            {stepPosition(step)}
          </div>
          <div className="sb-wz-title" data-testid="wz-title">
            {current.title}
          </div>
          <div className="sb-wz-text" data-testid="wz-text">
            {current.text}
          </div>

          {step === 0 && <ChecksStep system={system} error={systemError} />}

          {step === 1 && (
            <>
              <div className="sb-wz-root">
                <input
                  className="sb-wz-field"
                  data-testid="wz-root-input"
                  value={rootInput}
                  readOnly={envLocked}
                  spellCheck={false}
                  placeholder="Folder with your router AGENTS.md"
                  aria-label="Workspace root"
                  onChange={(event) => {
                    setRootInput(event.target.value);
                    setRootError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveRootAndContinue();
                  }}
                />
                {!envLocked && (
                  <button type="button" className="sb-button sb-wz-browse" data-testid="wz-browse" onClick={toggleBrowse}>
                    Browse…
                  </button>
                )}
              </div>
              {line && (
                <div className="sb-wz-root-line" data-testid="wz-root-line" data-ok={String(line.ok)}>
                  {line.text}
                </div>
              )}
              {envLocked && (
                <div className="sb-wz-muted" data-testid="wz-root-env">
                  set by SWITCHBOARD_WORKSPACE_ROOT · change it there
                </div>
              )}
              {browse && (
                <div className="sb-wz-browser" data-testid="wz-browser">
                  <div className="sb-wz-browser-path" data-testid="wz-browser-path">
                    {browse.path}
                  </div>
                  {browse.parent !== null && (
                    <button type="button" className="sb-button sb-wz-folder" data-testid="wz-folder-up" onClick={() => openFolder(browse.parent ?? undefined)}>
                      ../
                    </button>
                  )}
                  {browse.folders.map((folder) => (
                    <button key={folder.path} type="button" className="sb-button sb-wz-folder" data-testid="wz-folder" onClick={() => openFolder(folder.path)}>
                      {`${folder.name}/`}
                    </button>
                  ))}
                </div>
              )}
              {rootError && (
                <div className="sb-wz-error" data-testid="wz-root-error">
                  {`Not saved: ${rootError}`}
                </div>
              )}
            </>
          )}

          {step === 2 && <ScanStep groups={groups} error={scanError} />}

          {step === 3 && (
            <div className="sb-wz-notify">
              <button type="button" className="sb-button sb-wz-primary" data-testid="wz-allow-notifications" onClick={askNotifications}>
                Allow notifications
              </button>
              <span className="sb-wz-permission" data-testid="wz-permission" data-tone={notice.tone}>
                {notice.text}
              </span>
            </div>
          )}

          {step === 4 && (
            <div className="sb-wz-usage" data-testid="wz-usage">
              <div className="sb-wz-usage-row">
                Warn at<span className="sb-wz-usage-value">{`${warnAt}%`}</span>
              </div>
              <div className="sb-wz-usage-track">
                <div className="sb-wz-usage-fill" style={{ width: `${warnAt}%` }} />
              </div>
              <div className="sb-wz-usage-note">near limit → just warn</div>
            </div>
          )}

          {finishError && (
            <div className="sb-wz-error" data-testid="wz-finish-error">
              {`Not finished: ${finishError}`}
            </div>
          )}

          <div className="sb-wz-actions">
            <button type="button" className="sb-button sb-wz-back" data-testid="wz-back" onClick={() => setStep(Math.max(0, step - 1))}>
              Back
            </button>
            <button type="button" className="sb-button sb-wz-skip" data-testid="wz-skip" onClick={onClose}>
              Skip
            </button>
            <button type="button" className="sb-button sb-wz-next" data-testid="wz-next" disabled={saving} onClick={next}>
              {nextLabel(step)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
