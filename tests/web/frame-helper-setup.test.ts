import { describe, expect, it } from 'vitest';
import {
  OPEN_EXTENSIONS_FALLBACK,
  SETUP_POLL_MS,
  compareVersions,
  frameHelperSetupStatus,
  isSafariUserAgent,
  openErrorMessage,
  pasteHint,
  revealLabel,
  setupPlatform,
  setupStatusText,
} from '../../src/web/tools/frame-helper-setup.ts';

/** D35: the guided frame-helper setup's status logic and copy (src/web/tools/frame-helper-setup.ts, docs/frame-helper.md → Guided setup). */

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1';
const EDGE_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0';
const HEADLESS_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36';

describe('frameHelperSetupStatus', () => {
  it('absent: no marker on the page ("Not detected yet")', () => {
    const status = frameHelperSetupStatus({ marker: null, expected: '2.0.0', safari: false });
    expect(status).toEqual({ kind: 'absent' });
    expect(setupStatusText(status)).toBe('Not detected yet');
    // Before the manifest version is known too.
    expect(frameHelperSetupStatus({ marker: null, expected: null, safari: false })).toEqual({ kind: 'absent' });
  });

  it('current: the marker is at least the manifest version ("Frame helper 2.0.0 is on ✓")', () => {
    const status = frameHelperSetupStatus({ marker: '2.0.0', expected: '2.0.0', safari: false });
    expect(status).toEqual({ kind: 'on', version: '2.0.0' });
    expect(setupStatusText(status)).toBe('Frame helper 2.0.0 is on ✓');
    // Newer than the checkout (a pulled branch behind the loaded helper) counts as on.
    expect(frameHelperSetupStatus({ marker: '2.1.0', expected: '2.0.0', safari: false })).toEqual({ kind: 'on', version: '2.1.0' });
    // Chrome's shorter forms compare part by part (a missing part is 0).
    expect(frameHelperSetupStatus({ marker: '2.0', expected: '2.0.0', safari: false }).kind).toBe('on');
    // Until the manifest version is known, any marker counts as on.
    expect(frameHelperSetupStatus({ marker: '1.0.0', expected: null, safari: false })).toEqual({ kind: 'on', version: '1.0.0' });
  });

  it('older: the marker is older than the manifest, or not a version ("press reload on it")', () => {
    const status = frameHelperSetupStatus({ marker: '1.0.0', expected: '2.0.0', safari: false });
    expect(status).toEqual({ kind: 'older', version: '1.0.0', expected: '2.0.0' });
    expect(setupStatusText(status)).toBe('An older frame helper (1.0.0) is on: press reload on it in chrome://extensions');
    expect(frameHelperSetupStatus({ marker: '1.9.9', expected: '2.0.0', safari: false }).kind).toBe('older');
    expect(frameHelperSetupStatus({ marker: '2.0.0', expected: '2.0.1', safari: false }).kind).toBe('older');
    // marker.js writes `unknown` where the engine has no getManifest(): it cannot be confirmed current.
    expect(frameHelperSetupStatus({ marker: 'unknown', expected: '2.0.0', safari: false })).toEqual({ kind: 'older', version: 'unknown', expected: '2.0.0' });
  });

  it('Safari: the Safari line whatever the marker says (no steps)', () => {
    for (const marker of [null, '2.0.0', '1.0.0']) {
      const status = frameHelperSetupStatus({ marker, expected: '2.0.0', safari: true });
      expect(status).toEqual({ kind: 'safari' });
      expect(setupStatusText(status)).toBe("Safari can't frame signed-in sites; they open in a new tab");
    }
  });
});

describe('compareVersions', () => {
  it('compares dotted versions part by part; anything else is null', () => {
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('2.0.0', '2.0')).toBe(0);
    expect(compareVersions('2.0.10', '2.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.99.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('unknown', '2.0.0')).toBeNull();
    expect(compareVersions('2.0.0', '')).toBeNull();
    expect(compareVersions('2.0.0-beta', '2.0.0')).toBeNull();
  });
});

describe('isSafariUserAgent', () => {
  it('Safari on macOS and iOS; not Chrome (headless too), Chrome on iOS, Edge or Firefox', () => {
    expect(isSafariUserAgent(SAFARI_MAC)).toBe(true);
    expect(isSafariUserAgent(SAFARI_IOS)).toBe(true);
    expect(isSafariUserAgent(CHROME_MAC)).toBe(false);
    expect(isSafariUserAgent(CHROME_IOS)).toBe(false);
    expect(isSafariUserAgent(EDGE_WIN)).toBe(false);
    expect(isSafariUserAgent(FIREFOX_LINUX)).toBe(false);
    expect(isSafariUserAgent(HEADLESS_CHROME)).toBe(false);
  });
});

describe('labels by platform', () => {
  it('the OS family from navigator.platform, else the user agent', () => {
    expect(setupPlatform('MacIntel', CHROME_MAC)).toBe('mac');
    expect(setupPlatform('Win32', EDGE_WIN)).toBe('windows');
    expect(setupPlatform('Linux x86_64', FIREFOX_LINUX)).toBe('other');
    expect(setupPlatform('', CHROME_MAC)).toBe('mac');
    expect(setupPlatform('', EDGE_WIN)).toBe('windows');
    expect(setupPlatform('', FIREFOX_LINUX)).toBe('other');
  });

  it('Reveal in Finder / File Explorer / the folder, and how to paste the path in the folder dialog', () => {
    expect(revealLabel('mac')).toBe('Reveal in Finder');
    expect(revealLabel('windows')).toBe('Reveal in File Explorer');
    expect(revealLabel('other')).toBe('Open the folder');
    expect(pasteHint('mac')).toBe('In the file dialog press ⌘⇧G and paste');
    expect(pasteHint('windows')).toBe('In the file dialog paste it into the Folder field');
    expect(pasteHint('other')).toBe('In the file dialog press Ctrl+L and paste');
  });
});

describe('failures and polling', () => {
  it('reads the opener error of a 502 body; the Open-extensions fallback says to type the address', () => {
    expect(openErrorMessage({ error: 'open-failed', message: ' open -a Google Chrome chrome://extensions: exit code 1 ' })).toBe(
      'open -a Google Chrome chrome://extensions: exit code 1',
    );
    expect(openErrorMessage({ error: 'open-failed' })).toBeNull();
    expect(openErrorMessage('Bad Gateway')).toBeNull();
    expect(openErrorMessage(null)).toBeNull();
    expect(OPEN_EXTENSIONS_FALLBACK).toContain('type chrome://extensions in the address bar');
  });

  it('the open panel re-reads the marker every 2 s', () => {
    expect(SETUP_POLL_MS).toBe(2_000);
  });
});
