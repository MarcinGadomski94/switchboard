import { type InstallPromptStore, createInstallPromptStore } from './install-prompt.ts';

/**
 * The app's install offer (D34, `docs/install-app.md`), kept from `window`.
 * Listening starts when this module is first evaluated: the web entry imports it
 * ahead of rendering, so a `beforeinstallprompt` that comes before Settings is
 * open is kept too.
 */
export const appInstallPrompt: InstallPromptStore = createInstallPromptStore(window);
