import { useEffect, useSyncExternalStore } from 'react';
import { FRAME_CHECK_ATTRIBUTE, FRAME_CHECK_PATH, FRAME_HELPER_ATTRIBUTE } from '../../core/site-tools.ts';
import { CHECK_TIMEOUT_MS, type FrameHelperEnvironment, type FrameHelperState, readFrameHelperMarker, watchFrameHelper } from './frame-helper.ts';

/*
 * D28: the frame helper watch (`frame-helper.ts`) on this page: the `<html>`
 * marker, a MutationObserver, timers and the hidden capability-check frame.
 */

/**
 * Loads {@link FRAME_CHECK_PATH} in a hidden frame of `doc` and resolves `true` when
 * its page shows (same origin, so its `<html>` is readable): the helper removed its
 * `X-Frame-Options` / CSP. A refused frame (an error page, a blank one, or no `load`
 * within `timeoutMs`) resolves `false`. The frame is removed either way.
 */
export function checkFraming(doc: Document, timeoutMs: number = CHECK_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const frame = doc.createElement('iframe');
    frame.hidden = true;
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('data-testid', 'frame-helper-check');
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      frame.remove();
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    frame.addEventListener('load', () => {
      let ok = false;
      try {
        ok = frame.contentDocument?.documentElement?.getAttribute(FRAME_CHECK_ATTRIBUTE) === 'ok';
      } catch {
        ok = false;
      }
      finish(ok);
    });
    frame.src = FRAME_CHECK_PATH;
    doc.body.append(frame);
  });
}

/** The {@link FrameHelperEnvironment} of this page. */
function pageEnvironment(): FrameHelperEnvironment {
  return {
    readMarker: () => readFrameHelperMarker(document.documentElement),
    observeMarker(onChange) {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: [FRAME_HELPER_ATTRIBUTE] });
      return () => observer.disconnect();
    },
    setTimer(run, ms) {
      const id = window.setTimeout(run, ms);
      return () => window.clearTimeout(id);
    },
    checkFraming: () => checkFraming(document),
  };
}

let current: FrameHelperState = { status: 'checking', version: null };
let started = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The frame helper's state for this page. The watch (and its one capability check)
 * starts the first time a caller passes `enabled` (a site tool's view) and lasts for
 * the page's lifetime; until then the state reads `checking`.
 */
export function useFrameHelper(enabled: boolean): FrameHelperState {
  useEffect(() => {
    if (!enabled || started) return;
    started = true;
    watchFrameHelper(pageEnvironment(), (state) => {
      current = state;
      for (const listener of listeners) listener();
    });
  }, [enabled]);
  return useSyncExternalStore(subscribe, () => current);
}
