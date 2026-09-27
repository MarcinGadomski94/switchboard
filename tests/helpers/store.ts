import path from 'node:path';
import { type OpenStoreOptions, type Store, openStore } from '../../src/server/db/store.ts';

/** Opens a store on `<dir>/switchboard.db` (always a temp folder in tests). */
export function openTempStore(dir: string, options: OpenStoreOptions = {}): Promise<Store> {
  return openStore(path.join(dir, 'switchboard.db'), options);
}
