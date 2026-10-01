import type { CliInfo, CliOverview, SessionModelOption } from '../../core/api.ts';
import { CLI_BIN_ENV, CLI_DEFAULT_COMMAND, CLI_INSTALL, CLI_LABELS, CLI_PROVIDERS, type CliProviderId, DEFAULT_CLI_PROVIDER, readCliProvider } from '../../core/cli-providers.ts';
import type { SettingRepository } from '../db/repos/settings.ts';
import { type RunResult, runCommand, succeeded } from '../exec.ts';
import { readModelOptionsSetting, rememberModelOptions } from '../settings/models.ts';
import { childEnv } from '../supervisor/argv.ts';
import { resolveExecutable } from '../system/probe.ts';
import { CLI_DEFAULT_KEY, type CliRegistry } from './registry.ts';

/** How long one check of a CLI may take (`--version`, the sign-in check). */
export const CLI_STATUS_TIMEOUT_MS = 20_000;

/** How long a check is reused before the next read runs it again (ms). */
export const CLI_STATUS_TTL_MS = 60_000;

/**
 * D62: a provider's model list straight from its CLI (Settings → CLIs → Check,
 * no model call): Codex's `model/list` through a short-lived app-server, OpenCode's
 * `opencode models`. Registered by the provider modules; Claude Code reports its
 * models in each session's `initialize` (D31 / D42) and has none.
 */
export type ModelLister = (command: readonly string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<SessionModelOption[] | null>;

/** Options of {@link CliStatusService}. */
export interface CliStatusOptions {
  readonly registry: CliRegistry;
  readonly settings: SettingRepository;
  /** Where the checks run (the data folder). */
  readonly cwd: string;
  /** The base environment (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Which providers have their command from the environment (`SWITCHBOARD_<X>_BIN` set). */
  readonly envCommands?: Partial<Record<CliProviderId, boolean>>;
  readonly listModels?: Partial<Record<CliProviderId, ModelLister>>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** ANSI escapes and the clack prompt glyphs OpenCode prints around its lists. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[│┌└◇●○◆▲■]/g, ' ');
}

