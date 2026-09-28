#!/usr/bin/env node
/**
 * tools/fake-opener: a stand-in for the OS openers of the D35 frame-helper setup
 * (`open`, `explorer`, `xdg-open`, `cmd /c start`, Chrome), so tests never open
 * Chrome, Safari, Finder or Explorer. Started through an argv prefix
 * (`command.ts` → `fakeOpenerCommand()`, the `SWITCHBOARD_OPEN_COMMAND` JSON-array
 * form): it receives the real opener's whole argv as its arguments
 * (`open -R <folder>/manifest.json`). Surface: `docs/frame-helper.md` → *Guided setup*.
 *
 * - Every call exits 0 with no output, unless:
 * - `FAKE_OPENER_FAIL=<text>`: a call whose arguments, joined by spaces, contain
 *   `<text>` prints `fake-opener: <args> failed` to stderr and exits 1 (e.g.
 *   `chrome://extensions` makes the Open-extensions step fail).
 * - `FAKE_OPENER_LOG=<file>` appends `{"argv":[…]}` per call.
 */
import { appendFile } from 'node:fs/promises';

process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const log = process.env['FAKE_OPENER_LOG'];
  if (log) await appendFile(log, `${JSON.stringify({ argv: args })}\n`);
  const fail = process.env['FAKE_OPENER_FAIL'];
  if (fail && args.join(' ').includes(fail)) {
    await new Promise<void>((resolve) => process.stderr.write(`fake-opener: ${args.join(' ')} failed\n`, () => resolve()));
    process.exit(1);
  }
  process.exit(0);
}

void main();
