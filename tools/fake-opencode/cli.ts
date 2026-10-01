import { appendFile } from 'node:fs/promises';
import { loadStore, saveStore } from './store.ts';
import { serve } from './server.ts';

/** The version the fake reports (OpenCode `v1.18.34`, the release read for D62). */
export const FAKE_OPENCODE_VERSION = '1.18.34';

const env = process.env;

function out(text: string): Promise<void> {
  return new Promise((resolve) => process.stdout.write(text, () => resolve()));
}

function err(text: string): Promise<void> {
  return new Promise((resolve) => process.stderr.write(text, () => resolve()));
}

let logWrites: Promise<void> = Promise.resolve();

/** `FAKE_OPENCODE_LOG`: one JSON line per argv / HTTP request (tests assert what Switchboard sent). */
export function log(entry: Record<string, unknown>): Promise<void> {
  const file = env['FAKE_OPENCODE_LOG'];
  if (!file) return Promise.resolve();
  const text = `${JSON.stringify({ ...entry, pid: process.pid })}\n`;
  logWrites = logWrites.then(() => appendFile(file, text));
  return logWrites;
}

/**
 * `opencode providers list` / `auth list` (VERIFIED `packages/opencode/src/cli/cmd/providers.ts`
 * at v1.18.34): clack output, `N credentials` at the end. The fake prints one
 * credential (OpenAI, api), none with `FAKE_OPENCODE_SIGNED_OUT=1`.
 */
async function authList(): Promise<number> {
  const signedOut = env['FAKE_OPENCODE_SIGNED_OUT'] === '1';
  await out('┌  Credentials ~/.local/share/opencode/auth.json\n│\n');
  if (!signedOut) await out('●  OpenAI \u001b[90mapi\u001b[39m\n│\n');
  await out(`└  ${signedOut ? 0 : 1} credentials\n`);
  return 0;
}

/** The models `GET /config/providers` has, as `provider/model` lines (`opencode models`). */
export const FAKE_OPENCODE_MODEL_LINES = ['anthropic/claude-sonnet-5', 'openai/gpt-5.5'];

/** Runs one command line; `null` = keep running (the server). */
export async function runCli(argv: readonly string[]): Promise<number | null> {
  await log({ kind: 'argv', argv, cwd: process.cwd(), env: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('FAKE_OPENCODE_') || key === 'XDG_DATA_HOME' || key === 'OPENCODE_CONFIG_CONTENT')) });
  const [first, ...rest] = argv;
  if (first === '--version' || first === '-v') {
    await out(`${FAKE_OPENCODE_VERSION}\n`);
    return 0;
  }
  if ((first === 'auth' || first === 'providers') && (rest[0] === 'list' || rest[0] === 'ls')) return authList();
  if (first === 'models') {
    const provider = rest.find((part) => !part.startsWith('-'));
    const lines = FAKE_OPENCODE_MODEL_LINES.filter((line) => !provider || line.startsWith(`${provider}/`));
    if (provider && lines.length === 0) {
      await err(`Provider not found: ${provider}\n`);
      return 1;
    }
    await out(`${lines.join('\n')}\n`);
    return 0;
  }
  if (first === 'session' && (rest[0] === 'list' || rest[0] === 'ls')) {
    const store = await loadStore(env);
    const rows = store.sessions
      .filter((session) => !session['parentID'])
      .map((session) => {
        const time = (session['time'] ?? {}) as Record<string, unknown>;
        return { id: session['id'], title: session['title'], updated: time['updated'], created: time['created'], projectId: session['projectID'], directory: session['directory'] };
      });
    if (rest.includes('json') || rest.includes('--format=json')) await out(`${JSON.stringify(rows, null, 2)}\n`);
    else for (const row of rows) await out(`${String(row.id)}  ${String(row.title)}\n`);
    return 0;
  }
  if (first === 'export') {
    const id = rest.find((part) => !part.startsWith('-'));
    const store = await loadStore(env);
    const info = store.sessions.find((session) => session['id'] === id);
    if (!info) {
      await err(`Session not found: ${id ?? ''}\n`);
      return 1;
    }
    await out(`${JSON.stringify({ info, messages: store.messages[id as string] ?? [] }, null, 2)}\n`);
    return 0;
  }
  if (first === 'mcp' && (rest[0] === 'list' || rest[0] === 'ls')) {
    const store = await loadStore(env);
    const names = Object.keys(store.mcp);
    if (names.length === 0) {
      await out('No MCP servers configured\n');
      return 0;
    }
    for (const name of names) {
      const config = store.mcp[name] ?? {};
      const target = config['type'] === 'remote' ? String(config['url'] ?? '') : (Array.isArray(config['command']) ? config['command'].join(' ') : '');
      await out(`${config['enabled'] === false ? '○' : '✓'} ${name} ${config['enabled'] === false ? 'disabled' : 'connected'}\n    ${target}\n`);
    }
    return 0;
  }
  if (first === 'mcp' && rest[0] === '__fake-add') {
    // Tests only: seed a server (the real `opencode mcp add` is interactive).
    const store = await loadStore(env);
    store.mcp[rest[1] as string] = JSON.parse(rest[2] ?? '{}') as Record<string, unknown>;
    await saveStore(env, store);
    return 0;
  }
  if (first === 'serve') return serve(rest, { log });
  await err(`fake-opencode: unknown command ${argv.join(' ')}\n`);
  return 1;
}
