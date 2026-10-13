import type { JiraConnectionStatus } from '../../../core/plans-jira.ts';
import { normalizeJiraBaseUrl } from '../../../core/plans-jira.ts';
import type { JiraCredentials } from './client.ts';

/**
 * D99-Jira · where the Jira credentials come from (`docs/security.md` → *Jira credentials*):
 *
 * 1. **Settings → Integrations → Jira** (base URL, email, API token), stored as one value in
 *    the OS keychain through a {@link JiraSecretStore} (the Team access lane's `SecretStore`,
 *    `src/server/team/access/secret-store.ts`, has this shape); the database never holds it;
 * 2. else the environment: `ATL_BASE_URL`, `ATL_USER` (the email), `ATL_TOKEN`.
 *
 * The token is only ever put in a request's `Authorization` header to the configured base URL:
 * never answered by a route, never logged, never sent to a paired machine (the credential
 * routes are not on the peer allow-list, and a phone may not call them).
 */

/** A keychain reference (the Team access lane's `SecretRef`). */
export interface JiraSecretRef {
  readonly service: string;
  readonly account: string;
}

/** The part of the Team access lane's `SecretStore` this module uses (structurally the same interface). */
export interface JiraSecretStore {
  readonly name: string;
  available(): Promise<{ readonly ok: boolean; readonly problem: string | null }>;
  set(ref: JiraSecretRef, value: string): Promise<void>;
  get(ref: JiraSecretRef): Promise<string | null>;
  delete(ref: JiraSecretRef): Promise<void>;
}

/** The keychain item of the Settings credentials. */
export const JIRA_SECRET_REF: JiraSecretRef = { service: 'Switchboard Jira', account: 'default' };

/** Why a credential call was refused. */
export class JiraCredentialError extends Error {
  override name = 'JiraCredentialError';
  readonly status: number;
  readonly code: string;
  readonly field: string | null;
  constructor(status: number, code: string, message: string, field: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** Reads the credentials (Settings first, then the environment). */
export class JiraCredentialSource {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #store: JiraSecretStore | null;

  /**
   * @param env The environment to read `ATL_*` from (tests pass their own; the app passes
   *   `process.env`, except under Vitest).
   * @param store The OS keychain; `null` = Settings cannot store credentials here (env only).
   */
  constructor(options: { readonly env: Readonly<Record<string, string | undefined>>; readonly store: JiraSecretStore | null }) {
    this.#env = options.env;
    this.#store = options.store;
  }

  async #fromSettings(): Promise<JiraCredentials | null> {
    if (!this.#store) return null;
    const value = await this.#store.get(JIRA_SECRET_REF).catch(() => null);
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const baseUrl = normalizeJiraBaseUrl(parsed['baseUrl']);
      if (baseUrl && typeof parsed['email'] === 'string' && typeof parsed['token'] === 'string' && parsed['token'] !== '') return { baseUrl, email: parsed['email'], token: parsed['token'] };
    } catch {
      // An unreadable value counts as none.
    }
    return null;
  }

  #fromEnv(): JiraCredentials | null {
    const baseUrl = normalizeJiraBaseUrl(this.#env['ATL_BASE_URL']);
    const email = this.#env['ATL_USER']?.trim();
    const token = this.#env['ATL_TOKEN']?.trim();
    return baseUrl && email && token ? { baseUrl, email, token } : null;
  }

  /** The credentials to use, with where they came from; `null` = Jira is not configured. */
  async resolve(): Promise<{ readonly credentials: JiraCredentials; readonly source: 'settings' | 'env' } | null> {
    const settings = await this.#fromSettings();
    if (settings) return { credentials: settings, source: 'settings' };
    const env = this.#fromEnv();
    return env ? { credentials: env, source: 'env' } : null;
  }

  /** `GET /api/integrations/jira`: the status, never the token. */
  async status(): Promise<JiraConnectionStatus> {
    const keychain = this.#store ? (await this.#store.available().catch(() => ({ ok: false }))).ok : false;
    const found = await this.resolve();
    return { configured: found !== null, source: found?.source ?? null, baseUrl: found?.credentials.baseUrl ?? null, email: found?.credentials.email ?? null, keychain };
  }

  /** `PUT /api/integrations/jira` `{ baseUrl, email, token }`: stores them in the keychain. */
  async save(body: unknown): Promise<JiraConnectionStatus> {
    if (!this.#store || !(await this.#store.available().catch(() => ({ ok: false }))).ok) {
      throw new JiraCredentialError(409, 'keychain-unavailable', 'this machine has no OS keychain Switchboard can use: set ATL_BASE_URL, ATL_USER and ATL_TOKEN in the environment instead');
    }
    const input = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const baseUrl = normalizeJiraBaseUrl(input['baseUrl']);
    if (!baseUrl) throw new JiraCredentialError(422, 'invalid', 'the base URL is your Jira site, e.g. https://acme.atlassian.net', 'baseUrl');
    const email = typeof input['email'] === 'string' ? input['email'].trim() : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new JiraCredentialError(422, 'invalid', 'give the email of the Jira account', 'email');
    const token = typeof input['token'] === 'string' ? input['token'].trim() : '';
    if (token === '' || token.length > 1_000) throw new JiraCredentialError(422, 'invalid', 'give an API token (your Atlassian account → Security → API tokens)', 'token');
    await this.#store.set(JIRA_SECRET_REF, JSON.stringify({ baseUrl, email, token }));
    return this.status();
  }

  /** `DELETE /api/integrations/jira`: removes the Settings credentials (the environment's stay). */
  async clear(): Promise<JiraConnectionStatus> {
    if (this.#store) await this.#store.delete(JIRA_SECRET_REF);
    return this.status();
  }
}
