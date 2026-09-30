import path from 'node:path';

/** Absolute path of the fake npm's entry script. */
export const FAKE_NPM_ENTRY = path.join(import.meta.dirname, 'main.ts');

/** The argv prefix that starts the fake npm on every OS: `[<this node>, <abs path>/tools/fake-npm/main.ts]`. */
export function fakeNpmCommand(): string[] {
  return [process.execPath, FAKE_NPM_ENTRY];
}

/** {@link fakeNpmCommand} as a `SWITCHBOARD_NPM_BIN` value (a JSON array). */
export function fakeNpmBinEnv(): string {
  return JSON.stringify(fakeNpmCommand());
}
