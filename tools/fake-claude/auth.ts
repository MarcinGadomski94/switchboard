import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

/**
 * D63 (`docs/fake-claude.md` → *Accounts*): the fake's `claude auth login | logout | status`.
 * The sign-in state of a config folder is the file `<CLAUDE_CONFIG_DIR>/.fake-auth.json`
 * (`{loggedIn, email}`); nothing else is ever written and no real credential exists.
 * Without that file a folder is signed in (as before D63), unless
 * `FAKE_CLAUDE_AUTH_REQUIRED=1` (then only a folder with the file is) or
 * `FAKE_CLAUDE_SIGNED_OUT=1` (nothing is).
 */
const FILE = '.fake-auth.json';

export interface FakeAuth {
  readonly loggedIn: boolean;
  readonly email: string | null;
}

export async function readFakeAuth(configDir: string | null, env: NodeJS.ProcessEnv): Promise<FakeAuth> {
  if (env['FAKE_CLAUDE_SIGNED_OUT'] === '1') return { loggedIn: false, email: null };
  if (configDir !== null) {
    try {
      const stored = JSON.parse(await readFile(path.join(configDir, FILE), 'utf8')) as { loggedIn?: unknown; email?: unknown };
      return { loggedIn: stored.loggedIn === true, email: typeof stored.email === 'string' ? stored.email : null };
    } catch {
      // No file: the rule above.
    }
  }
  return { loggedIn: env['FAKE_CLAUDE_AUTH_REQUIRED'] !== '1', email: null };
}

/** `auth status [--json | --text]`: the JSON the real CLI prints (VERIFIED 2.1.285: `loggedIn`, `authMethod`, `apiProvider`, `email`, `subscriptionType`); exit 0 signed in, 1 signed out. */
export async function authStatus(configDir: string | null, env: NodeJS.ProcessEnv, json: boolean): Promise<{ readonly out: string; readonly code: number }> {
  const auth = await readFakeAuth(configDir, env);
  if (json) {
    const body = { loggedIn: auth.loggedIn, authMethod: auth.loggedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty', ...(auth.loggedIn ? { email: auth.email ?? 'fake@example.test', subscriptionType: 'max' } : {}), ...(configDir ? { configDirectory: configDir } : {}) };
    return { out: `${JSON.stringify(body, null, 2)}\n`, code: auth.loggedIn ? 0 : 1 };
  }
  return { out: auth.loggedIn ? `Login method: Claude Max Account\nEmail: ${auth.email ?? 'fake@example.test'}\n` : 'Not logged in. Run claude auth login to authenticate.\n', code: auth.loggedIn ? 0 : 1 };
}

/** `auth logout`: removes the state file (the folder is signed out afterwards). */
export async function authLogout(configDir: string | null): Promise<{ readonly out: string; readonly code: number }> {
  if (configDir === null) return { out: 'fake-claude: CLAUDE_CONFIG_DIR is not set; nothing to sign out of\n', code: 1 };
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, FILE), `${JSON.stringify({ loggedIn: false, email: null })}\n`);
  return { out: 'Successfully logged out from your Anthropic account.\n', code: 0 };
}

/**
 * `auth login [--claudeai | --console] [--email <e>]`: prints the lines the real CLI prints
 * (VERIFIED 2.1.285: "Opening browser to sign in…", "If the browser didn't open, visit: <url>",
 * "Paste code here if prompted > ", then "Login successful."). `FAKE_CLAUDE_LOGIN_MODE`:
 * `auto` (default: signs in after `FAKE_CLAUDE_LOGIN_MS`, 300 ms), `code` (waits for a
 * line on stdin), `never` (waits until it is stopped), `fail` (exit 1).
 */
export async function authLogin(
  options: { readonly email: string | null },
  configDir: string | null,
  env: NodeJS.ProcessEnv,
  write: (text: string) => void,
  stdin: NodeJS.ReadableStream,
): Promise<number> {
  const mode = env['FAKE_CLAUDE_LOGIN_MODE'] ?? 'auto';
  const url = env['FAKE_CLAUDE_LOGIN_URL'] ?? `https://login.fake-claude.example.test/oauth/authorize?client=fake&state=${Math.random().toString(16).slice(2, 10)}`;
  write('Opening browser to sign in…\n');
  write(`If the browser didn't open, visit: ${url}\n`);
  write('Paste code here if prompted > ');
  if (configDir === null) {
    write('\nfake-claude: CLAUDE_CONFIG_DIR is not set; the fake will not write a login\n');
    return 1;
  }
  if (mode === 'fail') {
    write('\nLogin failed: the fake refused.\n');
    return 1;
  }
  if (mode === 'never') {
    await new Promise<never>(() => setInterval(() => undefined, 1 << 30));
  }
  if (mode === 'code') {
    const line = await new Promise<string>((resolve) => {
      const reader = createInterface({ input: stdin });
      reader.once('line', (text) => resolve(text));
      reader.once('close', () => resolve(''));
    });
    if (line.trim() === '') return 1;
  } else {
    await new Promise((resolve) => setTimeout(resolve, Number(env['FAKE_CLAUDE_LOGIN_MS'] ?? 300)));
  }
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, FILE), `${JSON.stringify({ loggedIn: true, email: options.email ?? 'account@example.test' })}\n`);
  write('\nLogin successful.\n');
  return 0;
}
