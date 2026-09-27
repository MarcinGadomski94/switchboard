import path from 'node:path';
import { defaultDataDir } from '../config.ts';
import type { Store } from '../db/store.ts';
import type { Providers } from '../providers.ts';
import { loadDemoData } from './data.ts';
import { createDemoProviders } from './providers.ts';
import { DemoSeedError, type SeedDemoResult, seedDemo } from './seed.ts';

export { DemoSeedError } from './seed.ts';

/** What {@link startDemo} returns to main.ts. */
export interface DemoStart {
  readonly providers: Providers;
  readonly seed: SeedDemoResult;
}

/**
 * Refuses demo mode on the per-user app-data folder (the real database and token).
 * main.ts calls it before it opens anything.
 */
export function assertDemoDataDir(dataDir: string, realDataDir: string = defaultDataDir()): void {
  if (path.resolve(dataDir) === path.resolve(realDataDir)) {
    throw new DemoSeedError('SWITCHBOARD_DEMO=1 needs SWITCHBOARD_DATA_DIR set to a throwaway folder, never the real app-data folder');
  }
}

/**
 * Demo mode (`SWITCHBOARD_DEMO=1`, gap #21): seeds the database with the
 * prototype's mock data and returns demo providers for what the database does not
 * hold. Only for the visual oracle and screenshots, so it refuses the per-user
 * app-data folder (the real database): `SWITCHBOARD_DATA_DIR` must point at a
 * throwaway folder.
 */
export async function startDemo(store: Store, dataDir: string): Promise<DemoStart> {
  assertDemoDataDir(dataDir);
  const data = await loadDemoData();
  const seed = await seedDemo(store, data);
  return { providers: createDemoProviders(data), seed };
}
