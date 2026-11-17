#!/usr/bin/env node
/**
 * D168 · `switchboard backup` / `switchboard restore` (`docs/backup.md` → *From the terminal*):
 *
 *   node tools/backup/cli.ts backup  [--out <file or folder>] [--passphrase-env <VAR>]
 *   node tools/backup/cli.ts restore <file> [--map <old>=<new>]... [--identity keep|new]
 *                                    [--passphrase-env <VAR>] [--force] [--allow-missing]
 *
 * (`npm run backup` / `npm run restore -- …` in the app folder, or `npx @marcingadomski94/switchboard
 * backup|restore …`.) The passphrase is never an argument: it is read from the named environment
 * variable, else asked for (hidden). A restore needs Switchboard stopped; it restores into a fresh
 * install (`--force`: over this one, whose data is kept aside first).
 */
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { backupFileName, parseMapArgument, type PathMap, type RestoreReport } from '../../src/core/backup.ts';
import { createBackup } from '../../src/server/backup/archive.ts';
import { BackupCryptoError, DEFAULT_KDF, newKey, passphraseKey } from '../../src/server/backup/crypto.ts';
import { RestoreError, applyRestore, prepareRestore } from '../../src/server/backup/restore.ts';
import { loadConfig } from '../../src/server/config.ts';
import { defaultSecretStore } from '../../src/server/team/access/secret-store.ts';
import { appVersion } from '../../src/server/updates/wire.ts';

const APP_DIR = path.resolve(import.meta.dirname, '..', '..');

const USAGE = `Usage:
  switchboard backup  [--out <file or folder>] [--passphrase-env <VAR>]
  switchboard restore <file> [--map <old path>=<new path>]... [--identity keep|new]
                      [--passphrase-env <VAR>] [--force] [--allow-missing]

backup   Writes an encrypted backup of everything (agents, folders, projects, crews, tasks,
         artifacts, settings, accounts, the agents' conversations, keychain values).
         Default: ~/SwitchboardBackups/switchboard-backup-<time>.sbbackup
restore  Restores a backup into this computer's Switchboard (stop it first). Folders that do
         not exist here need a --map; --identity keep takes over the old computer's identity
         (pairings and phones keep working: only when the old one is retired), new starts as
         a new computer (re-pair).
The passphrase is read from the variable --passphrase-env names, else asked for.`;

interface Args {
  readonly command: 'backup' | 'restore' | 'help';
  readonly file: string | null;
  readonly out: string | null;
  readonly maps: PathMap[];
  readonly identity: 'keep' | 'new' | null;
  readonly passphraseEnv: string | null;
  readonly force: boolean;
  readonly allowMissing: boolean;
}

/** Reads the arguments (after the command name); a string is the problem. */
export function parseArgs(argv: readonly string[]): Args | string {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') return { command: 'help', file: null, out: null, maps: [], identity: null, passphraseEnv: null, force: false, allowMissing: false };
  if (command !== 'backup' && command !== 'restore') return `unknown command ${command}`;
  let file: string | null = null;
  let out: string | null = null;
  const maps: PathMap[] = [];
  let identity: 'keep' | 'new' | null = null;
  let passphraseEnv: string | null = null;
  let force = false;
  let allowMissing = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const value = (): string => {
      const next = rest[++i];
      if (next === undefined || next === '') throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      if (arg === '--out' && command === 'backup') out = value();
      else if (arg === '--map' && command === 'restore') {
        const map = parseMapArgument(value());
        if (!map) return '--map takes <old path>=<new path>';
        maps.push(map);
      } else if (arg === '--identity' && command === 'restore') {
        const v = value();
        if (v !== 'keep' && v !== 'new') return '--identity is keep or new';
        identity = v;
      } else if (arg === '--passphrase-env') passphraseEnv = value();
      else if (arg === '--force' && command === 'restore') force = true;
      else if (arg === '--allow-missing' && command === 'restore') allowMissing = true;
      else if (arg === '--passphrase' || arg.startsWith('--passphrase=')) return 'the passphrase is never an argument: use --passphrase-env <VAR> or type it when asked';
      else if (!arg.startsWith('-') && command === 'restore' && file === null) file = arg;
      else return `unknown option ${arg}`;
    } catch (error) {
      return (error as Error).message;
    }
  }
  if (command === 'restore' && !file) return 'restore needs the backup file';
  return { command, file, out, maps, identity, passphraseEnv, force, allowMissing };
}

/** Asks a question; `hidden` does not echo what is typed. */
function ask(question: string, hidden = false): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    muted = hidden;
  });
}

