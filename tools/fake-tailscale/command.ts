import path from 'node:path';

/** Absolute path of the fake Tailscale CLI's entry script. */
export const FAKE_TAILSCALE_ENTRY = path.join(import.meta.dirname, 'main.ts');

/** The argv prefix that starts the fake Tailscale CLI on every OS: `[<this node>, <abs path>/tools/fake-tailscale/main.ts]`. */
export function fakeTailscaleCommand(): string[] {
  return [process.execPath, FAKE_TAILSCALE_ENTRY];
}

/** {@link fakeTailscaleCommand} as a `SWITCHBOARD_TAILSCALE_BIN` value (a JSON array). */
export function fakeTailscaleBinEnv(): string {
  return JSON.stringify(fakeTailscaleCommand());
}
