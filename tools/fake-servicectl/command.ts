import path from 'node:path';

/** Absolute path of the fake service manager's entry script. */
export const FAKE_SERVICECTL_ENTRY = path.join(import.meta.dirname, 'main.ts');

/**
 * The argv prefix that starts the fake launchctl / systemctl / schtasks on every
 * OS: `[<this node>, <abs path>/tools/fake-servicectl/main.ts]`.
 */
export function fakeServiceCtlCommand(): string[] {
  return [process.execPath, FAKE_SERVICECTL_ENTRY];
}

/** {@link fakeServiceCtlCommand} as a `SWITCHBOARD_SERVICE_CTL` value (a JSON array). */
export function fakeServiceCtlEnv(): string {
  return JSON.stringify(fakeServiceCtlCommand());
}
