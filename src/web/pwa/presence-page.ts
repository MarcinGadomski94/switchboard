import type { DevicePresenceInput } from '../../core/devices.ts';
import { PresenceReporter, pageClientId } from './presence.ts';

/**
 * D87 (`docs/devices.md` → *No notifications while Switchboard is open*): wires
 * {@link PresenceReporter} to this page (`presence.ts` has the rules).
 */

let reporter: PresenceReporter | null = null;

/** Sends a report to the server (errors ignored: the next report or the lapse corrects it). */
function sendReport(report: DevicePresenceInput, leaving: boolean): void {
  void fetch('/api/device/presence', {
    method: 'PUT',
    credentials: 'same-origin',
    keepalive: leaving,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(report),
  }).catch(() => undefined);
}

/** Starts reporting this page's presence (once; the web entry calls it). */
export function startPresence(): void {
  if (reporter || typeof document === 'undefined') return;
  const current = new PresenceReporter(
    {
      visible: () => document.visibilityState === 'visible',
      focused: () => document.hasFocus(),
      send: sendReport,
      every: (run, ms) => {
        const timer = setInterval(run, ms);
        return () => clearInterval(timer);
      },
    },
    pageClientId(),
  );
  reporter = current;
  document.addEventListener('visibilitychange', () => current.report());
  window.addEventListener('focus', () => current.report());
  window.addEventListener('blur', () => current.report());
  window.addEventListener('pageshow', () => current.report(true));
  window.addEventListener('pagehide', () => current.leave());
  current.report(true);
}

/** The hub stream (re)opened: the server forgot the page's stream meanwhile, so report again. */
export function presenceHubOpened(): void {
  reporter?.report(true);
}
