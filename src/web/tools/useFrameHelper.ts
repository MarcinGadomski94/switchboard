import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { Tool } from '../../core/api.ts';
import { FRAME_CHECK_ATTRIBUTE, FRAME_CHECK_PATH, FRAME_HELPER_ATTRIBUTE, frameHelperHosts } from '../../core/site-tools.ts';
import {
  CHECK_TIMEOUT_MS,
  type FrameHelperEnvironment,
  type FrameHelperSites,
  type FrameHelperState,
  createSitesSync,
  readFrameHelperMarker,
  watchFrameHelper,
} from './frame-helper.ts';
import { SETUP_POLL_MS } from './frame-helper-setup.ts';

/*
 * D28: the frame helper watch (`frame-helper.ts`) on this page: the `<html>`
 * marker, a MutationObserver, timers, the hidden capability-check frame, and the
 * host list the page gives the helper for its tab (`window.postMessage`).
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

/** This page's host list for the helper (one per page). */
const sites = createSitesSync({
  post: (message) => window.postMessage(message, window.location.origin),
  setTimer(run, ms) {
    const id = window.setTimeout(run, ms);
    return () => window.clearTimeout(id);
  },
});

let listening = false;

/** Listens (once) for the helper's answers, and sends the list again after a back/forward-cache restore. */
function listenToHelper(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (event) => {
    // Only this window itself (the helper's content script posts here); never a framed tool.
    if (event.source === window && event.origin === window.location.origin) sites.receive(event.data);
  });
  window.addEventListener('pageshow', (event) => {
    // The helper drops a tab's rules when it leaves Switchboard; a restored page asks again.
    if (event.persisted) sites.resend();
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
    sitesSettled() {
      // A list sent before the helper's content script listened (a late marker) got no answer: send it again.
      const state = sites.state();
      if (!state.answered && !state.pending) sites.resend();
      return sites.settled();
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

/**
 * D28 ruling (narrowed scope): gives the frame helper this page's host list,
 * {@link frameHelperHosts} of `tools` (the saved site tools' hosts, after this
 * page's own host for the capability check), whenever `tools` loads or changes
 * (`null` = not loaded yet: nothing is sent), and returns what the helper confirmed
 * for this tab. The helper keeps them as rules for this tab only. Sent in a layout
 * effect, so a view never paints a state from before its list went out.
 */
export function useFrameHelperSites(tools: readonly Pick<Tool, 'url'>[] | null): FrameHelperSites {
  const hosts = tools === null ? null : frameHelperHosts(tools.map((tool) => tool.url), window.location.hostname);
  const key = hosts === null ? null : hosts.join(' ');
  useLayoutEffect(() => {
    listenToHelper();
    if (hosts !== null) sites.send(hosts);
    // `key` stands for `hosts` (a new array on every render).
  }, [key]);
  return useSyncExternalStore(sites.subscribe, sites.state);
}

/**
 * D35 (guided setup): the helper's marker on this page (its version, `null`
 * without one), live: read on mount, on every change of the `<html>` attribute,
 * and every `pollMs` while `poll` is on (the setup panel is open). Unlike
 * {@link useFrameHelper} it runs no capability check.
 */
export function useFrameHelperMarker(poll: boolean, pollMs: number = SETUP_POLL_MS): string | null {
  const [marker, setMarker] = useState<string | null>(() => readFrameHelperMarker(document.documentElement));
  useEffect(() => {
    const read = (): void => setMarker(readFrameHelperMarker(document.documentElement));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [FRAME_HELPER_ATTRIBUTE] });
    const timer = poll ? window.setInterval(read, pollMs) : undefined;
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [poll, pollMs]);
  return marker;
}
