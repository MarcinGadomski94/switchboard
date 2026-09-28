import path from 'node:path';

/** Absolute path of the fake opener's entry script. */
export const FAKE_OPENER_ENTRY = path.join(import.meta.dirname, 'main.ts');

/**
 * The argv prefix that starts the fake opener on every OS: `[<this node>, <abs
 * path>/tools/fake-opener/main.ts]`. The real opener's argv follows it.
 */
export function fakeOpenerCommand(): string[] {
  return [process.execPath, FAKE_OPENER_ENTRY];
}

/** {@link fakeOpenerCommand} as a `SWITCHBOARD_OPEN_COMMAND` value (a JSON array). */
export function fakeOpenerEnv(): string {
  return JSON.stringify(fakeOpenerCommand());
}
