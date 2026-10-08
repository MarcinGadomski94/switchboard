#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

/**
 * tools/fake-tailscale: a stand-in for the Tailscale CLI so tests never call the
 * real `tailscale` (D48, `docs/peers.md` → *Tests*; D73, `docs/devices.md` →
 * *Tests*). Started through an argv prefix (`command.ts` →
 * `fakeTailscaleCommand()`, the `SWITCHBOARD_TAILSCALE_BIN` JSON-array form).
 *
 * - `tailscale ip -4` → `FAKE_TAILSCALE_IP` (default `127.0.0.1`, which the peer
 *   listener accepts only with `SWITCHBOARD_PEER_TEST_LOOPBACK=1`), exit 0;
 *   `FAKE_TAILSCALE_IP=none` → `no current Tailscale IPs; state: Stopped` on
 *   stderr, exit 1.
 * - D73 `tailscale status --json` → a status for `devbox.example-tailnet.ts.net`
 *   (Running, MagicDNS on, HTTPS certificates on). `FAKE_TAILSCALE_HTTPS=off` →
 *   no `CertDomains`; `FAKE_TAILSCALE_STATE=<state>` → that `BackendState`;
 *   `FAKE_TAILSCALE_STATUS=fail` → exit 1.
 * - D73 `tailscale serve status --json` → `FAKE_TAILSCALE_SERVE_STATUS` (JSON
 *   text), default `{}`.
 * - D73 `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` and
 *   `tailscale serve --https=<port> off` → exit 0; `FAKE_TAILSCALE_SERVE=consent`
 *   → the "Serve is not enabled on your tailnet" text with a link, exit 1.
 * - `FAKE_TAILSCALE_LOG=<file>`: every call's argv is appended to it (one JSON
 *   line). A separate short-lived process: its one synchronous write is fine.
 * - anything else → `unknown command`, exit 1.
 */
const args = process.argv.slice(2);
const env = process.env;
if (env['FAKE_TAILSCALE_LOG']) appendFileSync(env['FAKE_TAILSCALE_LOG'], `${JSON.stringify(args)}\n`);

if (args[0] === 'ip' && args[1] === '-4' && args.length === 2) {
  const ip = env['FAKE_TAILSCALE_IP'] ?? '127.0.0.1';
  if (ip === 'none') {
    process.stderr.write('no current Tailscale IPs; state: Stopped\n');
    process.exit(1);
  }
  process.stdout.write(`${ip}\n`);
  process.exit(0);
}

if (args[0] === 'status' && args[1] === '--json' && args.length === 2) {
  if (env['FAKE_TAILSCALE_STATUS'] === 'fail') {
    process.stderr.write("failed to connect to local tailscaled; it doesn't appear to be running\n");
    process.exit(1);
  }
  const name = 'devbox.example-tailnet.ts.net';
  const status = {
    Version: '1.90.0-fake',
    BackendState: env['FAKE_TAILSCALE_STATE'] ?? 'Running',
    Self: { HostName: 'devbox', DNSName: `${name}.`, TailscaleIPs: ['100.101.102.103'] },
    CertDomains: env['FAKE_TAILSCALE_HTTPS'] === 'off' ? null : [name],
    MagicDNSSuffix: 'example-tailnet.ts.net',
    CurrentTailnet: { Name: 'example', MagicDNSSuffix: 'example-tailnet.ts.net', MagicDNSEnabled: true },
  };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exit(0);
}

if (args[0] === 'serve') {
  if (args[1] === 'status' && args[2] === '--json' && args.length === 3) {
    process.stdout.write(`${env['FAKE_TAILSCALE_SERVE_STATUS'] ?? '{}'}\n`);
    process.exit(0);
  }
  const https = args.find((arg) => /^--https=\d+$/.test(arg));
  const last = args.at(-1) ?? '';
  const off = last === 'off' && args.length === 3;
  const on = args.length === 4 && args[1] === '--bg' && /^http:\/\/127\.0\.0\.1:\d+$/.test(last);
  if (https && (off || on)) {
    if (on && env['FAKE_TAILSCALE_SERVE'] === 'consent') {
      process.stdout.write('Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=fake123\n\n');
      process.exit(1);
    }
    if (on) process.stdout.write(`Available within your tailnet:\n\nhttps://devbox.example-tailnet.ts.net:${https.slice('--https='.length)}/\n|-- proxy ${last}\n\nServe started and running in the background.\n`);
    process.exit(0);
  }
}

process.stderr.write(`fake-tailscale: unknown command ${JSON.stringify(args)}\n`);
process.exit(1);
