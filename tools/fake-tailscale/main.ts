#!/usr/bin/env node
/**
 * tools/fake-tailscale: a stand-in for the Tailscale CLI so tests never call the
 * real `tailscale` (D48, `docs/peers.md` → *Tests*). Started through an argv
 * prefix (`command.ts` → `fakeTailscaleCommand()`, the `SWITCHBOARD_TAILSCALE_BIN`
 * JSON-array form).
 *
 * - `tailscale ip -4` → `FAKE_TAILSCALE_IP` (default `127.0.0.1`, which the peer
 *   listener accepts only with `SWITCHBOARD_PEER_TEST_LOOPBACK=1`), exit 0;
 *   `FAKE_TAILSCALE_IP=none` → `no current Tailscale IPs; state: Stopped` on
 *   stderr, exit 1.
 * - anything else → `unknown command`, exit 1.
 */
const args = process.argv.slice(2);
if (args[0] === 'ip' && args[1] === '-4' && args.length === 2) {
  const ip = process.env['FAKE_TAILSCALE_IP'] ?? '127.0.0.1';
  if (ip === 'none') {
    process.stderr.write('no current Tailscale IPs; state: Stopped\n');
    process.exit(1);
  }
  process.stdout.write(`${ip}\n`);
  process.exit(0);
}
process.stderr.write(`fake-tailscale: unknown command ${JSON.stringify(args)}\n`);
process.exit(1);
