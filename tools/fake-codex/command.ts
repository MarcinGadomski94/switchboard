import path from 'node:path';

/** Absolute path of the fake Codex CLI's entry script. */
export const FAKE_CODEX_ENTRY = path.join(import.meta.dirname, 'main.ts');

/** The argv prefix that starts the fake (`[<this node>, <abs>/tools/fake-codex/main.ts]`); spawn with `shell: false`. */
export function fakeCodexCommand(): string[] {
  return [process.execPath, FAKE_CODEX_ENTRY];
}

/** {@link fakeCodexCommand} as a `SWITCHBOARD_CODEX_BIN` value (a JSON array). */
export function fakeCodexBinEnv(): string {
  return JSON.stringify(fakeCodexCommand());
}
