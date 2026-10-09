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

/**
 * D88 ruling (2026-10-09): Cancel keeps what was typed in the New-session dialog as
 * this machine's draft, so the next opening restores it. Specs that expect a fresh
 * form clear it first (`DELETE /api/drafts/new-session`, as **Clear draft** does).
 */
export async function forgetNewSessionDraft(page: Page): Promise<void> {
  const status = await page.evaluate(async () => (await fetch('/api/drafts/new-session', { method: 'DELETE' })).status);
  if (status !== 204) throw new Error(`DELETE /api/drafts/new-session answered ${status}`);
}
