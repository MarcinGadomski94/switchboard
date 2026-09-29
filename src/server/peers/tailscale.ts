import { access } from 'node:fs/promises';
import { parseIPv4 } from '../../core/peers.ts';
import { runCommand, succeeded } from '../exec.ts';

/** Where the Tailscale app keeps its CLI on macOS when `tailscale` is not on PATH. */
export const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * D48: the machine's Tailscale IPv4 from `tailscale ip -4` (the first IPv4 line),
 * `null` when the CLI is missing, fails or prints none. `command` is the configured
 * argv prefix (`SWITCHBOARD_TAILSCALE_BIN`, default `tailscale`); with the default,
 * the macOS app's own CLI is tried when `tailscale` is not on PATH. Spawned with
 * `shell: false`.
 */
export async function tailscaleIPv4(command: readonly string[], options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv }): Promise<string | null> {
  const candidates: (readonly string[])[] = [command];
  if (command.length === 1 && command[0] === 'tailscale' && process.platform === 'darwin') {
    try {
      await access(MAC_APP_CLI);
      candidates.push([MAC_APP_CLI]);
    } catch {
      // Not installed as the app.
    }
  }
  for (const candidate of candidates) {
    const result = await runCommand(candidate, ['ip', '-4'], { cwd: options.cwd, ...(options.env ? { env: options.env } : {}), timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    if (!succeeded(result)) continue;
    const line = result.stdout.split(/\r?\n/).map((part) => part.trim()).find((part) => parseIPv4(part) !== null);
    if (line) return line;
  }
  return null;
}
