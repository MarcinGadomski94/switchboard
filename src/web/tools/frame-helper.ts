import { FRAME_HELPER_ATTRIBUTE } from '../../core/site-tools.ts';

/**
 * D28 (`docs/frame-helper.md`): whether the Switchboard frame helper (the browser
 * extension in `tools/frame-helper/`) is installed in this browser and works here.
 * Its content script marks the page's `<html>` with `data-sb-frame-helper="<version>"`
 * at document_start; the marker may land slightly after the page loads (Safari), so
 * it is watched for {@link MARKER_WAIT_MS} before the helper counts as absent (and
 * still afterwards, in case it arrives late). With the marker, a hidden frame of
 * `FRAME_CHECK_PATH` (a page that refuses every frame) tells whether the helper
 * really removes frame headers in this browser (`ready`) or not (`blocked`: Safari's
 * extensions cannot modify response headers today; a Chrome helper without site access).
 * This file is the logic (no DOM, unit-tested); `useFrameHelper.ts` wires it to the page.
 */
export type FrameHelperStatus = 'checking' | 'absent' | 'blocked' | 'ready';

/** The helper's state for this page. */
export interface FrameHelperState {
  readonly status: FrameHelperStatus;
  /** The extension's version from the marker; `null` while unknown or absent. */
  readonly version: string | null;
}

/** How long the page waits for the marker before it shows "needs the frame helper". */
export const MARKER_WAIT_MS = 1_500;

/** How long the capability check frame may take before it counts as refused. */
export const CHECK_TIMEOUT_MS = 4_000;

/** The marker's version on `root` (`<html>`), or `null` when it is missing or blank. */
export function readFrameHelperMarker(root: { getAttribute(name: string): string | null } | null | undefined): string | null {
  const value = root?.getAttribute(FRAME_HELPER_ATTRIBUTE)?.trim();
  return value ? value : null;
}

/** What {@link watchFrameHelper} needs from the page: the DOM in the app, fakes in tests. */
export interface FrameHelperEnvironment {
  /** The marker's version now (see {@link readFrameHelperMarker}). */
  readMarker(): string | null;
  /** Calls `onChange` whenever the marker may have changed; returns a function that stops. */
  observeMarker(onChange: () => void): () => void;
  /** Runs `run` once after `ms`; returns a function that cancels it. */
  setTimer(run: () => void, ms: number): () => void;
  /** Resolves `true` when a frame of `FRAME_CHECK_PATH` shows in this browser. */
  checkFraming(): Promise<boolean>;
}

/**
 * Watches for the helper and reports each state change to `onState`: `checking`
 * first; `absent` when no marker arrived within `waitMs`; once a marker is seen
 * (in time or later), `checking` with its version, then `ready` or `blocked` from
 * one capability check (a failing check counts as `blocked`). Returns a function
 * that stops watching (later results are dropped).
 */
export function watchFrameHelper(env: FrameHelperEnvironment, onState: (state: FrameHelperState) => void, waitMs: number = MARKER_WAIT_MS): () => void {
  let stopped = false;
  let seen: string | null = null;
  const report = (state: FrameHelperState): void => {
    if (!stopped) onState(state);
  };
  report({ status: 'checking', version: null });
  const evaluate = (): void => {
    if (stopped || seen !== null) return;
    const version = env.readMarker();
    if (version === null) return;
    seen = version;
    report({ status: 'checking', version });
    env.checkFraming().then(
      (ok) => report({ status: ok ? 'ready' : 'blocked', version }),
      () => report({ status: 'blocked', version }),
    );
  };
  const stopObserving = env.observeMarker(evaluate);
  const cancelTimer = env.setTimer(() => {
    if (seen === null) report({ status: 'absent', version: null });
  }, waitMs);
  evaluate();
  return () => {
    stopped = true;
    stopObserving();
    cancelTimer();
  };
}