function firstLine(text: string): string | null {
  for (const line of plain(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return null;
}

/** What a sign-in check found. */
export interface SignIn {
  readonly signedIn: boolean | null;
  readonly account: string | null;
}

/**
 * D62: `codex login status` (VERIFIED `codex-rs/cli/src/login.rs` at
 * rust-v0.159.3): exit 0 with "Logged in using …" (stderr), exit 1 with "Not
 * logged in". An API key in the environment (`OPENAI_API_KEY`, `CODEX_API_KEY`)
 * works without a login, so a signed-out answer with one set is "unknown"
 * (ASSUMED D62-codex-env-key).
 */
export function codexSignIn(result: RunResult, env: NodeJS.ProcessEnv): SignIn {
  const said = firstLine(`${result.stderr}\n${result.stdout}`);
  if (succeeded(result)) return { signedIn: true, account: said };
  if (result.error) return { signedIn: null, account: null };
  if (env['OPENAI_API_KEY'] || env['CODEX_API_KEY']) return { signedIn: null, account: 'an API key in the environment' };
  return { signedIn: false, account: said };
}

/**
 * D62: `opencode auth list` (VERIFIED `packages/opencode/src/cli/cmd/providers.ts`
 * at v1.18.34): "N credentials", plus "M environment variable(s)" when provider
 * keys are in the environment. Any of either = signed in; none = unknown, since a
 * provider that needs no key (a local model) still works (ASSUMED D62-opencode-auth).
 */
export function opencodeSignIn(result: RunResult): SignIn {
  if (!succeeded(result)) return { signedIn: null, account: null };
  const text = plain(`${result.stdout}\n${result.stderr}`);
  const credentials = /(\d+)\s+credentials?\b/i.exec(text);
  const environment = /(\d+)\s+environment variables?\b/i.exec(text);
  const count = Number(credentials?.[1] ?? 0) + Number(environment?.[1] ?? 0);
  const parts = [credentials ? `${credentials[1]} credential${credentials[1] === '1' ? '' : 's'}` : null, environment ? `${environment[1]} environment variable${environment[1] === '1' ? '' : 's'}` : null].filter(
    (part): part is string => part !== null,
  );
  return { signedIn: count > 0 ? true : null, account: parts.length > 0 ? parts.join(', ') : null };
}

/** `claude auth status`: exit 0 = signed in (M5.3, unchanged). */
export function claudeSignIn(result: RunResult): SignIn {
  return { signedIn: succeeded(result), account: null };
}

/**
 * D62 (`docs/providers.md` → *Settings*): what each CLI is, whether it is
 * installed and signed in, its models, and whether a session can be started on
 * it. Checks run the CLI's own read-only commands (argv arrays, time-limited);
 * no credential file is ever read. Results are kept for {@link CLI_STATUS_TTL_MS}.
 */
export class CliStatusService {
  readonly #options: CliStatusOptions;
  readonly #cache = new Map<CliProviderId, { readonly at: number; readonly info: CliInfo }>();
  readonly #inflight = new Map<CliProviderId, Promise<CliInfo>>();

  constructor(options: CliStatusOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  /** The default CLI for new sessions (`cli.default`, else Claude Code). */
  async defaultProvider(): Promise<CliProviderId> {
    return readCliProvider(await this.#options.settings.get(CLI_DEFAULT_KEY));
  }

  async setDefaultProvider(provider: CliProviderId): Promise<void> {
    await this.#options.settings.set(CLI_DEFAULT_KEY, provider);
  }

  /** Every CLI (cached checks). */
  async overview(options: { readonly refresh?: boolean } = {}): Promise<CliOverview> {
    const clis = await Promise.all(CLI_PROVIDERS.map((provider) => this.info(provider, options)));
    return { default: await this.defaultProvider(), clis };
  }

  /** One CLI; `refresh` runs the checks again (Settings → CLIs → Check). */
  async info(provider: CliProviderId, options: { readonly refresh?: boolean } = {}): Promise<CliInfo> {
    const cached = this.#cache.get(provider);
    if (!options.refresh && cached && this.#now() - cached.at < CLI_STATUS_TTL_MS) return cached.info;
    const running = this.#inflight.get(provider);
    if (running) return running;
    const run = this.#check(provider, options.refresh === true).finally(() => this.#inflight.delete(provider));
    this.#inflight.set(provider, run);
    const info = await run;
    this.#cache.set(provider, { at: this.#now(), info });
    return info;
  }

  /** Forget the cached checks (a command override changed). */
  invalidate(provider?: CliProviderId): void {
    if (provider) this.#cache.delete(provider);
    else this.#cache.clear();
  }

  /**
   * Why a session cannot start on `provider` now, `null` when it can. Claude Code
   * is never refused here (as before D62: a missing `claude` fails at the spawn,
   * shown in the chat).
   */
  async refusal(provider: CliProviderId): Promise<string | null> {
    if (provider === 'claude') return null;
    const info = await this.info(provider);
    return info.available ? null : info.reason;
  }

  async #check(provider: CliProviderId, listModels: boolean): Promise<CliInfo> {
    const { registry, settings } = this.#options;
    const baseEnv = this.#options.env ?? process.env;
    const env = childEnv(baseEnv);
    const cwd = this.#options.cwd;
    const override = await registry.overrideCommand(provider);
    const command = override ?? registry.configuredCommand(provider);
    const commandSource: CliInfo['commandSource'] = override ? 'settings' : this.#options.envCommands?.[provider] ? 'env' : 'default';
    const run = (args: readonly string[]): Promise<RunResult> =>
      runCommand(command, args, { cwd, env, timeoutMs: this.#options.timeoutMs ?? CLI_STATUS_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 });
    const version = await run(['--version']);
    const installed = succeeded(version);
    let signIn: SignIn = { signedIn: null, account: null };
    if (installed) {
      switch (provider) {
        case 'claude':
          signIn = claudeSignIn(await run(['auth', 'status']));
          break;
        case 'codex':
          signIn = codexSignIn(await run(['login', 'status']), baseEnv);
          break;
        case 'opencode':
          signIn = opencodeSignIn(await run(['auth', 'list']));
          break;
      }
    }
    let models = await readModelOptionsSetting(settings, provider);
    const lister = this.#options.listModels?.[provider];
    if (installed && lister && (listModels || models === null)) {
      try {
        const listed = await lister(command, env, cwd);
        if (listed && listed.length > 0) {
          models = listed;
          await rememberModelOptions(settings, listed, provider);
        }
      } catch {
        // A list that cannot be read keeps the last one (the first session's `initialize` fills it in).
      }
    }
    const supported = registry.hasAdapter(provider);
    const path = command.length === 1 ? await resolveExecutable(command[0] as string, baseEnv, cwd) : command.join(' ');
    const reason = !supported
      ? `${CLI_LABELS[provider]} is not supported by this Switchboard`
      : !installed
        ? `${CLI_LABELS[provider]} is not installed (\`${command.join(' ')} --version\` failed${version.error ? `: ${version.error.message}` : ''})`
        : signIn.signedIn === false
          ? `${CLI_LABELS[provider]} is signed out: ${CLI_INSTALL[provider].signIn}`
          : null;
    return {
      provider,
      label: CLI_LABELS[provider],
      command,
      commandSource,
      envVar: CLI_BIN_ENV[provider],
      path: installed ? path : null,
      installed,
      version: installed ? firstLine(version.stdout) ?? firstLine(version.stderr) : null,
      signedIn: installed ? signIn.signedIn : null,
      account: installed ? signIn.account : null,
      supported,
      // Claude Code stays choosable as before D62 (its failures show at the spawn).
      available: provider === 'claude' ? true : reason === null,
      reason,
      models,
      checkedAt: new Date(this.#now()).toISOString(),
      install: CLI_INSTALL[provider],
    };
  }
}

/** The bare names, for {@link CliStatusOptions.envCommands}: a configured command that is not the bare default came from the environment. */
export function envCommandFlags(commands: Partial<Record<CliProviderId, readonly string[]>>): Partial<Record<CliProviderId, boolean>> {
  const flags: Partial<Record<CliProviderId, boolean>> = {};
  for (const provider of CLI_PROVIDERS) {
    const command = commands[provider];
    flags[provider] = command !== undefined && !(command.length === 1 && command[0] === CLI_DEFAULT_COMMAND[provider]);
  }
  return flags;
}

export { DEFAULT_CLI_PROVIDER };
