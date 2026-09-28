import { useEffect, useState } from 'react';
import type { FrameHelperInfo } from '../../core/api.ts';
import { ApiError, api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import {
  type FrameHelperSetupStatus,
  OPEN_EXTENSIONS_FALLBACK,
  REVEAL_FALLBACK,
  type SetupPlatform,
  frameHelperSetupStatus,
  isSafariUserAgent,
  openErrorMessage,
  pasteHint,
  revealLabel,
  setupPlatform,
  setupStatusText,
} from './frame-helper-setup.ts';
import { useFrameHelperMarker } from './useFrameHelper.ts';
import './frame-helper-setup.css';

/** How long "Copied" shows after a copy (ms). */
const COPIED_MS = 1500;

/** The guided setup's live state (D35). */
export interface FrameHelperSetupState {
  /** The checkout's helper folder and version (`GET /api/frame-helper`); `null` until loaded. */
  readonly info: FrameHelperInfo | null;
  readonly status: FrameHelperSetupStatus;
  /** The OS family the labels follow. */
  readonly platform: SetupPlatform;
}

/**
 * D35: the setup's state on this page: the checkout's folder and version, and the
 * status from the helper's marker, re-read every 2 s while `open` (the panel shows).
 */
export function useFrameHelperSetup(open: boolean): FrameHelperSetupState {
  const info = useApi(api.frameHelper);
  const marker = useFrameHelperMarker(open);
  const safari = isSafariUserAgent(navigator.userAgent);
  return {
    info: info.data,
    status: frameHelperSetupStatus({ marker, expected: info.data?.version ?? null, safari }),
    platform: setupPlatform(navigator.platform, navigator.userAgent),
  };
}

/** The status line ("Frame helper 2.0.0 is on ✓", "Not detected yet", …), colored by its state. */
export function FrameHelperStatusLine({ status }: { readonly status: FrameHelperSetupStatus }) {
  return (
    <span className="sb-fh-status" data-testid="frame-helper-status" data-status={status.kind}>
      {setupStatusText(status)}
    </span>
  );
}

/** A step's button state: idle, running, done or failed with the service's message. */
type Run = { readonly state: 'idle' | 'busy' | 'done' } | { readonly state: 'failed'; readonly message: string };

/** Calls `call` and tracks it as a {@link Run}. */
function useRun(call: () => Promise<unknown>): [Run, () => void] {
  const [run, setRun] = useState<Run>({ state: 'idle' });
  const start = (): void => {
    setRun({ state: 'busy' });
    call().then(
      () => setRun({ state: 'done' }),
      (error: unknown) => setRun({ state: 'failed', message: (error instanceof ApiError ? openErrorMessage(error.body) : null) ?? (error instanceof Error ? error.message : 'failed') }),
    );
  };
  return [run, start];
}

/**
 * D35 (`docs/frame-helper.md` → *Guided setup*): the guided setup panel, used by
 * Settings → Embedded tools → Frame helper and by a site tool's "needs the frame
 * helper" page. Chrome never lets a page install an extension, so the developer
 * still clicks "Load unpacked" once; each step around it has its button:
 * 1. Open Chrome's extensions page (the service runs the OS opener; on failure,
 *    type chrome://extensions);
 * 2. Turn on Developer mode (a hint);
 * 3. Load unpacked: Reveal in Finder (Explorer / the file manager) and Copy path,
 *    with how to paste it in the folder dialog;
 * 4. Reload this tab: Chrome adds the helper's marker only to pages loaded after it.
 * `showStatus` puts the status line on top (the Settings row shows its own). In
 * Safari there are no steps: only the status line.
 */
export function FrameHelperSetupPanel({ setup, showStatus }: { readonly setup: FrameHelperSetupState; readonly showStatus: boolean }) {
  const { info, status, platform } = setup;
  const [extensions, openExtensions] = useRun(api.openChromeExtensions);
  const [reveal, revealFolder] = useRun(api.revealFrameHelper);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (copy !== 'copied') return undefined;
    const timer = setTimeout(() => setCopy('idle'), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copy]);

  const copyPath = async (): Promise<void> => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.path);
      setCopy('copied');
    } catch {
      // No clipboard access: the path stays selectable above the buttons.
      setCopy('failed');
    }
  };

  return (
    <div className="sb-fh-panel" data-testid="frame-helper-setup" data-status={status.kind}>
      {showStatus ? (
        <div className="sb-fh-panel-status">
          <FrameHelperStatusLine status={status} />
        </div>
      ) : null}
      {status.kind === 'safari' ? null : (
        <ol className="sb-fh-steps">
          <li className="sb-fh-step" data-step="extensions">
            <span className="sb-fh-num">1</span>
            <div className="sb-fh-body">
              <div className="sb-fh-text">Open Chrome's extensions page</div>
              {extensions.state === 'failed' ? (
                <div className="sb-fh-note" data-kind="error" role="alert" data-testid="frame-helper-extensions-error" title={extensions.message}>
                  {OPEN_EXTENSIONS_FALLBACK}
                </div>
              ) : null}
            </div>
            <div className="sb-fh-actions">
              <button
                type="button"
                className="sb-button sb-fh-button"
                data-testid="frame-helper-open-extensions"
                aria-busy={extensions.state === 'busy'}
                disabled={extensions.state === 'busy'}
                onClick={openExtensions}
              >
                Open extensions
              </button>
            </div>
          </li>
          <li className="sb-fh-step" data-step="developer-mode">
            <span className="sb-fh-num">2</span>
            <div className="sb-fh-body">
              <div className="sb-fh-text">
                Turn on <b>Developer mode</b> (top right)
              </div>
            </div>
          </li>
          <li className="sb-fh-step" data-step="load-unpacked">
            <span className="sb-fh-num">3</span>
            <div className="sb-fh-body">
              <div className="sb-fh-text">
                Click <b>Load unpacked</b> and pick the folder
              </div>
              <div className="sb-fh-path" data-testid="frame-helper-path" title={info?.path ?? ''}>
                {info?.path ?? '…'}
              </div>
              <div className="sb-fh-actions">
                <button
                  type="button"
                  className="sb-button sb-fh-button"
                  data-testid="frame-helper-reveal"
                  aria-busy={reveal.state === 'busy'}
                  disabled={reveal.state === 'busy'}
                  onClick={revealFolder}
                >
                  {revealLabel(platform)}
                </button>
                <button type="button" className="sb-button sb-fh-button" data-testid="frame-helper-copy" disabled={!info} onClick={() => void copyPath()}>
                  {copy === 'copied' ? 'Copied' : 'Copy path'}
                </button>
              </div>
              {reveal.state === 'failed' ? (
                <div className="sb-fh-note" data-kind="error" role="alert" data-testid="frame-helper-reveal-error" title={reveal.message}>
                  {REVEAL_FALLBACK}
                </div>
              ) : null}
              {copy === 'failed' ? (
                <div className="sb-fh-note" data-kind="error" role="alert" data-testid="frame-helper-copy-error">
                  Could not copy: select the path and copy it.
                </div>
              ) : null}
              <div className="sb-fh-note" data-testid="frame-helper-paste-hint">
                {pasteHint(platform)}
              </div>
            </div>
          </li>
          <li className="sb-fh-step" data-step="reload">
            <span className="sb-fh-num">4</span>
            <div className="sb-fh-body">
              <div className="sb-fh-text">Reload this tab</div>
              <div className="sb-fh-note">Chrome adds the helper to pages opened after it loads.</div>
            </div>
            <div className="sb-fh-actions">
              <button type="button" className="sb-button sb-fh-button" data-testid="frame-helper-reload" onClick={() => window.location.reload()}>
                Reload tab
              </button>
            </div>
          </li>
        </ol>
      )}
    </div>
  );
}
