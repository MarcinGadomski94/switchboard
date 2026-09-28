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
  process.exit(0);
}

void main();
