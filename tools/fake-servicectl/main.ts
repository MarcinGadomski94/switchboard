#!/usr/bin/env node
/**
 * tools/fake-servicectl: a stand-in for `launchctl`, `systemctl` and `schtasks`,
 * so tests never register anything with the real service manager (D12: nothing
 * is installed on the developer's machine). Started through an argv prefix
 * (`command.ts` → `fakeServiceCtlCommand()`, the `SWITCHBOARD_SERVICE_CTL`
 * JSON-array form, `docs/service.md` → *Test redirects*).
 *
 * - Every call exits 0 with no output, unless:
 * - `FAKE_SERVICECTL_FAIL=<text>`: a call whose arguments, joined by spaces,
 *   contain `<text>` prints `fake-servicectl: <args> failed` to stderr and exits 1
 *   (e.g. `print` makes `launchctl print …` answer "not loaded", `/Create` makes
 *   the task registration fail).
 * - `FAKE_SERVICECTL_LOG=<file>` appends `{"argv":[…]}` per call.
 * - `FAKE_SERVICECTL_CALLER_IS_SERVICE=1`: the caller plays the unit's main
 *   process, so `systemctl --user restart …` sends it SIGTERM before exiting 0,
 *   the way systemd stops the running service (`--no-block` does not wait for
 *   it). Without it nobody would stop a Switchboard that asked for its restart
 *   on Linux (`src/server/updates/restart.ts`); launchd and Task Scheduler
 *   restarts go through the helper, which never calls `restart`.
 */
import { appendFile } from 'node:fs/promises';

process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const log = process.env['FAKE_SERVICECTL_LOG'];
  if (log) await appendFile(log, `${JSON.stringify({ argv: args })}\n`);
  const fail = process.env['FAKE_SERVICECTL_FAIL'];
  if (fail && args.join(' ').includes(fail)) {
    await new Promise<void>((resolve) => process.stderr.write(`fake-servicectl: ${args.join(' ')} failed\n`, () => resolve()));
    process.exit(1);
  }
  if (process.env['FAKE_SERVICECTL_CALLER_IS_SERVICE'] === '1' && args[0] === '--user' && args[1] === 'restart') process.kill(process.ppid, 'SIGTERM');
  process.exit(0);
}

void main();
