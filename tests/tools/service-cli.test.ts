import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { servicePaths } from '../../src/core/service-files.ts';
import { fakeServiceCtlEnv } from '../../tools/fake-servicectl/command.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../helpers/net.ts';

/**
 * M9.1 oracle, part 3: the install / uninstall scripts. `--dry-run` for every
 * platform prints the files and commands and leaves the (temp) home, data folder
 * and service manager untouched; real runs go to a temp home with
 * tools/fake-servicectl (`SWITCHBOARD_SERVICE_HOME` + `SWITCHBOARD_SERVICE_CTL`),
 * never to this machine's launchd / systemd / Task Scheduler (D12).
 */

let tmp: string;
let home: string;
let dataDir: string;
let log: string;

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function script(name: 'install' | 'uninstall', args: readonly string[], env: Record<string, string> = {}): Promise<Run> {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('SWITCHBOARD_') && !key.startsWith('FAKE_')) clean[key] = value;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('tools', 'service', `${name}.ts`), ...args], {
      cwd: REPO_ROOT,
      env: {
        ...clean,
        SWITCHBOARD_SERVICE_HOME: home,
        SWITCHBOARD_SERVICE_CTL: fakeServiceCtlEnv(),
        FAKE_SERVICECTL_LOG: log,
        SWITCHBOARD_DATA_DIR: dataDir,
        ...env,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function ctlCalls(): Promise<string[]> {
  if (!(await exists(log))) return [];
  return (await readFile(log, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv.join(' '));
}

/** Everything under `dir` (relative paths), to prove a dry run wrote nothing. */
async function tree(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  return (await readdir(dir, { recursive: true })).map(String).sort();
}

beforeEach(async () => {
  tmp = await makeTempDir('service-cli');
  home = path.join(tmp, 'home');
  dataDir = path.join(tmp, 'data');
  log = path.join(tmp, 'servicectl.log');
});

afterEach(async () => {
  await removeTempDir(tmp);
});

const HOST = process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32' ? process.platform : null;

describe('--dry-run', () => {
  it.runIf(HOST !== null)('install prints the definition in full and the steps, and changes nothing', async () => {
    const result = await script('install', ['--dry-run', '--start']);
    expect(result.code, result.stderr).toBe(0);
    const location = { platform: HOST ?? 'linux', home, dataDir, xdgConfigHome: null } as const;
    const { definition } = servicePaths(location);
    expect(result.stdout).toContain('· install · dry run: nothing is written or run');
    expect(result.stdout).toMatch(/^node: \S.* \(v\d+\.\d+\.\d+\)$/m);
    expect(result.stdout).toContain(`definition: ${definition} (not installed)`);
    expect(result.stdout).toContain(`write   ${definition}`);
    // The data folder (not the default) is carried into the service (D14: there is no workspace variable).
    expect(result.stdout).toContain(`SWITCHBOARD_DATA_DIR`);
    expect(result.stdout).toContain(dataDir);
    expect(await tree(tmp)).toEqual([]);
  });

  it('previews every platform: launchd plist, systemd unit, Task Scheduler XML + env file', async () => {
    const mac = await script('install', ['--dry-run', '--platform', 'darwin']);
    expect(mac.code, mac.stderr).toBe(0);
    expect(mac.stdout).toContain('Switchboard service · launchd (macOS) · install · dry run');
    expect(mac.stdout).toContain('        | \t<key>RunAtLoad</key>');
    expect(mac.stdout).toContain(`write   ${path.posix.join(home, 'Library', 'LaunchAgents', 'local.switchboard.plist')}`);

    const linux = await script('install', ['--dry-run', '--platform=linux', '--start']);
    expect(linux.code, linux.stderr).toBe(0);
    expect(linux.stdout).toContain('Switchboard service · systemd (Linux) · install · dry run');
    expect(linux.stdout).toContain('        | WantedBy=default.target');
    expect(linux.stdout).toMatch(/^run {5}.* --user daemon-reload$/m);
    expect(linux.stdout).toMatch(/^run {5}.* --user enable switchboard\.service$/m);
    expect(linux.stdout).toMatch(/^run {5}.* --user restart switchboard\.service$/m);

    const win = await script('install', ['--dry-run', '--platform', 'win32']);
    expect(win.code, win.stderr).toBe(0);
    expect(win.stdout).toContain('Switchboard service · task-scheduler (Windows) · install · dry run');
    expect(win.stdout).toContain('switchboard-task.xml (UTF-16 LE with BOM)');
    expect(win.stdout).toContain('        |     <LogonTrigger>');
    expect(win.stdout).toMatch(/^write {3}.*switchboard\.env$/m);
    expect(win.stdout).toMatch(/^run {5}.* \/Create \/TN Switchboard \/XML .* \/F$/m);

    expect(await tree(tmp)).toEqual([]);
  });

  it('uninstall lists the stop + removal steps and changes nothing', async () => {
    const result = await script('uninstall', ['--dry-run', '--platform', 'win32']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('· uninstall · dry run');
    expect(result.stdout).toMatch(/^run {5}.* \/End \/TN Switchboard {3}\(only if `.* \/Query \/TN Switchboard` succeeds\)$/m);
    expect(result.stdout).toMatch(/^remove {2}.*switchboard-task\.xml$/m);
    const linux = await script('uninstall', ['--dry-run', '--platform', 'linux']);
    expect(linux.stdout).toMatch(/^run {5}.* --user disable --now switchboard\.service$/m);
    const mac = await script('uninstall', ['--dry-run', '--platform', 'darwin']);
    expect(mac.code, mac.stderr).toBe(0);
    expect(mac.stdout).toMatch(/^run {5}.* bootout gui\/\d+\/local\.switchboard {3}\(only if `.* print gui\/\d+\/local\.switchboard` succeeds\)$/m);
    expect(await tree(tmp)).toEqual([]);
  });
});

describe.runIf(HOST !== null)('real runs against the temp home and the fake service manager', () => {
  it('install writes the definition (+ start runs the manager); uninstall stops and removes it', async () => {
    const location = { platform: HOST ?? 'linux', home, dataDir, xdgConfigHome: null } as const;
    const { definition } = servicePaths(location);
    const installed = await script('install', ['--start']);
    expect(installed.code, installed.stderr).toBe(0);
    expect(installed.stdout).toContain('Installed and started: Switchboard also starts at every sign-in.');
    expect(await exists(definition)).toBe(true);
    const content = await readFile(definition);
    const text = HOST === 'win32' ? content.subarray(2).toString('utf16le') : content.toString('utf8');
    expect(text).toContain(path.join(REPO_ROOT, 'src', 'server', 'main.ts'));

    const again = await script('install', ['--dry-run']);
    expect(again.stdout).toContain(`definition: ${definition} (installed)`);

    const removed = await script('uninstall', []);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toContain('Uninstalled: Switchboard no longer starts at sign-in.');
    expect(await exists(definition)).toBe(false);
    const calls = await ctlCalls();
    if (HOST === 'darwin') {
      expect(calls.map((c) => c.replace(/gui\/\d+/, 'gui/<uid>'))).toEqual([
        'print gui/<uid>/local.switchboard',
        'bootout gui/<uid>/local.switchboard',
        `bootstrap gui/<uid> ${definition}`,
        'print gui/<uid>/local.switchboard',
        'bootout gui/<uid>/local.switchboard',
      ]);
    } else if (HOST === 'linux') {
      expect(calls).toEqual([
        '--user daemon-reload',
        '--user enable switchboard.service',
        '--user restart switchboard.service',
        '--user disable --now switchboard.service',
        '--user daemon-reload',
      ]);
    } else {
      expect(calls[0]).toContain('/Create /TN Switchboard /XML');
    }

    const nothing = await script('uninstall', []);
    expect(nothing.code).toBe(0);
    expect(nothing.stdout).toContain('Nothing to do.');
  });

  it('refuses without Node ≥ 24 on PATH and writes nothing', async () => {
    const result = await script('install', [], { PATH: path.join(tmp, 'no-bin') });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('switchboard service: Node.js ≥ 24 must be on PATH: no node was found there.');
    expect(await tree(home)).toEqual([]);
  });
});

describe('usage', () => {
  it('rejects unknown options, a foreign --platform without --dry-run, and a half-set redirect', async () => {
    const unknown = await script('install', ['--force']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown option: --force');
    const other = process.platform === 'win32' ? 'linux' : 'win32';
    const foreign = await script('install', ['--platform', other]);
    expect(foreign.code).toBe(2);
    expect(foreign.stderr).toContain('only previews another OS: add --dry-run');
    const startOnUninstall = await script('uninstall', ['--start']);
    expect(startOnUninstall.code).toBe(2);
    const half = await script('install', ['--dry-run'], { SWITCHBOARD_SERVICE_CTL: '' });
    expect(half.code).toBe(1);
    expect(half.stderr).toContain('SWITCHBOARD_SERVICE_HOME and SWITCHBOARD_SERVICE_CTL are test redirects and must be set together');
    const help = await script('install', ['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: npm run service:install -- [--dry-run] [--start]');
    expect(await tree(tmp)).toEqual([]);
  });
});