async function passphrase(args: Args, confirm: boolean): Promise<string> {
  if (args.passphraseEnv) {
    const value = process.env[args.passphraseEnv];
    if (!value) throw new Error(`${args.passphraseEnv} is not set`);
    return value;
  }
  if (!process.stdin.isTTY) throw new Error('no terminal to ask the passphrase in: use --passphrase-env <VAR>');
  const first = await ask('Passphrase: ', true);
  if (confirm) {
    if (first.length < 8) throw new Error('use a passphrase of at least 8 characters');
    const again = await ask('Passphrase again: ', true);
    if (again !== first) throw new Error('the two passphrases differ');
  }
  return first;
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function printReport(report: RestoreReport): void {
  console.log(`Restored ${report.agents} agent${report.agents === 1 ? '' : 's'} and ${report.folders} folder${report.folders === 1 ? '' : 's'} from ${report.fromMachine ?? 'the backup'} (Switchboard ${report.fromVersion}).`);
  console.log(`  ${report.remapped} stored path${report.remapped === 1 ? '' : 's'} mapped onto this computer; ${report.conversations} conversation${report.conversations === 1 ? '' : 's'} placed${report.conversationsMissing ? `, ${report.conversationsMissing} missing` : ''}; ${report.secrets} keychain value${report.secrets === 1 ? '' : 's'} written.`);
  if (report.previousData) console.log(`  The data that was here is kept in ${report.previousData}`);
  for (const line of report.todo) console.log(`  · ${line}`);
}

/** Runs the CLI; answers the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    console.error(`switchboard ${argv[0] ?? ''}: ${args}\n\n${USAGE}`);
    return 2;
  }
  if (args.command === 'help') {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig();
  const version = await appVersion(APP_DIR).catch(() => '0.0.0');
  const home = os.homedir();
  try {
    if (args.command === 'backup') {
      const folderDefault = path.join(home, 'SwitchboardBackups');
      let out = args.out ? path.resolve(args.out) : path.join(folderDefault, backupFileName(new Date()));
      const isDir = await stat(out).then((info) => info.isDirectory()).catch(() => false);
      if (isDir || (args.out && /[\\/]$/.test(args.out))) out = path.join(out, backupFileName(new Date()));
      const key = await newKey(await passphrase(args, true), DEFAULT_KDF);
      try {
        console.log(`Backing up ${config.dataDir} …`);
        const result = await createBackup({ dataDir: config.dataDir, env: process.env, home, version, secrets: defaultSecretStore() }, out, key);
        const mb = (result.size / 1024 / 1024).toFixed(1);
        console.log(`Wrote ${result.file} (${mb} MB): ${result.preview.counts.agents} agents, ${result.preview.counts.folders} folders, ${result.preview.conversations.length} conversations, ${result.preview.counts.secrets} keychain values.`);
        if (result.skippedLinks > 0) console.log(`  ${result.skippedLinks} linked file${result.skippedLinks === 1 ? '' : 's'} (an account's shared settings) left out: Settings → Accounts links them again.`);
        console.log('Keep the passphrase: the backup cannot be opened without it.');
      } finally {
        key.key.fill(0);
      }
      return 0;
    }
    const file = path.resolve(args.file as string);
    if (await listening(config.port)) {
      console.error(`switchboard restore: Switchboard is running on port ${config.port}. Stop it first (or restore from Settings → Backup).`);
      return 1;
    }
    let identity = args.identity;
    if (!identity) {
      if (!process.stdin.isTTY) throw new Error('choose --identity keep (take over the old computer: only when it is retired) or --identity new (a new computer: re-pair)');
      const answer = (await ask('Take over the old computer\'s identity (pairings and phones keep working; only when the old one is retired)? [y/N] ')).trim().toLowerCase();
      identity = answer === 'y' || answer === 'yes' ? 'keep' : 'new';
    }
    const target = { dataDir: config.dataDir, env: process.env, home, version, secrets: defaultSecretStore() };
    const staging = path.join(config.dataDir, `.restore-staging-${randomBytes(4).toString('hex')}`);
    console.log(`Reading ${file} …`);
    try {
      await prepareRestore(file, passphraseKey(await passphrase(args, false)), target, { maps: args.maps, identity, replace: args.force, allowMissing: args.allowMissing }, staging);
    } catch (error) {
      const { rm } = await import('node:fs/promises');
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof RestoreError && error.code === 'missing-folders') {
        console.error(`switchboard restore: ${error.message}:`);
        for (const missing of error.detail as Array<{ from: string; to: string }>) console.error(`  ${missing.from}   (add --map "${missing.from}=<folder on this computer>")`);
        console.error('Or restore with --allow-missing: those folders stay saved, marked missing.');
        return 1;
      }
      throw error;
    }
    printReport(await applyRestore(staging, target));
    console.log('Start Switchboard to use it.');
    return 0;
  } catch (error) {
    const message = error instanceof BackupCryptoError || error instanceof RestoreError ? error.message : error instanceof Error ? error.message : String(error);
    console.error(`switchboard ${args.command}: ${message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exitCode = await main(process.argv.slice(2));
}
