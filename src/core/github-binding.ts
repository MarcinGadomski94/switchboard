/**
 * D190 (`docs/profiles.md` → *A profile's GitHub account*): a Switchboard profile bound to a GitHub
 * account. The identity (login, name, id, the commit email) is a profile attribute synced with the
 * profile (D165); the sign-in itself is `gh`'s own, per profile and per computer, in
 * `<dataDir>/github/<profile id>/` (`GH_CONFIG_DIR`), never synced and never read by Switchboard.
 */

/** A profile's GitHub account, as `gh api user` named it at sign-in (plus an optional commit email). */
export interface GitHubIdentity {
  /** The account's login (`octocat`). */
  readonly login: string;
  /** Its display name (`null` when the account has none). */
  readonly name: string | null;
  /** Its numeric id (for the noreply email). */
  readonly id: number;
  /** The commit email the developer chose (`null` = the account's noreply address). */
  readonly email: string | null;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const EMAIL = /^[^\s@<>"]{1,128}@[^\s@<>"]{1,128}$/;

/** A login as GitHub allows it (1–39 letters, digits and hyphens, not starting with one), else `null`. */
export function readGitHubLogin(value: unknown): string | null {
  return typeof value === 'string' && LOGIN.test(value) ? value : null;
}

/** A commit email (one line, one `@`, no spaces or angle brackets), else `null`. */
export function readCommitEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  return EMAIL.test(email) ? email : null;
}

/** A stored or received identity, checked (a malformed one is none). */
export function readGitHubIdentity(value: unknown): GitHubIdentity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const login = readGitHubLogin(v['login']);
  const id = v['id'];
  if (!login || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  const rawName = v['name'];
  const name = typeof rawName === 'string' && rawName.trim() !== '' && !/[\r\n]/.test(rawName) ? rawName.trim().slice(0, 100) : null;
  const email = v['email'] === null || v['email'] === undefined ? null : readCommitEmail(v['email']);
  return { login, name, id, email };
}

/** The account's GitHub noreply address (`<id>+<login>@users.noreply.github.com`). */
export function noreplyEmail(identity: Pick<GitHubIdentity, 'id' | 'login'>): string {
  return `${identity.id}+${identity.login}@users.noreply.github.com`;
}

/** The commit author of a bound profile: its name (else its login) and email (the chosen one, else the noreply). */
export function commitAuthor(identity: GitHubIdentity): { readonly name: string; readonly email: string } {
  return { name: identity.name ?? identity.login, email: identity.email ?? noreplyEmail(identity) };
}

/**
 * One argv word for the shell git runs a `!` credential helper in (sh, Git for Windows' too):
 * backslashes as slashes (Windows paths), quoted when it needs it.
 */
export function shellWord(word: string): string {
  const slashed = word.replace(/\\/g, '/');
  return /^[A-Za-z0-9_./:=@+-]+$/.test(slashed) ? slashed : `"${slashed.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** The `!…` credential helper that asks `gh` (the argv prefix `gh`) for github.com's credentials. */
export function ghCredentialHelper(gh: readonly string[]): string {
  return `!${[...gh, 'auth', 'git-credential'].map(shellWord).join(' ')}`;
}

/**
 * The environment a bound profile's agent (and its terminal, and Switchboard's own `gh` calls for it)
 * gets: `gh` signed in as the profile's account (`GH_CONFIG_DIR`), commits authored and committed as
 * it, and HTTPS pushes to github.com through `gh`'s credential helper — set through git's
 * `GIT_CONFIG_*` environment only (an empty helper first resets any configured one for that host);
 * no git config file is ever written.
 */
export function boundEnv(identity: GitHubIdentity, configDir: string, gh: readonly string[]): Record<string, string> {
  const author = commitAuthor(identity);
  return {
    GH_CONFIG_DIR: configDir,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: ghCredentialHelper(gh),
  };
}

/** `gh auth login --web`'s device code (`ABCD-1234`) and the page to enter it on, from its output so far. */
export function parseDeviceLogin(output: string): { readonly code: string | null; readonly url: string | null } {
  const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(output)?.[1]?.toUpperCase() ?? null;
  const url = /(https:\/\/github\.com\/login\/device)\b/.exec(output)?.[1] ?? null;
  return { code, url };
}

/** The state of a sign-in started from Settings (`GET /api/user-profiles/{id}/github`). */
export interface GitHubLoginState {
  readonly state: 'starting' | 'waiting' | 'done' | 'failed' | 'cancelled';
  /** The one-time code to enter on GitHub (once gh printed it). */
  readonly code: string | null;
  /** Where to enter it. */
  readonly url: string | null;
  /** Why it failed (gh's last line), when it did. */
  readonly error: string | null;
}

/** A profile's GitHub binding as Settings shows it. */
export interface GitHubBindingView {
  /** The bound account (synced with the profile), `null` when none. */
  readonly identity: GitHubIdentity | null;
  /** The commit author it gives (when bound). */
  readonly author: { readonly name: string; readonly email: string } | null;
  /** `gh` is signed in for this profile on this computer. */
  readonly signedInHere: boolean;
  /** A sign-in in progress (or just ended) on this computer. */
  readonly login: GitHubLoginState | null;
  /** Paired computers that cannot take the shared sign-in (older than 2.5.15): "Connect GitHub on <computer>". */
  readonly unsynced?: readonly string[];
}

/** How long a device-code sign-in may wait for the developer (GitHub's codes last 15 minutes). */
export const GITHUB_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
