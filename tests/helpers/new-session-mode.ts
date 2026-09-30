import type { Page } from '@playwright/test';
import type { NewSessionMode } from '../../src/core/settings.ts';
import { openTempStore } from './store.ts';

/**
 * D56: the New-session dialog opens in the remembered mode (`newSession.mode`,
 * Simple on a fresh install). Specs that exercise the Full form remember `full`
 * before they open it, as a developer who switched once would have: either in
 * the data folder before the server starts ({@link rememberNewSessionModeInDataDir})
 * or through `PUT /api/settings` from a page of a running app
 * ({@link rememberNewSessionMode}).
 */
export async function rememberNewSessionModeInDataDir(dataDir: string, mode: NewSessionMode): Promise<void> {
  const store = await openTempStore(dataDir);
  try {
    await store.settings.set('newSession.mode', mode);
  } finally {
    await store.close();
  }
}

/** {@link rememberNewSessionModeInDataDir} for a running app, from one of its pages (same origin, the sb_token cookie). */
export async function rememberNewSessionMode(page: Page, mode: NewSessionMode): Promise<void> {
  const status = await page.evaluate(async (value) => {
    const response = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'newSession.mode': value }) });
    return response.status;
  }, mode);
  if (status !== 200) throw new Error(`PUT /api/settings newSession.mode answered ${status}`);
}
