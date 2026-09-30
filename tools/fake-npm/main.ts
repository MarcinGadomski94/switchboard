#!/usr/bin/env node
/**
 * tools/fake-npm: a stand-in for npm in the D55 updater's tests, so no test
 * ever installs from the registry (AGENTS.md: no network beyond loopback).
 * Started through an argv prefix (`command.ts` → `fakeNpmCommand()`, the
 * `SWITCHBOARD_NPM_BIN` JSON-array form, `docs/updates.md` → *Tests*).
 *
 * - `npm ci …` in a folder with a `package-lock.json` → writes
 *   `node_modules/.fake-npm-ci` (the arguments, one line of JSON), exit 0.
 * - No `package-lock.json` → npm's own complaint, exit 1.
 * - `FAKE_NPM_FAIL=<text>` → `<text>` on stderr, exit 1 (a failed install).
 * - `FAKE_NPM_LOG=<file>` appends `{"argv":[…],"cwd":"…"}` per call.
 * - anything else → `Unknown command`, exit 1.
 */
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => stream.write(text, () => resolve()));
}

async function finish(code: number, err = ''): Promise<never> {
  if (err) await write(process.stderr, err);
  process.exit(code);
}

async function main(): Promise<never> {
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  const log = process.env['FAKE_NPM_LOG'];
  if (log) await appendFile(log, `${JSON.stringify({ argv: args, cwd })}\n`);
  if (args[0] !== 'ci') return finish(1, `Unknown command: "${args[0] ?? ''}"\n`);
  const fail = process.env['FAKE_NPM_FAIL'];
  if (fail) return finish(1, `${fail}\n`);
  try {
    await stat(path.join(cwd, 'package-lock.json'));
  } catch {
    return finish(1, 'npm error The `npm ci` command can only install with an existing package-lock.json\n');
  }
  await mkdir(path.join(cwd, 'node_modules'), { recursive: true });
  await writeFile(path.join(cwd, 'node_modules', '.fake-npm-ci'), `${JSON.stringify(args)}\n`);
  return finish(0);
}

void main();
