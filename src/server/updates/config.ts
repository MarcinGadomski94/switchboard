import { RELEASE_REPO } from '../../core/release.ts';
import type { InstallKind } from '../../core/updates.ts';
import { ConfigError, parseCommand } from '../config.ts';

/**
 * The updater's environment variables (D55, `docs/configuration.md`,
 * `docs/updates.md` → *Configuration*). Read once at start.
 */
export interface UpdateConfig {
  /** `SWITCHBOARD_UPDATES=off` switches checking (and updating) off. */
  readonly enabled: boolean;
  /** `SWITCHBOARD_UPDATE_REPO` (`owner/name`), default {@link RELEASE_REPO}: forks and tests. */
  readonly repo: string;
  /**
   * **Tests only:** `SWITCHBOARD_UPDATE_API`, the origin of a fake GitHub (e.g.
   * `http://127.0.0.1:4940`). The API and every download then must come from it.
   */
  readonly testOrigin: string | null;
  /** `SWITCHBOARD_NPM_BIN` (argv prefix, like `SWITCHBOARD_GH_BIN`): the npm that runs `npm ci`; default: found next to node. */
  readonly npmCommand: readonly string[] | null;
  /** **Tests only**, honored only with {@link testOrigin}: `SWITCHBOARD_UPDATE_TEST_INSTALL=release|git` instead of looking for `.git`. */
  readonly testInstallKind: InstallKind | null;
  /**
   * **Tests only**, honored only with {@link testOrigin} and the service
   * redirect (`SWITCHBOARD_SERVICE_HOME` + `SWITCHBOARD_SERVICE_CTL`):
   * `SWITCHBOARD_UPDATE_TEST_UNDER_SERVICE=1` acts as if this process were the
   * login service's instance.
   */
  readonly testUnderService: boolean;
}

/**
 * Reads the updater's variables.
 * @throws {ConfigError} on an unusable value.
 */
export function loadUpdateConfig(env: NodeJS.ProcessEnv = process.env, options: { readonly serviceRedirect?: boolean } = {}): UpdateConfig {
  const flag = env['SWITCHBOARD_UPDATES']?.trim().toLowerCase() ?? '';
  if (flag !== '' && flag !== 'on' && flag !== 'off') throw new ConfigError(`SWITCHBOARD_UPDATES must be "on" or "off", got "${env['SWITCHBOARD_UPDATES']}"`);
  const repo = env['SWITCHBOARD_UPDATE_REPO']?.trim() || RELEASE_REPO;
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) || repo.includes('..')) throw new ConfigError(`SWITCHBOARD_UPDATE_REPO must be owner/name, got "${repo}"`);
  let testOrigin: string | null = null;
  const api = env['SWITCHBOARD_UPDATE_API']?.trim() ?? '';
  if (api !== '') {
    let url: URL;
    try {
      url = new URL(api);
    } catch {
      throw new ConfigError(`SWITCHBOARD_UPDATE_API must be a URL, got "${api}"`);
    }
    // A test redirect: only a loopback fake.
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new ConfigError('SWITCHBOARD_UPDATE_API is a test redirect and must be http://127.0.0.1:<port>');
    testOrigin = url.origin;
  }
  const npm = env['SWITCHBOARD_NPM_BIN']?.trim() ? parseCommand('SWITCHBOARD_NPM_BIN', env['SWITCHBOARD_NPM_BIN'], 'npm') : null;
  const kind = env['SWITCHBOARD_UPDATE_TEST_INSTALL']?.trim() ?? '';
  if (kind !== '' && kind !== 'git' && kind !== 'release') throw new ConfigError('SWITCHBOARD_UPDATE_TEST_INSTALL must be "git" or "release"');
  if (kind !== '' && !testOrigin) throw new ConfigError('SWITCHBOARD_UPDATE_TEST_INSTALL is a test redirect and needs SWITCHBOARD_UPDATE_API');
  const underService = env['SWITCHBOARD_UPDATE_TEST_UNDER_SERVICE'] === '1';
  if (underService && (!testOrigin || !options.serviceRedirect)) {
    throw new ConfigError('SWITCHBOARD_UPDATE_TEST_UNDER_SERVICE is a test redirect and needs SWITCHBOARD_UPDATE_API and the service redirect');
  }
  return {
    enabled: flag !== 'off',
    repo,
    testOrigin,
    npmCommand: npm,
    testInstallKind: kind === '' ? null : kind,
    testUnderService: underService,
  };
}
