/**
 * Shared code of `tools/service/install.ts` and `tools/service/uninstall.ts`
 * (M9.1, `docs/service.md` → *Install scripts*): the per-user background service
 * from a terminal, with `--dry-run` to print every file and command without
 * writing or running anything.
 */
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type ServiceAction,
  type ServicePlatform,
  MANAGER_BIN,
  describePlan,
  displayCommand,
  installPlan,
  isServicePlatform,
  managerLabel,
  servicePaths,
  uninstallPlan,
} from '../../src/core/service-files.ts';
import { ConfigError, defaultDataDir, loadConfig } from '../../src/server/config.ts';
import { ServiceError } from '../../src/server/service/errors.ts';
import { executePlan } from '../../src/server/service/executor.ts';
import { checkNode } from '../../src/server/service/node-check.ts';
import {
  APP_DIR,
  carriedEnvironment,
  currentUid,
  loadServiceRedirect,
  serviceLocation,
  serviceTarget,
  withCleanSearchPath,
} from '../../src/server/service/target.ts';

/** Where the CLI writes. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

/** Parsed flags. */
interface Flags {
  readonly dryRun: boolean;
  readonly start: boolean;
  readonly platform: ServicePlatform | null;
  readonly help: boolean;
}

const USAGE: Readonly<Record<ServiceAction, string>> = {
  install: [
    'Usage: npm run service:install -- [--dry-run] [--start] [--platform darwin|linux|win32]',
    '',
    'Registers Switchboard as this user\'s background service, started at every sign-in:',
    'a launchd agent (macOS), a systemd --user unit (Linux) or a Task Scheduler logon task (Windows).',
    'The service runs `node src/server/main.ts` from this folder with the SWITCHBOARD_* settings of',
    'this shell (docs/service.md). Requires Node.js >= 24 on PATH.',
    '',
    '  --dry-run    print the files and commands; write and run nothing',
    '  --start      also start the service now',
    '  --platform   with --dry-run: preview another OS\'s files (with this machine\'s paths)',
  ].join('\n'),
  uninstall: [
    'Usage: npm run service:uninstall -- [--dry-run] [--platform darwin|linux|win32]',
    '',
    'Stops the background service if its service manager runs it, and removes its registration.',
    '',
    '  --dry-run    print the files and commands; remove and run nothing',
    '  --platform   with --dry-run: preview another OS\'s steps',
  ].join('\n'),
};

class UsageError extends Error {}

function parseFlags(action: ServiceAction, args: readonly string[]): Flags {
  let dryRun = false;
  let start = false;
  let platform: ServicePlatform | null = null;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--start' && action === 'install') start = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--platform' || arg.startsWith('--platform=')) {
      const value = arg === '--platform' ? args[++i] : arg.slice('--platform='.length);
      if (!value || !isServicePlatform(value)) throw new UsageError(`--platform must be darwin, linux or win32, got "${value ?? ''}"`);
      platform = value;
    } else throw new UsageError(`unknown option: ${arg}`);
  }
  return { dryRun, start, platform, help };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `install` or `uninstall` with `args` and returns the exit code: 0 done,
 * 1 refused or failed, 2 bad usage.
 */
export async function runServiceCli(action: ServiceAction, args: readonly string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let flags: Flags;
  try {
    flags = parseFlags(action, args);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE[action]}\n`);
    return 2;
  }
  if (flags.help) {
    io.out(`${USAGE[action]}\n`);
    return 0;
  }
  const host = process.platform;
  const platform = flags.platform ?? (isServicePlatform(host) ? host : null);
  if (!platform) {
    io.err(`switchboard service: ${host} has no supported per-user service manager (macOS, Linux and Windows do).\n`);
    return 1;
  }
  if (platform !== host && !flags.dryRun) {
    io.err(`--platform ${platform} only previews another OS: add --dry-run.\n\n${USAGE[action]}\n`);
    return 2;
  }
  try {
    const config = loadConfig({ env });
    const redirect = loadServiceRedirect(env);
    // A preview of another OS uses that OS's default data folder under this home.
    const dataDir = platform === host || env['SWITCHBOARD_DATA_DIR']?.trim() ? config.dataDir : defaultDataDir(platform, env, os.homedir());
    const location = serviceLocation({ platform, dataDir, env, redirect });
    if (!location) throw new ServiceError('unsupported', `${platform} is not supported`);
    const manager = redirect?.manager ?? [MANAGER_BIN[platform]];
    const definition = servicePaths(location).definition;
    const installed = await exists(definition);
    const lines = [`Switchboard service · ${managerLabel(platform)} · ${action}${flags.dryRun ? ' · dry run: nothing is written or run' : ''}`];
    if (platform !== host) lines.push(`preview of the ${platform} files with this machine's paths`);

    let plan;
    if (action === 'install') {
      const node = await checkNode({ env: withCleanSearchPath(env, host), platform: host, cwd: APP_DIR });
      lines.push(`node: ${node.path} (${node.version})`);
      if (!(await exists(path.join(APP_DIR, 'dist', 'web', 'index.html')))) io.err('warning: dist/web is not built; run `npm run build` before the service starts.\n');
      const carried = carriedEnvironment({ ...config, dataDir }, defaultDataDir(platform, env, os.homedir()));
      const target = serviceTarget({ location, nodePath: node.path, env, carried, address: `${config.host}:${config.port}`, uid: currentUid() });
      plan = installPlan(target, { start: flags.start });
    } else {
      plan = uninstallPlan({ ...location, uid: currentUid() }, { stop: true });
    }
    lines.push(`definition: ${definition} (${installed ? 'installed' : 'not installed'})`);

    if (flags.dryRun) {
      io.out(`${lines.join('\n')}\n${describePlan(plan, manager)}\n`);
      return 0;
    }
    if (action === 'uninstall' && !installed) {
      io.out(`${lines.join('\n')}\nNothing to do.\n`);
      return 0;
    }
    const reports = await executePlan(plan, { manager, cwd: APP_DIR, env });
    for (const report of reports) {
      const { step } = report;
      const text =
        step.kind === 'run'
          ? displayCommand([...manager, ...step.args])
          : step.kind === 'write'
            ? `write ${step.file.path}`
            : `${step.kind} ${step.path}`;
      lines.push(`${report.outcome === 'done' ? 'done   ' : 'skipped'} ${text}`);
    }
    if (action === 'install') lines.push(flags.start ? 'Installed and started: Switchboard also starts at every sign-in.' : 'Installed: Switchboard starts at your next sign-in (add --start to start it now).');
    else lines.push('Uninstalled: Switchboard no longer starts at sign-in.');
    io.out(`${lines.join('\n')}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ServiceError || error instanceof ConfigError) {
      io.err(`switchboard service: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/** Runs the CLI for `action` on this process's argv and exits with its code. */
export async function main(action: ServiceAction): Promise<never> {
  const io: CliIo = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
  const code = await runServiceCli(action, process.argv.slice(2), io);
  // Let stdout / stderr drain before exiting.
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  process.exit(code);
}
