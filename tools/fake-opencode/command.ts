import path from 'node:path';

/** Absolute path of the fake OpenCode CLI's entry script. */
export const FAKE_OPENCODE_ENTRY = path.join(import.meta.dirname, 'main.ts');

/** The argv prefix that starts the fake (`[<this node>, <abs>/tools/fake-opencode/main.ts]`); spawn with `shell: false`. */
export function fakeOpencodeCommand(): string[] {
  return [process.execPath, FAKE_OPENCODE_ENTRY];
}

/** {@link fakeOpencodeCommand} as a `SWITCHBOARD_OPENCODE_BIN` value (a JSON array). */
export function fakeOpencodeBinEnv(): string {
  return JSON.stringify(fakeOpencodeCommand());
}
