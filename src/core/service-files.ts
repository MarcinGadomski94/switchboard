import path from 'node:path';
import type { ServiceManagerName } from './login-service.ts';

/**
 * Per-user background service definitions (M9.1, `docs/service.md`): a launchd
 * agent (macOS), a systemd `--user` unit (Linux) and a Task Scheduler task that
 * runs at logon (Windows), plus the ordered steps that register, start, stop and
 * remove them. Pure: no I/O here. `src/server/service/executor.ts` runs a plan,
 * `tools/service/*` print it for `--dry-run`.
 *
 * The service is `node <repo>/src/server/main.ts` in the repo folder, started at
 * login only. It is not restarted automatically: a crash loop would resume the
 * supervised sessions over and over (M2.4 sends "Switchboard restarted.
 * Continue." on every start).
 */

/** Platforms with a per-user service manager Switchboard supports. */
export type ServicePlatform = 'darwin' | 'linux' | 'win32';

/** Node.js major version the service needs on PATH (AGENTS.md: Node ≥ 24, type stripping). */
export const MIN_NODE_MAJOR = 24;

/** launchd job label; the plist is `~/Library/LaunchAgents/<label>.plist`. */
export const LAUNCHD_LABEL = 'local.switchboard';

/** systemd user unit name. */
export const SYSTEMD_UNIT = 'switchboard.service';

/** Task Scheduler task name (root folder). */
export const TASK_NAME = 'Switchboard';

/** The service manager's CLI per platform (an argv prefix; tests substitute a fake). */
export const MANAGER_BIN: Readonly<Record<ServicePlatform, string>> = {
  darwin: 'launchctl',
  linux: 'systemctl',
  win32: 'schtasks',
};

const MANAGER: Readonly<Record<ServicePlatform, ServiceManagerName>> = {
  darwin: 'launchd',
  linux: 'systemd',
  win32: 'task-scheduler',
};

const OS_NAME: Readonly<Record<ServicePlatform, string>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

