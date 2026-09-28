import { describe, expect, it, vi } from 'vitest';
import { createInstallPromptStore } from '../../src/web/pwa/install-prompt.ts';
import {
  INSTALL_APP_ACTION,
  INSTALL_APP_LABEL,
  SAFARI_INSTALL_HINT,
  installRowForm,
  isSafari,
} from '../../src/web/views/settings/install-app.ts';

/** D34: Settings → Claude Code → Install as app (docs/install-app.md). */

const UA = {
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  headless: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.7922.34 Safari/537.36',
  edge: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
  opera: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 OPR/135.0.0.0',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/151.0.0.0 Mobile/15E148 Safari/604.1',
} as const;

describe('installRowForm', () => {
  it('shows the Install button while the browser offers installation', () => {
    expect(installRowForm({ offered: true, standalone: false, userAgent: UA.chrome })).toBe('install');
    expect(installRowForm({ offered: true, standalone: false, userAgent: UA.edge })).toBe('install');
  });

  it('shows nothing in an installed app, offered or not, Safari included', () => {
    for (const userAgent of Object.values(UA)) {
      expect(installRowForm({ offered: true, standalone: true, userAgent })).toBe('none');
      expect(installRowForm({ offered: false, standalone: true, userAgent })).toBe('none');
    }
  });

  it("shows Safari's one-line hint in Safari (it has no install event)", () => {
    expect(installRowForm({ offered: false, standalone: false, userAgent: UA.safari })).toBe('safari-hint');
  });

  it('shows nothing where the browser offers nothing (installed already, Firefox, the test Chromium)', () => {
    for (const userAgent of [UA.chrome, UA.headless, UA.edge, UA.opera, UA.firefox, UA.iosChrome]) {
      expect(installRowForm({ offered: false, standalone: false, userAgent })).toBe('none');
    }
  });
});

describe('isSafari', () => {
  it('is Safari only for Safari', () => {
    expect(isSafari(UA.safari)).toBe(true);
    for (const [name, userAgent] of Object.entries(UA)) {
      if (name !== 'safari') expect(isSafari(userAgent), name).toBe(false);
    }
  });
});

describe('copy', () => {
  it('names the row, the button and the Safari hint', () => {
    expect(INSTALL_APP_LABEL).toBe('Install as app');
    expect(INSTALL_APP_ACTION).toBe('Install');
    expect(SAFARI_INSTALL_HINT).toBe('Install: File → Add to Dock…');
  });
});

/** A `beforeinstallprompt` like Chrome's, answering the dialog with `outcome`. */
function offer(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  const prompt = vi.fn(async () => undefined);
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome, platform: 'web' }) });
  return { event, prompt };
}

describe('createInstallPromptStore', () => {
  it('keeps the offer (its default UI prevented) and tells its subscribers', () => {
    const target = new EventTarget();
    const store = createInstallPromptStore(target);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.current()).toBeNull();
    const { event } = offer();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(store.current()).toBe(event);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    target.dispatchEvent(offer().event);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores an event without prompt() / userChoice', () => {
    const target = new EventTarget();
    const store = createInstallPromptStore(target);
    target.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }));
    expect(store.current()).toBeNull();
  });

  it('install() opens the dialog once and uses the offer up, whatever the answer', async () => {
    for (const outcome of ['accepted', 'dismissed'] as const) {
      const target = new EventTarget();
      const store = createInstallPromptStore(target);
      const { event, prompt } = offer(outcome);
      target.dispatchEvent(event);
      expect(await store.install()).toBe(outcome);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(store.current()).toBeNull();
      expect(await store.install()).toBe('unavailable');
    }
  });

  it('a failing dialog reads unavailable', async () => {
    const target = new EventTarget();
    const store = createInstallPromptStore(target);
    const { event, prompt } = offer();
    prompt.mockRejectedValueOnce(new DOMException('no user gesture', 'NotAllowedError'));
    target.dispatchEvent(event);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await store.install()).toBe('unavailable');
    } finally {
      warn.mockRestore();
    }
  });

  it('drops the offer when the app gets installed', () => {
    const target = new EventTarget();
    const store = createInstallPromptStore(target);
    target.dispatchEvent(offer().event);
    target.dispatchEvent(new Event('appinstalled'));
    expect(store.current()).toBeNull();
  });
});
