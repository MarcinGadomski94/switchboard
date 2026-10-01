#!/usr/bin/env node
/**
 * tools/fake-opencode: a stand-in for the OpenCode CLI (`1.18.34`) with the
 * surface Switchboard uses (D62, `docs/providers.md`, `docs/fake-opencode.md`).
 * The shapes model the source read at `v1.18.34`; the real CLI was never run.
 */
import { runCli } from './cli.ts';

process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

void runCli(process.argv.slice(2)).then(
  (code) => {
    if (code !== null) process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(`fake-opencode: ${String(error)}\n`, () => process.exit(1));
  },
);
