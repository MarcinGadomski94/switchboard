/**
 * The "Install as app" row of Settings → Claude Code (D34, `docs/install-app.md`),
 * kept pure for tests: which form it takes and its copy.
 */

/** Row label. */
export const INSTALL_APP_LABEL = 'Install as app';

/** Row description. */
export const INSTALL_APP_DESCRIPTION = 'Open Switchboard in its own window, from the Dock or the taskbar';

/** The button, which opens the browser's install dialog. */
export const INSTALL_APP_ACTION = 'Install';

/** Safari's one-line hint (it has no install event; the menu item is Safari's own). */
export const SAFARI_INSTALL_HINT = 'Install: File → Add to Dock…';

/** `install` = the row with its button; `safari-hint` = the one-line hint; `none` = nothing. */
export type InstallRowForm = 'install' | 'safari-hint' | 'none';

/** Input of {@link installRowForm}. */
export interface InstallRowState {
  /** The browser offers installation right now (a kept `beforeinstallprompt`). */
  readonly offered: boolean;
  /** Switchboard already runs as an installed app (`display-mode: standalone`). */
  readonly standalone: boolean;
  /** `navigator.userAgent`. */
  readonly userAgent: string;
}

/**
 * Nothing in an installed app; the button while the browser offers installation;
 * in Safari (which never offers it) the hint; nothing anywhere else (another
 * browser, or Chrome when the app is already installed and so offers nothing).
 */
export function installRowForm(state: InstallRowState): InstallRowForm {
  if (state.standalone) return 'none';
  if (state.offered) return 'install';
  return isSafari(state.userAgent) ? 'safari-hint' : 'none';
}

/**
 * `true` for Safari: its user agent has `Safari/` and none of the tokens that the
 * browsers built on Chromium, Firefox or WebKit shells add next to it (Chrome,
 * `HeadlessChrome` included, Chromium, Edge, Opera, and the iOS wrappers).
 */
export function isSafari(userAgent: string): boolean {
  return /\bSafari\//.test(userAgent) && !/(?:Chrome|Chromium|CriOS|Edg|EdgA|EdgiOS|OPR|FxiOS|Firefox)\//.test(userAgent);
}
