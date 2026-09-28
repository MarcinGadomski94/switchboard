import path from 'node:path';

/** Absolute path of the fake GitHub CLI's entry script. */
export const FAKE_GH_ENTRY = path.join(import.meta.dirname, 'main.ts');

/**
 * The argv prefix that starts the fake gh on every OS: `[<this node>, <abs
 * path>/tools/fake-gh/main.ts]`. Spawn it with `shell: false` like the real CLI.
 */
export function fakeGhCommand(): string[] {
  return [process.execPath, FAKE_GH_ENTRY];
}

/** {@link fakeGhCommand} as a `SWITCHBOARD_GH_BIN` value (a JSON array, `docs/configuration.md`). */
export function fakeGhBinEnv(): string {
  return JSON.stringify(fakeGhCommand());
}
