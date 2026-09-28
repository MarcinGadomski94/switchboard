/**
 * D35 (`docs/frame-helper.md` → *Guided setup*): the logic and copy of the guided
 * frame-helper setup (the Settings → Embedded tools row and the Tool view's "Set
 * up frame helper" panel), kept pure for tests: no DOM, the page passes its
 * marker, user agent and platform in. The panel lives in `FrameHelperSetup.tsx`.
 */

/** How often the open panel re-reads the helper's marker (ms). */
export const SETUP_POLL_MS = 2_000;

/** What the setup's status line says. */
export type FrameHelperSetupStatus =
  /** Safari: its extensions cannot remove response headers (D28 ruling), so sites open in a new tab; no steps. */
  | { readonly kind: 'safari' }
  /** The marker's version is at least the checkout's manifest version. */
  | { readonly kind: 'on'; readonly version: string }
  /** A helper older than the checkout's (or one whose version is unreadable) is loaded: reload it in chrome://extensions. */
  | { readonly kind: 'older'; readonly version: string; readonly expected: string }
  /** No marker on this page (yet). */
  | { readonly kind: 'absent' };

/** Input of {@link frameHelperSetupStatus}. */
export interface SetupStatusInput {
  /** The page's marker (`data-sb-frame-helper`), `null` when there is none. */
  readonly marker: string | null;
  /** The checkout's `manifest.json` version (`GET /api/frame-helper`); `null` until known. */
  readonly expected: string | null;
  /** The page runs in Safari ({@link isSafariUserAgent}). */
  readonly safari: boolean;
}

/** A dotted version of numbers (`2`, `2.0`, `2.0.0`, `2.0.0.1`: Chrome's manifest form). */
function versionParts(version: string): number[] | null {
  const text = version.trim();
  if (!/^\d+(\.\d+){0,3}$/.test(text)) return null;
  return text.split('.').map(Number);
}

/**
 * Compares two dotted versions part by part (a missing part is 0): negative when
 * `a` is older, 0 when equal, positive when newer; `null` when either is not a
 * dotted version.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = versionParts(a);
  const right = versionParts(b);
  if (left === null || right === null) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The status line's state: Safari first (whatever the marker); no marker →
 * `absent`; a marker at least the manifest's version → `on`; an older one, or one
 * that is not a version (`unknown`) → `older`. Until the manifest version is known
 * any marker counts as `on`.
 */
export function frameHelperSetupStatus(input: SetupStatusInput): FrameHelperSetupStatus {
  if (input.safari) return { kind: 'safari' };
  const { marker, expected } = input;
  if (marker === null) return { kind: 'absent' };
  if (expected === null || versionParts(expected) === null) return { kind: 'on', version: marker };
  const order = compareVersions(marker, expected);
  return order !== null && order >= 0 ? { kind: 'on', version: marker } : { kind: 'older', version: marker, expected };
}

/** The status line's text. */
export function setupStatusText(status: FrameHelperSetupStatus): string {
  switch (status.kind) {
    case 'on':
      return `Frame helper ${status.version} is on ✓`;
    case 'older':
      return `An older frame helper (${status.version}) is on: press reload on it in chrome://extensions`;
    case 'absent':
      return 'Not detected yet';
    case 'safari':
      return "Safari can't frame signed-in sites; they open in a new tab";
  }
}

/**
 * `true` for Safari (macOS, iOS; WebKit browsers that call themselves Safari): its
 * user agent names `Safari/` and none of the Chromium or Firefox tokens every
 * other browser adds next to it (anywhere in a word: `HeadlessChrome/`).
 */
export function isSafariUserAgent(userAgent: string): boolean {
  return /\bSafari\//.test(userAgent) && !/(Chrome|Chromium|CriOS|FxiOS|Firefox|Edg|EdgA|EdgiOS|OPR|Android)\//.test(userAgent);
}

/** The OS family the labels follow (the service runs on this machine: loopback only). */
export type SetupPlatform = 'mac' | 'windows' | 'other';

/** The OS family from `navigator.platform` (e.g. `MacIntel`, `Win32`, `Linux x86_64`), else the user agent. */
export function setupPlatform(navigatorPlatform: string, userAgent: string): SetupPlatform {
  if (/^mac/i.test(navigatorPlatform)) return 'mac';
  if (/^win/i.test(navigatorPlatform)) return 'windows';
  if (navigatorPlatform.trim() !== '') return 'other';
  if (/Mac OS X|Macintosh/.test(userAgent)) return 'mac';
  if (/Windows/.test(userAgent)) return 'windows';
  return 'other';
}

/** The label of the button that shows the folder (`POST /api/frame-helper/reveal`). */
export function revealLabel(platform: SetupPlatform): string {
  if (platform === 'mac') return 'Reveal in Finder';
  if (platform === 'windows') return 'Reveal in File Explorer';
  return 'Open the folder';
}

/** How to use the copied path in Chrome's "Load unpacked" folder dialog. */
export function pasteHint(platform: SetupPlatform): string {
  if (platform === 'mac') return 'In the file dialog press ⌘⇧G and paste';
  if (platform === 'windows') return 'In the file dialog paste it into the Folder field';
  return 'In the file dialog press Ctrl+L and paste';
}

/** Shown when the service could not open Chrome's extensions page (502). */
export const OPEN_EXTENSIONS_FALLBACK = 'Chrome did not open: type chrome://extensions in the address bar';

/** Shown when the service could not open the folder (502): the path can still be copied. */
export const REVEAL_FALLBACK = 'The folder did not open: copy the path instead';

/** The opener's error of a 502 body (`{ error: "open-failed", message }`), else `null`. */
export function openErrorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const message = (body as Record<string, unknown>)['message'];
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : null;
}
