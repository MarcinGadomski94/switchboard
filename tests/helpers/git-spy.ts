#!/usr/bin/env node
/**
 * A logging wrapper around the real `git` for tests: appends
 * `{"argv":[…],"cwd":"…"}` to `GIT_SPY_LOG`, then runs `git` with the same
 * arguments (shell: false) and exits with its code. Tests pass
 * `[process.execPath, <this file>]` as the worktree manager's git command to
 * prove what it ran (and what it never ran: stash, reset, checkout, --force).
 */
import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
const log = process.env['GIT_SPY_LOG'];
if (log) await appendFile(log, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
const child = spawn('git', argv, { stdio: 'inherit', shell: false });
child.on('error', () => process.exit(127));
child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
