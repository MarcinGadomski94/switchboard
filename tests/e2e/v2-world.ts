import type { Page } from '@playwright/test';
import { THEME_STORAGE_KEY } from '../../src/web/theme.ts';

/**
 * D131 · v2 specs (`docs/v2.md` → *Tests*). The test servers default to the
 * classic UI (`SWITCHBOARD_UI_THEME_DEFAULT=classic`, tests/helpers/server-process.ts),
 * so the specs written before v2 keep it. A v2 spec opts in either for the whole
 * server (`V2_SERVER_ENV`) or per page ({@link useV2}).
 */

/** Server env for a spec whose browsers show v2 unless they chose otherwise. */
export const V2_SERVER_ENV: Readonly<Record<string, string>> = { SWITCHBOARD_UI_THEME_DEFAULT: 'v2' };

/** Makes this page's browser choose v2 (its own choice, as Settings → Appearance stores it) before the app loads. */
export async function useV2(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    try {
      if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, 'v2');
    } catch {
      // No storage: the server's default applies.
    }
  }, THEME_STORAGE_KEY);
}

/** Marks the page's window, so a spec can tell a swap without a reload (the mark survives) from a reload. */
export async function markWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __sbMark: number }).__sbMark = 42;
  });
}

/** `true` while the window marked by {@link markWindow} is the same (no reload since). */
export async function sameWindow(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __sbMark?: number }).__sbMark === 42);
}
