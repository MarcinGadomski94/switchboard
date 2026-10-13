import { spawn } from 'node:child_process';

/**
 * D100-T2 · where an access's values live (`docs/team.md` → *Access requests*,
 * `docs/security.md` → *Team access*): **the OS keychain only**. `team.db`, the
 * settings and the logs hold a reference (keychain service and account), never a
 * value; a paired machine never gets one.
 *
 * - macOS: the login keychain through `security` (`add-generic-password` fed on
 *   stdin through `security -i`, the value hex-encoded with `-X`, so it is never on
 *   an argv; `find-generic-password -w`; `delete-generic-password`).
 * - Windows: Credential Manager (`CredWrite` / `CredRead` / `CredDelete`) through
 *   PowerShell's `Add-Type`; the script is passed encoded and the value on stdin.
 *   The documented fallback (DPAPI-protected file under the data folder) is not
 *   built: without PowerShell, setup is refused with the reason.
 * - Linux: the Secret Service through `secret-tool` (value on stdin). Without it,
 *   setup is refused ("install libsecret-tools"); no file fallback is built.
 *
 * Tests never touch a real keychain: under Vitest (`VITEST`) or with
 * `SWITCHBOARD_TEST_SECRET_STORE=memory` the store is {@link MemorySecretStore}, and
 * the OS stores refuse to run under Vitest.
 */
export interface SecretRef {
  readonly service: string;
  readonly account: string;
}

/** A pluggable keychain. */
export interface SecretStore {
  /** What it is ("macOS Keychain"). */
  readonly name: string;
  /** Whether it can be used here (the tool exists), and why not. */
  available(): Promise<{ readonly ok: boolean; readonly problem: string | null }>;
  /** Stores (or replaces) a value. @throws when the keychain refuses. */
  set(ref: SecretRef, value: string): Promise<void>;
  /** The value, `null` when there is none. @throws when the keychain cannot be read. */
  get(ref: SecretRef): Promise<string | null>;
  /** Removes it (no error when it is not there). */
  delete(ref: SecretRef): Promise<void>;
}

/** A command's outcome. */
export interface SecretCommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when it could not start (`ENOENT`: the tool is missing) or timed out. */
  readonly error: NodeJS.ErrnoException | null;
}

/** Runs one keychain command (argv, `shell: false`, optional stdin). Replaceable in tests of the command lines. */
export type SecretRunner = (command: string, args: readonly string[], input: string | null) => Promise<SecretCommandResult>;

/** The real runner: `spawn` with `shell: false`, stdin written then closed, 20 s limit. */
export const runSecretCommand: SecretRunner = (command, args, input) =>
  new Promise((resolve) => {
    if (process.env['VITEST']) {
      resolve({ code: null, stdout: '', stderr: '', error: Object.assign(new Error('the OS keychain is never used under tests'), { code: 'EPERM' }) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const child = spawn(command, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null, Object.assign(new Error('the keychain did not answer within 20 s'), { code: 'ETIMEDOUT' }));
    }, 20_000);
    timer.unref();
    const finish = (code: number | null, error: NodeJS.ErrnoException | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), error });
    };
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code, null));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });

function problem(result: SecretCommandResult, what: string): Error {
  const text = (result.stderr.trim() || result.error?.message || `exit code ${String(result.code)}`).split('\n').slice(-2).join(' ');
  return new Error(`${what}: ${text}`);
}

/** A double-quoted argument for `security -i` (backslash and quote escaped). */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** macOS: the login keychain through `/usr/bin/security`. */
export class MacKeychain implements SecretStore {
  readonly name = 'macOS Keychain';
  readonly #run: SecretRunner;
  readonly #bin: string;

  constructor(run: SecretRunner = runSecretCommand, bin = '/usr/bin/security') {
    this.#run = run;
    this.#bin = bin;
  }

  async available(): Promise<{ readonly ok: boolean; readonly problem: string | null }> {
    const result = await this.#run(this.#bin, ['default-keychain'], null);
    return result.error === null && result.code === 0 ? { ok: true, problem: null } : { ok: false, problem: problem(result, 'the macOS keychain cannot be used').message };
  }

