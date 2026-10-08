import { access } from 'node:fs/promises';
import { failureText, runCommand, succeeded } from '../exec.ts';
import { MAC_APP_CLI } from '../peers/tailscale.ts';

/**
 * D73 (`docs/devices.md` → *Transport*): what Switchboard asks the Tailscale CLI
 * for device access: `tailscale status --json` (this machine's MagicDNS name and
 * whether the tailnet has HTTPS certificates), `tailscale serve status --json`
 * (whether the HTTPS port is already served by something else) and `tailscale
 * serve --bg --https=<port> http://127.0.0.1:<devicePort>` / `… off`. Always
 * spawned with `shell: false`; tests use `tools/fake-tailscale`.
 */

/** What `tailscale status --json` tells device access. */
export interface TailscaleStatus {
  /** `Running` when signed in and connected. */
  readonly backendState: string | null;
  /** This machine's MagicDNS name without the trailing dot (`devbox.example-tailnet.ts.net`), `null` without MagicDNS. */
  readonly dnsName: string | null;
  /** The names the tailnet can issue HTTPS certificates for (empty: HTTPS certificates are off). */
  readonly certDomains: readonly string[];
  readonly magicDns: boolean;
}

/** One failed CLI call: what it said and a Tailscale page it named (e.g. "To enable, visit: …"). */
export interface TailscaleFailure {
  readonly message: string;
  readonly actionUrl: string | null;
}

/** Options of the CLI calls. */
export interface TailscaleCallOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** The argv prefixes to try: the configured one, and the macOS app's CLI when the default is not on PATH. */
async function candidates(command: readonly string[]): Promise<(readonly string[])[]> {
  const list: (readonly string[])[] = [command];
  if (command.length === 1 && command[0] === 'tailscale' && process.platform === 'darwin') {
    try {
      await access(MAC_APP_CLI);
      list.push([MAC_APP_CLI]);
    } catch {
      // Not installed as the app.
    }
  }
  return list;
}

/** Runs the CLI with `args` (first candidate that starts); the last result. */
async function run(options: TailscaleCallOptions, args: readonly string[], timeoutMs: number) {
  let last = null as Awaited<ReturnType<typeof runCommand>> | null;
  for (const candidate of await candidates(options.command)) {
    last = await runCommand(candidate, args, { cwd: options.cwd, ...(options.env ? { env: options.env } : {}), timeoutMs, maxOutputBytes: 1024 * 1024 });
    // Not found / not startable: try the next one; anything else is the answer.
    if (last.error === null || !/ENOENT|EACCES/.test(last.error.message)) return last;
  }
  return last as Awaited<ReturnType<typeof runCommand>>;
}

/** The first `https://login.tailscale.com/…` (or other tailscale.com) URL in `text`. */
export function tailscaleActionUrl(text: string): string | null {
  const match = /https:\/\/(?:login\.)?tailscale\.com\/[^\s"'<>]+/.exec(text);
  return match ? match[0] : null;
}

/** Parses `tailscale status --json`; `null` when it is not that. */
export function parseTailscaleStatus(text: string): TailscaleStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const self = (typeof record['Self'] === 'object' && record['Self'] !== null ? record['Self'] : {}) as Record<string, unknown>;
  const tailnet = (typeof record['CurrentTailnet'] === 'object' && record['CurrentTailnet'] !== null ? record['CurrentTailnet'] : {}) as Record<string, unknown>;
  const rawName = typeof self['DNSName'] === 'string' ? self['DNSName'].trim().replace(/\.$/, '').toLowerCase() : '';
  const certDomains = Array.isArray(record['CertDomains'])
    ? (record['CertDomains'] as unknown[]).filter((d): d is string => typeof d === 'string' && d.length > 0).map((d) => d.toLowerCase())
    : [];
  return {
    backendState: typeof record['BackendState'] === 'string' ? record['BackendState'] : null,
    dnsName: /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(rawName) ? rawName : null,
    certDomains,
    magicDns: tailnet['MagicDNSEnabled'] === true,
  };
}

/** `tailscale status --json`, or why not. */
export async function tailscaleStatus(options: TailscaleCallOptions): Promise<TailscaleStatus | TailscaleFailure> {
  const result = await run(options, ['status', '--json'], 15_000);
  if (!succeeded(result)) {
    const text = failureText(result);
    return { message: `tailscale status failed: ${text}`, actionUrl: tailscaleActionUrl(text) };
  }
  return parseTailscaleStatus(result.stdout) ?? { message: 'tailscale status --json printed something unexpected', actionUrl: null };
}

/**
 * Whether `httpsPort` is already served by something other than `target`
 * (`tailscale serve status --json`: `TCP.<port>` exists and its web handlers do
 * not all proxy to `target`). A status that cannot be read counts as free.
 */
export function servedByOther(statusJson: string, httpsPort: number, target: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusJson);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  const tcp = (record['TCP'] ?? {}) as Record<string, unknown>;
  if (typeof tcp !== 'object' || tcp === null || !(String(httpsPort) in tcp)) return false;
  const web = (record['Web'] ?? {}) as Record<string, unknown>;
  const entries = Object.entries(typeof web === 'object' && web !== null ? web : {}).filter(([hostPort]) => hostPort.endsWith(`:${httpsPort}`));
  if (entries.length === 0) return true;
  for (const [, value] of entries) {
    const handlers = ((value as Record<string, unknown> | null)?.['Handlers'] ?? {}) as Record<string, unknown>;
    for (const handler of Object.values(handlers)) {
      const proxy = (handler as Record<string, unknown> | null)?.['Proxy'];
      if (typeof proxy !== 'string' || proxy.replace(/\/$/, '') !== target) return true;
    }
  }
  return false;
}

/** `tailscale serve status --json` (raw text), `null` when it fails. */
export async function serveStatus(options: TailscaleCallOptions): Promise<string | null> {
  const result = await run(options, ['serve', 'status', '--json'], 15_000);
  return succeeded(result) ? result.stdout : null;
}

/** `tailscale serve --bg --https=<httpsPort> <target>`: `null` on success, else what went wrong. */
export async function serveOn(options: TailscaleCallOptions, httpsPort: number, target: string): Promise<TailscaleFailure | null> {
  // `--yes` is not passed: a first-time consent (Serve not enabled on the tailnet) prints a link and fails within the time limit.
  const result = await run(options, ['serve', '--bg', `--https=${httpsPort}`, target], 20_000);
  if (succeeded(result)) return null;
  const text = `${result.stdout}\n${result.stderr}`.trim() || failureText(result);
  return { message: `tailscale serve failed: ${text.slice(0, 600)}`, actionUrl: tailscaleActionUrl(text) };
}

/** `tailscale serve --https=<httpsPort> off`: `null` on success, else what went wrong. */
export async function serveOff(options: TailscaleCallOptions, httpsPort: number): Promise<TailscaleFailure | null> {
  const result = await run(options, ['serve', `--https=${httpsPort}`, 'off'], 15_000);
  if (succeeded(result)) return null;
  const text = failureText(result);
  return { message: `tailscale serve off failed: ${text.slice(0, 600)}`, actionUrl: tailscaleActionUrl(text) };
}

/** `true` for a {@link TailscaleFailure}. */
export function isTailscaleFailure(value: TailscaleStatus | TailscaleFailure): value is TailscaleFailure {
  return 'message' in value;
}
