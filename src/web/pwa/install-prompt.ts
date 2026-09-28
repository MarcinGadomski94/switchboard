/**
 * Chrome's install offer (D34, `docs/install-app.md`). Chrome (and Edge) fire
 * `beforeinstallprompt` once the page is installable and not installed yet. The
 * event is kept, its default UI suppressed, so Settings → Claude Code →
 * **Install as app** can open the browser's install dialog later (`prompt()`).
 * The app's store is `appInstallPrompt` (`app-install.ts`), which starts
 * listening before React mounts, so an early event is not missed. Safari has no
 * such event (Settings shows a hint there instead). No DOM globals here, so tests
 * drive it with a plain `EventTarget`.
 */

/** The part of Chrome's `BeforeInstallPromptEvent` Switchboard uses (not in TypeScript's DOM lib). */
export interface InstallPromptEvent extends Event {
  /** Opens the browser's install dialog; allowed once per event. */
  prompt(): Promise<unknown>;
  /** Settles with the answer to that dialog. */
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

/** How {@link InstallPromptStore.install} ended: the dialog's answer, or `unavailable` when there was no offer (or it failed). */
export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

/** The kept install offer, for `useSyncExternalStore`. */
export interface InstallPromptStore {
  /** The kept event, `null` while the browser offers no installation. */
  current(): InstallPromptEvent | null;
  /** Calls `listener` whenever {@link current} changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Opens the install dialog. An event is good for one dialog, so the offer is used up either way. */
  install(): Promise<InstallOutcome>;
}

function isInstallPromptEvent(event: Event): event is InstallPromptEvent {
  const candidate = event as Partial<InstallPromptEvent>;
  return typeof candidate.prompt === 'function' && candidate.userChoice instanceof Promise;
}

/**
 * Listens on `target` (the window) for the install offer: keeps each
 * `beforeinstallprompt` (and prevents its default), drops it on `appinstalled`.
 */
export function createInstallPromptStore(target: EventTarget): InstallPromptStore {
  let kept: InstallPromptEvent | null = null;
  const listeners = new Set<() => void>();
  const set = (next: InstallPromptEvent | null): void => {
    kept = next;
    for (const listener of [...listeners]) listener();
  };
  target.addEventListener('beforeinstallprompt', (event) => {
    if (!isInstallPromptEvent(event)) return;
    event.preventDefault();
    set(event);
  });
  target.addEventListener('appinstalled', () => set(null));
  return {
    current: () => kept,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async install() {
      const event = kept;
      if (!event) return 'unavailable';
      set(null);
      try {
        await event.prompt();
        return (await event.userChoice).outcome;
      } catch (error) {
        console.warn('Switchboard: the install dialog could not open', error);
        return 'unavailable';
      }
    },
  };
}