/** `true` for a platform with a supported service manager. */
export function isServicePlatform(platform: string): platform is ServicePlatform {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

/** The service manager of `platform`. */
export function serviceManager(platform: ServicePlatform): ServiceManagerName {
  return MANAGER[platform];
}

/** Thrown when a value cannot be written into a service file safely (a newline in a path, a NUL, …). */
export class ServiceFileError extends Error {
  override name = 'ServiceFileError';
}

/** Where the service files go. */
export interface ServiceLocation {
  readonly platform: ServicePlatform;
  /** The user's home folder (`SWITCHBOARD_SERVICE_HOME` in tests). Native form of `platform`. */
  readonly home: string;
  /** Switchboard's app-data folder (`config.dataDir`): the log on macOS, the task XML + env file on Windows. */
  readonly dataDir: string;
  /** Linux: `$XDG_CONFIG_HOME` when it is absolute, else `null` (= `~/.config`). */
  readonly xdgConfigHome: string | null;
}

/** Everything a service definition needs. */
export interface ServiceTarget extends ServiceLocation {
  /** Absolute path of the `node` found on PATH (≥ {@link MIN_NODE_MAJOR}). */
  readonly nodePath: string;
  /** The repo folder: the service's working directory. */
  readonly appDir: string;
  /** Absolute path of `src/server/main.ts`. */
  readonly entry: string;
  /** The `SWITCHBOARD_*` variables the service starts with (`docs/service.md` → *Environment*). */
  readonly env: Readonly<Record<string, string>>;
  /** PATH for launchd / systemd, which do not give a service the login shell's PATH; `null` = leave unset. Windows ignores it. */
  readonly searchPath: string | null;
  /** macOS: the numeric user id (launchctl domain `gui/<uid>`); `null` elsewhere. */
  readonly uid: number | null;
  /** Windows: `DOMAIN\user` for the logon trigger and principal; `null` elsewhere. */
  readonly user: string | null;
  /** `127.0.0.1:<port>`, for the descriptions. */
  readonly address: string;
}

/** The files of a location. */
export interface ServicePaths {
  /** The service definition: plist, unit or task XML. Its existence = "Start at login" is on. */
  readonly definition: string;
  /** Windows: the `node --env-file` file with the `SWITCHBOARD_*` variables; `null` elsewhere. */
  readonly envFile: string | null;
  /** macOS: stdout + stderr of the service (launchd discards them otherwise); `null` elsewhere (journald / none). */
  readonly logFile: string | null;
  /** Folders created before the files are written. */
  readonly folders: readonly string[];
}

/** The paths of `location`'s service files. */
export function servicePaths(location: ServiceLocation): ServicePaths {
  switch (location.platform) {
    case 'darwin': {
      const agents = path.posix.join(location.home, 'Library', 'LaunchAgents');
      const logs = path.posix.join(location.dataDir, 'logs');
      return {
        definition: path.posix.join(agents, `${LAUNCHD_LABEL}.plist`),
        envFile: null,
        logFile: path.posix.join(logs, 'service.log'),
        folders: [agents, logs],
      };
    }
    case 'linux': {
      const config = location.xdgConfigHome ?? path.posix.join(location.home, '.config');
      const units = path.posix.join(config, 'systemd', 'user');
      return { definition: path.posix.join(units, SYSTEMD_UNIT), envFile: null, logFile: null, folders: [units] };
    }
    case 'win32': {
      const folder = path.win32.join(location.dataDir, 'service');
      return {
        definition: path.win32.join(folder, 'switchboard-task.xml'),
        envFile: path.win32.join(folder, 'switchboard.env'),
        logFile: null,
        folders: [folder],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Escaping

// XML 1.0 forbids these control characters even as references.
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

/** Escapes text for an XML element or attribute (plist, task XML). */
export function xmlText(value: string): string {
  if (XML_FORBIDDEN.test(value)) throw new ServiceFileError(`cannot write a control character into XML: ${JSON.stringify(value)}`);
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function assertOneLine(value: string, what: string): void {
  if (/[\r\n\u0000]/.test(value)) throw new ServiceFileError(`${what} must be one line without NUL: ${JSON.stringify(value)}`);
}

/**
 * One word of a systemd `ExecStart=` line: `%` → `%%` (specifiers), `$` → `$$`
 * (variable expansion), and double quotes with C escapes (`\\`, `\"`) when the
 * word has whitespace, quotes, a backslash or a `;`.
 */
export function systemdExecWord(value: string): string {
  assertOneLine(value, 'an ExecStart argument');
  const plain = value.replace(/%/g, '%%').replace(/\$/g, '$$$$');
  if (value !== '' && !/[\s"'\\;]/.test(value)) return plain;
  return `"${plain.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A systemd `Environment=` assignment: `"KEY=value"` with `\\`, `\"` and `%%` (no `$` expansion there). */
export function systemdEnvironment(key: string, value: string): string {
  assertEnvKey(key);
  assertOneLine(value, `${key}`);
  const text = `${key}=${value}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return `"${text}"`;
}

/** A systemd path or free-text value (`WorkingDirectory=`, `Description=`): `%` → `%%`, one line. */
export function systemdValue(value: string): string {
  assertOneLine(value, 'a unit value');
  return value.replace(/%/g, '%%');
}

/**
 * One argument of a Windows command line, quoted the way `CommandLineToArgvW` /
 * the MSVC runtime (and so node.exe) split it: quotes when it has whitespace or a
 * quote, `\"` for a quote, backslashes doubled only before a quote.
 */
export function windowsArg(value: string): string {
  assertOneLine(value, 'a command-line argument');
  if (value !== '' && !/[\s"]/.test(value)) return value;
  let out = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += `${'\\'.repeat(backslashes * 2 + 1)}"`;
    } else {
      out += `${'\\'.repeat(backslashes)}${ch}`;
    }
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

function assertEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ServiceFileError(`not an environment variable name: ${JSON.stringify(key)}`);
}

/**
 * One `KEY=value` line of a Node `--env-file` file. Node's parser takes single
 * quotes and backticks literally and expands `\n` inside double quotes, so the
 * value goes in the first of `'`, `` ` ``, `"` it can use.
 */
export function envFileLine(key: string, value: string): string {
  assertEnvKey(key);
  assertOneLine(value, key);
  if (!value.includes("'")) return `${key}='${value}'`;
  if (!value.includes('`')) return `${key}=\`${value}\``;
  if (!value.includes('"') && !value.includes('\\n')) return `${key}="${value}"`;
  throw new ServiceFileError(`${key} has every quote character; it cannot be written into an env file`);
}

/** Sorted `[key, value]` pairs: PATH first, then the rest by name. */
function envEntries(env: Readonly<Record<string, string>>, searchPath: string | null): Array<[string, string]> {
  const rest = Object.entries(env)
    .filter(([key]) => key !== 'PATH')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return searchPath === null ? rest : [['PATH', searchPath], ...rest];
}

function description(target: ServiceTarget): string {
  return `Switchboard: supervises Claude Code sessions (${target.address})`;
}

// ---------------------------------------------------------------------------
// Files

/** The launchd agent (macOS): runs once at login (`RunAtLoad`), not kept alive; output → the log file. */
export function launchdPlist(target: ServiceTarget): string {
  const paths = servicePaths(target);
  const log = paths.logFile ?? path.posix.join(target.dataDir, 'logs', 'service.log');
  const str = (value: string): string => `<string>${xmlText(value)}</string>`;
  const env = envEntries(target.env, target.searchPath);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- Generated by Switchboard ("Start at login", docs/service.md). Turning it on again rewrites this file. -->',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t${str(LAUNCHD_LABEL)}`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    `\t\t${str(target.nodePath)}`,
    `\t\t${str(target.entry)}`,
    '\t</array>',
    '\t<key>WorkingDirectory</key>',
    `\t${str(target.appDir)}`,
  ];
  if (env.length > 0) {
    lines.push('\t<key>EnvironmentVariables</key>', '\t<dict>');
    for (const [key, value] of env) {
      assertEnvKey(key);
      lines.push(`\t\t<key>${xmlText(key)}</key>`, `\t\t${str(value)}`);
    }
    lines.push('\t</dict>');
  }
  lines.push(
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<false/>',
    '\t<key>StandardOutPath</key>',
    `\t${str(log)}`,
    '\t<key>StandardErrorPath</key>',
    `\t${str(log)}`,
    '</dict>',
    '</plist>',
    '',
  );
  return lines.join('\n');
}

/**
 * The systemd user unit (Linux): started with the user's session
 * (`WantedBy=default.target`), not restarted, logs to the journal. `KillMode=mixed`
 * sends SIGTERM to the service only, so it can pause its `claude` children itself
 * (D7) before anything left is killed.
 */
export function systemdUnit(target: ServiceTarget): string {
  const lines = [
    '# Generated by Switchboard ("Start at login", docs/service.md). Turning it on again rewrites this file.',
    '[Unit]',
    `Description=${systemdValue(description(target))}`,
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${systemdValue(target.appDir)}`,
  ];
  for (const [key, value] of envEntries(target.env, target.searchPath)) lines.push(`Environment=${systemdEnvironment(key, value)}`);
  lines.push(
    `ExecStart=${[target.nodePath, target.entry].map(systemdExecWord).join(' ')}`,
    'KillMode=mixed',
    'Restart=no',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  );
  return lines.join('\n');
}

/** The `node` command line of the Windows task: `--env-file=<file> <entry>`. */
export function taskArguments(target: ServiceTarget): string {
  const envFile = servicePaths(target).envFile ?? path.win32.join(target.dataDir, 'service', 'switchboard.env');
  return [`--env-file=${envFile}`, target.entry].map(windowsArg).join(' ');
}

/**
 * The Task Scheduler task (Windows): a logon trigger for this user, the user's
 * own interactive token at least privilege, no time limit, one instance, not
 * restarted. Task Scheduler cannot set environment variables, so the
 * `SWITCHBOARD_*` values go through `node --env-file` (the user's own PATH
 * applies at logon). Written as UTF-16 with a BOM, which `schtasks /XML` expects.
 */
export function taskSchedulerXml(target: ServiceTarget): string {
  const user = target.user;
  if (!user) throw new ServiceFileError('the Windows task needs the user name (USERDOMAIN\\USERNAME)');
  const command = /\s/.test(target.nodePath) ? `"${target.nodePath}"` : target.nodePath;
  const lines = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<!-- Generated by Switchboard ("Start at login", docs/service.md). Turning it on again rewrites this task. -->',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlText(description(target))}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${xmlText(user)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xmlText(user)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlText(command)}</Command>`,
    `      <Arguments>${xmlText(taskArguments(target))}</Arguments>`,
    `      <WorkingDirectory>${xmlText(target.appDir)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ];
  return lines.join('\r\n');
}

/** The Windows `--env-file` file: the `SWITCHBOARD_*` variables (CRLF). */
export function serviceEnvFile(env: Readonly<Record<string, string>>): string {
  const lines = ['# Generated by Switchboard ("Start at login", docs/service.md): the service\'s SWITCHBOARD_* settings.'];
  for (const [key, value] of envEntries(env, null)) lines.push(envFileLine(key, value));
  lines.push('');
  return lines.join('\r\n');
}

/** A file a plan writes. `utf16le` = UTF-16 little endian with a BOM (the task XML). */
export interface ServiceFile {
  readonly path: string;
  readonly content: string;
  readonly encoding: 'utf8' | 'utf16le';
}

/** The files of `target`'s service: the definition (+ the env file on Windows). */
export function serviceFiles(target: ServiceTarget): ServiceFile[] {
  const paths = servicePaths(target);
  switch (target.platform) {
    case 'darwin':
      return [{ path: paths.definition, content: launchdPlist(target), encoding: 'utf8' }];
    case 'linux':
      return [{ path: paths.definition, content: systemdUnit(target), encoding: 'utf8' }];
    case 'win32':
      return [
        { path: paths.envFile ?? '', content: serviceEnvFile(target.env), encoding: 'utf8' },
        { path: paths.definition, content: taskSchedulerXml(target), encoding: 'utf16le' },
      ];
  }
}

/** The bytes of a {@link ServiceFile} as written to disk. */
export function serviceFileBytes(file: ServiceFile): Buffer {
  if (file.encoding === 'utf8') return Buffer.from(file.content, 'utf8');
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(file.content, 'utf16le')]);
}

// ---------------------------------------------------------------------------
// Plans

/** One step of a plan. `run` args go to the platform's service manager ({@link MANAGER_BIN}). */
export type ServiceStep =
  | { readonly kind: 'mkdir'; readonly path: string }
  | { readonly kind: 'write'; readonly file: ServiceFile }
  | { readonly kind: 'remove'; readonly path: string }
  | {
      readonly kind: 'run';
      readonly args: readonly string[];
      /** Run only when this manager command succeeds (e.g. the job is loaded / the task exists). */
      readonly onlyIf?: readonly string[];
    };

/** What a plan does. */
export type ServiceAction = 'install' | 'uninstall';

/** An ordered list of steps for one platform. */
export interface ServicePlan {
  readonly platform: ServicePlatform;
  readonly manager: ServiceManagerName;
  readonly action: ServiceAction;
  /** The service definition the plan writes or removes. */
  readonly definition: string;
  readonly steps: readonly ServiceStep[];
}

function launchdDomain(uid: number | null): string {
  if (uid === null) throw new ServiceFileError('launchctl needs the numeric user id (gui/<uid>)');
  return `gui/${uid}`;
}

/**
 * Registers the service so it starts at the next login: the folders, the files,
 * then `systemctl --user daemon-reload` + `enable` (Linux) or `schtasks /Create`
 * (Windows); a plist in `~/Library/LaunchAgents` needs no command (launchd loads
 * it at login). `start` also starts it now (the install script's `--start`): the
 * "Start at login" toggle never does, because the service answering it is
 * already running.
 */
export function installPlan(target: ServiceTarget, options: { readonly start?: boolean } = {}): ServicePlan {
  const paths = servicePaths(target);
  const steps: ServiceStep[] = [
    ...paths.folders.map((folder): ServiceStep => ({ kind: 'mkdir', path: folder })),
    ...serviceFiles(target).map((file): ServiceStep => ({ kind: 'write', file })),
  ];
  if (target.platform === 'linux') {
    steps.push({ kind: 'run', args: ['--user', 'daemon-reload'] }, { kind: 'run', args: ['--user', 'enable', SYSTEMD_UNIT] });
  } else if (target.platform === 'win32') {
    steps.push({ kind: 'run', args: ['/Create', '/TN', TASK_NAME, '/XML', paths.definition, '/F'] });
  }
  if (options.start) {
    if (target.platform === 'darwin') {
      const domain = launchdDomain(target.uid);
      const job = `${domain}/${LAUNCHD_LABEL}`;
      steps.push({ kind: 'run', args: ['bootout', job], onlyIf: ['print', job] }, { kind: 'run', args: ['bootstrap', domain, paths.definition] });
    } else if (target.platform === 'linux') {
      steps.push({ kind: 'run', args: ['--user', 'restart', SYSTEMD_UNIT] });
    } else {
      steps.push({ kind: 'run', args: ['/Run', '/TN', TASK_NAME] });
    }
  }
  return { platform: target.platform, manager: MANAGER[target.platform], action: 'install', definition: paths.definition, steps };
}

/**
 * Removes the registration: `systemctl --user disable` then the unit +
 * `daemon-reload` (Linux), `schtasks /Delete` then the files (Windows), the plist
 * (macOS). `stop` also stops a running service first (the uninstall script): the
 * toggle never does, because the service answering it may be that very service.
 */
export function uninstallPlan(location: ServiceLocation & { readonly uid: number | null }, options: { readonly stop?: boolean } = {}): ServicePlan {
  const paths = servicePaths(location);
  const steps: ServiceStep[] = [];
  switch (location.platform) {
    case 'darwin': {
      if (options.stop) {
        const job = `${launchdDomain(location.uid)}/${LAUNCHD_LABEL}`;
        steps.push({ kind: 'run', args: ['bootout', job], onlyIf: ['print', job] });
      }
      steps.push({ kind: 'remove', path: paths.definition });
      break;
    }
    case 'linux': {
      steps.push({ kind: 'run', args: ['--user', 'disable', ...(options.stop ? ['--now'] : []), SYSTEMD_UNIT] });
      steps.push({ kind: 'remove', path: paths.definition });
      steps.push({ kind: 'run', args: ['--user', 'daemon-reload'] });
      break;
    }
    case 'win32': {
      const exists = ['/Query', '/TN', TASK_NAME];
      if (options.stop) steps.push({ kind: 'run', args: ['/End', '/TN', TASK_NAME], onlyIf: exists });
      steps.push({ kind: 'run', args: ['/Delete', '/TN', TASK_NAME, '/F'], onlyIf: exists });
      steps.push({ kind: 'remove', path: paths.definition });
      if (paths.envFile) steps.push({ kind: 'remove', path: paths.envFile });
      break;
    }
  }
  return { platform: location.platform, manager: MANAGER[location.platform], action: 'uninstall', definition: paths.definition, steps };
}

// ---------------------------------------------------------------------------
// Dry run text

/** A command for display: args with spaces or quotes in double quotes. */
export function displayCommand(argv: readonly string[]): string {
  return argv.map((arg) => (arg !== '' && !/[\s"'\\$`]/.test(arg) ? arg : JSON.stringify(arg))).join(' ');
}

/**
 * The plan as text, one line per step and every written file in full (indented
 * with `| `). `manager` = the manager command shown for `run` steps.
 */
export function describePlan(plan: ServicePlan, manager: readonly string[] = [MANAGER_BIN[plan.platform]]): string {
  const lines: string[] = [];
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'mkdir':
        lines.push(`mkdir   ${step.path}`);
        break;
      case 'write':
        lines.push(`write   ${step.file.path}${step.file.encoding === 'utf16le' ? ' (UTF-16 LE with BOM)' : ''}`);
        for (const line of step.file.content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')) lines.push(`        | ${line}`);
        break;
      case 'remove':
        lines.push(`remove  ${step.path}`);
        break;
      case 'run':
        lines.push(
          `run     ${displayCommand([...manager, ...step.args])}${step.onlyIf ? `   (only if \`${displayCommand([...manager, ...step.onlyIf])}\` succeeds)` : ''}`,
        );
        break;
    }
  }
  return lines.join('\n');
}

/** "launchd (macOS)" etc. */
export function managerLabel(platform: ServicePlatform): string {
  return `${MANAGER[platform]} (${OS_NAME[platform]})`;
}

/** The major version of a `node --version` answer (`v24.3.0` → 24); `null` when unreadable. */
export function parseNodeMajor(text: string): number | null {
  const match = /^\s*v?(\d+)\.\d+\.\d+/.exec(text);
  return match ? Number(match[1]) : null;
}
