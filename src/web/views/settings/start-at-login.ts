import type { LoginServiceStatus } from '../../../core/login-service.ts';

/**
 * Copy and rules of the "Start at login" toggle (M9.1, `docs/service.md`), kept
 * pure for tests. The row's label and description are the prototype's
 * (`rowsClaude`); the value is `on` / `off` like the prototype's `r.v`.
 */

/** Row label (prototype). */
export const START_AT_LOGIN_LABEL = 'Start at login';

/** Row description (prototype, verbatim). */
export const START_AT_LOGIN_DESCRIPTION = 'Launch the service when you sign in (Windows / macOS)';

/** What the value shows and whether a click can change it. */
export interface ToggleView {
  readonly text: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  /** Hover text. */
  readonly title: string;
}

/** Input of {@link toggleView}. */
export interface ToggleState {
  /** The last status (`GET` or the last `PUT`), `null` until there is one. */
  readonly status: LoginServiceStatus | null;
  /** HTTP status of a failed load (501 = not available in this build), `null` when none. */
  readonly loadError: number | null;
  /** A change is in flight. */
  readonly busy: boolean;
}

/**
 * `on` / `off` once the status is known; `…` while loading; `unavailable` (501),
 * `unknown` (any other load error) and `not supported` (no service manager on
 * this OS) cannot be clicked. Never guessed.
 */
export function toggleView(state: ToggleState): ToggleView {
  const { status } = state;
  if (!status) {
    if (state.loadError === 501) return { text: 'unavailable', checked: false, disabled: true, title: 'Not available in this build' };
    if (state.loadError !== null) return { text: 'unknown', checked: false, disabled: true, title: 'The service did not answer' };
    return { text: '…', checked: false, disabled: true, title: 'Loading' };
  }
  if (status.manager === null) return { text: 'not supported', checked: false, disabled: true, title: 'This OS has no supported per-user service manager' };
  return {
    text: status.startAtLogin ? 'on' : 'off',
    checked: status.startAtLogin,
    disabled: state.busy,
    title: status.startAtLogin && status.file ? `Registered: ${status.file} · click to turn off` : 'Click to turn on',
  };
}

/** The message under the value after a failed change: the service's own `message`, else a fixed line. */
export function changeErrorText(body: unknown): string {
  if (typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>)['message'] === 'string') {
    const message = ((body as Record<string, unknown>)['message'] as string).trim();
    if (message) return message;
  }
  return 'Start at login could not be changed.';
}
