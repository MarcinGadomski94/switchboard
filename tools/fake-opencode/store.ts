import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Json = Record<string, unknown>;

/** One stored message (`{info, parts}`, the shape `GET /session/:id/message` and `opencode export` answer). */
export interface StoredMessage {
  readonly info: Json;
  readonly parts: Json[];
}

/** What the fake keeps between servers (the real CLI keeps it in SQLite: `opencode.db`). */
export interface FakeStore {
  sessions: Json[];
  messages: Record<string, StoredMessage[]>;
  mcp: Record<string, Json>;
}

/** `$XDG_DATA_HOME/opencode/fake-store.json`, `null` without `XDG_DATA_HOME` (nothing is kept; the fake never touches the home folder). */
export function storeFile(env: NodeJS.ProcessEnv): string | null {
  const data = env['XDG_DATA_HOME'];
  return data && data.trim() !== '' ? path.join(data, 'opencode', 'fake-store.json') : null;
}

export async function loadStore(env: NodeJS.ProcessEnv): Promise<FakeStore> {
  const file = storeFile(env);
  if (file) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<FakeStore>;
      return { sessions: parsed.sessions ?? [], messages: parsed.messages ?? {}, mcp: parsed.mcp ?? {} };
    } catch {
      // A missing or broken file starts empty.
    }
  }
  return { sessions: [], messages: {}, mcp: {} };
}

let writes: Promise<void> = Promise.resolve();

export function saveStore(env: NodeJS.ProcessEnv, store: FakeStore): Promise<void> {
  const file = storeFile(env);
  if (!file) return Promise.resolve();
  const text = JSON.stringify(store);
  writes = writes.then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  });
  return writes;
}