  /** The `security -i` line that stores `value` (hex with `-X`: never on an argv, no quoting of the value). */
  static storeLine(ref: SecretRef, value: string): string {
    return `add-generic-password -U -s ${quoted(ref.service)} -a ${quoted(ref.account)} -l ${quoted(`${ref.service} · ${ref.account}`)} -X ${Buffer.from(value, 'utf8').toString('hex')}\n`;
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    const result = await this.#run(this.#bin, ['-i'], MacKeychain.storeLine(ref, value));
    if (result.error !== null || result.code !== 0 || /error|could not/i.test(result.stderr)) throw problem(result, 'the macOS keychain refused the value');
  }

  async get(ref: SecretRef): Promise<string | null> {
    const result = await this.#run(this.#bin, ['find-generic-password', '-s', ref.service, '-a', ref.account, '-w'], null);
    // 44: the item could not be found.
    if (result.code === 44) return null;
    if (result.error !== null || result.code !== 0) throw problem(result, 'the macOS keychain could not be read');
    return result.stdout.replace(/\r?\n$/, '');
  }

  async delete(ref: SecretRef): Promise<void> {
    const result = await this.#run(this.#bin, ['delete-generic-password', '-s', ref.service, '-a', ref.account], null);
    if (result.code === 44) return;
    if (result.error !== null || result.code !== 0) throw problem(result, 'the macOS keychain could not remove the value');
  }
}

/** Linux: the Secret Service through `secret-tool` (libsecret). */
export class SecretToolStore implements SecretStore {
  readonly name = 'Secret Service (secret-tool)';
  readonly #run: SecretRunner;

  constructor(run: SecretRunner = runSecretCommand) {
    this.#run = run;
  }

  async available(): Promise<{ readonly ok: boolean; readonly problem: string | null }> {
    // Without arguments it prints its usage and exits 2; missing → ENOENT.
    const result = await this.#run('secret-tool', [], null);
    if (result.error?.code === 'ENOENT') return { ok: false, problem: 'secret-tool is not installed (install libsecret-tools); Switchboard keeps no secret in a file' };
    return result.error === null ? { ok: true, problem: null } : { ok: false, problem: problem(result, 'the Secret Service cannot be used').message };
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    const result = await this.#run('secret-tool', ['store', '--label', `${ref.service} · ${ref.account}`, 'service', ref.service, 'account', ref.account], value);
    if (result.error !== null || result.code !== 0) throw problem(result, 'the Secret Service refused the value');
  }

  async get(ref: SecretRef): Promise<string | null> {
    const result = await this.#run('secret-tool', ['lookup', 'service', ref.service, 'account', ref.account], null);
    if (result.error === null && result.code === 1 && result.stdout === '') return null;
    if (result.error !== null || result.code !== 0) throw problem(result, 'the Secret Service could not be read');
    return result.stdout.replace(/\r?\n$/, '');
  }

  async delete(ref: SecretRef): Promise<void> {
    const result = await this.#run('secret-tool', ['clear', 'service', ref.service, 'account', ref.account], null);
    if (result.error !== null || (result.code !== 0 && result.code !== 1)) throw problem(result, 'the Secret Service could not remove the value');
  }
}

/** The PowerShell program of {@link WindowsCredentialStore} (no value in it: the value comes on stdin, base64). */
export function windowsCredentialScript(op: 'write' | 'read' | 'delete' | 'probe', target: string, user: string): string {
  const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices; using System.Text;',
    'public static class SbCred {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredWrite(ref CREDENTIAL c, int flags);',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredRead(string target, int type, int flags, out IntPtr c);',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredDelete(string target, int type, int flags);',
    '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);',
    '  public static void Write(string target, string user, string secret) { byte[] b = Encoding.Unicode.GetBytes(secret); CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2; c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocCoTaskMem(b.Length); try { Marshal.Copy(b, 0, c.CredentialBlob, b.Length); if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); } finally { Marshal.FreeCoTaskMem(c.CredentialBlob); } }',
    '  public static string Read(string target) { IntPtr p; if (!CredRead(target, 1, 0, out p)) { int e = Marshal.GetLastWin32Error(); if (e == 1168) return null; throw new System.ComponentModel.Win32Exception(e); } try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); return c.CredentialBlobSize == 0 ? "" : Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); } finally { CredFree(p); } }',
    '  public static void Delete(string target) { if (!CredDelete(target, 1, 0)) { int e = Marshal.GetLastWin32Error(); if (e != 1168) throw new System.ComponentModel.Win32Exception(e); } }',
    '}',
    '"@',
    `$target = ${literal(target)}`,
    `$user = ${literal(user)}`,
    op === 'write'
      ? '$secret = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())); [SbCred]::Write($target, $user, $secret)'
      : op === 'read'
        ? '$v = [SbCred]::Read($target); if ($null -eq $v) { exit 3 } else { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v))) }'
        : op === 'delete'
          ? '[SbCred]::Delete($target)'
          : "[Console]::Out.Write('ok')",
  ].join('\n');
}

/** Windows: Credential Manager through PowerShell (`Add-Type` over `advapi32`'s Cred* API; no extra dependency). */
export class WindowsCredentialStore implements SecretStore {
  readonly name = 'Windows Credential Manager';
  readonly #run: SecretRunner;

  constructor(run: SecretRunner = runSecretCommand) {
    this.#run = run;
  }

  static target(ref: SecretRef): string {
    return `${ref.service}:${ref.account}`;
  }

  #ps(script: string, input: string | null): Promise<SecretCommandResult> {
    return this.#run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], input);
  }

  async available(): Promise<{ readonly ok: boolean; readonly problem: string | null }> {
    const result = await this.#ps(windowsCredentialScript('probe', 'probe', 'probe'), null);
    return result.error === null && result.code === 0 ? { ok: true, problem: null } : { ok: false, problem: problem(result, 'Windows Credential Manager cannot be used (PowerShell)').message };
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    const result = await this.#ps(windowsCredentialScript('write', WindowsCredentialStore.target(ref), ref.account), Buffer.from(value, 'utf8').toString('base64'));
    if (result.error !== null || result.code !== 0) throw problem(result, 'Windows Credential Manager refused the value');
  }

  async get(ref: SecretRef): Promise<string | null> {
    const result = await this.#ps(windowsCredentialScript('read', WindowsCredentialStore.target(ref), ref.account), null);
    if (result.code === 3) return null;
    if (result.error !== null || result.code !== 0) throw problem(result, 'Windows Credential Manager could not be read');
    return Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
  }

  async delete(ref: SecretRef): Promise<void> {
    const result = await this.#ps(windowsCredentialScript('delete', WindowsCredentialStore.target(ref), ref.account), null);
    if (result.error !== null || result.code !== 0) throw problem(result, 'Windows Credential Manager could not remove the value');
  }
}

/** The fake keychain (tests and `SWITCHBOARD_TEST_SECRET_STORE=memory`): a map in memory, with the calls it got. */
export class MemorySecretStore implements SecretStore {
  readonly name: string;
  readonly #values = new Map<string, string>();
  /** Every call (`set` / `get` / `delete` with the account), for tests. */
  readonly calls: Array<{ readonly op: 'set' | 'get' | 'delete'; readonly service: string; readonly account: string }> = [];
  #broken: string | null = null;

  constructor(name = 'In-memory keychain (tests)') {
    this.name = name;
  }

  static #key(ref: SecretRef): string {
    return `${ref.service}\u0000${ref.account}`;
  }

  /** Tests: make the store unavailable (`null` = available again). */
  breakWith(problem: string | null): void {
    this.#broken = problem;
  }

  async available(): Promise<{ readonly ok: boolean; readonly problem: string | null }> {
    return this.#broken ? { ok: false, problem: this.#broken } : { ok: true, problem: null };
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    if (this.#broken) throw new Error(this.#broken);
    this.calls.push({ op: 'set', service: ref.service, account: ref.account });
    this.#values.set(MemorySecretStore.#key(ref), value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    if (this.#broken) throw new Error(this.#broken);
    this.calls.push({ op: 'get', service: ref.service, account: ref.account });
    return this.#values.get(MemorySecretStore.#key(ref)) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    this.calls.push({ op: 'delete', service: ref.service, account: ref.account });
    this.#values.delete(MemorySecretStore.#key(ref));
  }

  /** Tests: every stored entry (service, account, value). */
  entries(): Array<{ readonly service: string; readonly account: string; readonly value: string }> {
    return [...this.#values].map(([key, value]) => {
      const [service, account] = key.split('\u0000') as [string, string];
      return { service, account, value };
    });
  }
}

/**
 * The store for this machine: {@link MemorySecretStore} under Vitest or with
 * `SWITCHBOARD_TEST_SECRET_STORE=memory`; else the OS keychain of `platform`.
 */
export function defaultSecretStore(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SecretStore {
  if (env['VITEST'] || env['SWITCHBOARD_TEST_SECRET_STORE'] === 'memory') return new MemorySecretStore();
  if (platform === 'darwin') return new MacKeychain();
  if (platform === 'win32') return new WindowsCredentialStore();
  return new SecretToolStore();
}
