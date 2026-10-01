import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HistoryItem } from '../../core/api.ts';
import { CLI_LABELS, type CliProviderId } from '../../core/cli-providers.ts';
import { clip, filterHistory, type HistoryRow } from '../../core/history.ts';
import type { CliRegistry } from '../cli/registry.ts';
import type { Store } from '../db/store.ts';
import { runCommand, succeeded } from '../exec.ts';
import type { HistoryProvider } from '../providers.ts';
import { childEnv } from '../supervisor/argv.ts';

/**
 * D62 P7 (`docs/providers.md` → *History*): conversations started in a Codex CLI
 * or OpenCode terminal, listed in History next to Claude Code's (D16) and movable
 * into Switchboard as the same conversation. Read only, never the CLIs' private
 * databases or credentials:
 * - Codex: the rollout files `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl`
 *   (VERIFIED `codex-rs/rollout` at rust-v0.159.3): the first line's
 *   `session_meta` (id, cwd, timestamp) and the `response_item` messages;
 * - OpenCode: `opencode session list --format json` in each saved folder and
 *   `opencode export <id>` (VERIFIED `cli/cmd/session.ts`, `export.ts` at v1.18.34).
 */

/** One message of a moved conversation (what the import stores as events). */
export interface CliMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly ts: string | null;
}

/** A conversation of another CLI, as History lists it. */
export interface CliConversation {
  readonly provider: Exclude<CliProviderId, 'claude'>;
  /** The CLI's own id (a Codex thread id, an OpenCode session id). */
  readonly nativeId: string;
  readonly title: string | null;
  readonly firstPrompt: string | null;
  readonly lastText: string | null;
  readonly startedAt: string;
  readonly cwd: string | null;
}

/** The newest rollout files read per listing. */
export const CODEX_ROLLOUT_LIMIT = 200;
/** Bytes read from the head of a rollout file for the listing. */
const ROLLOUT_HEAD_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv): string {
  return env['CODEX_HOME'] && env['CODEX_HOME'].trim() !== '' ? env['CODEX_HOME'] : path.join(os.homedir(), '.codex');
}

/** A user message Codex adds itself (its environment and instructions blocks), not the developer's prompt (ASSUMED D62-codex-history). */
function isContextBlock(value: string): boolean {
  return /^\s*<(environment_context|user_instructions|permissions|turn_aborted)\b/.test(value);
}

/** The messages of a rollout file's lines (the whole file for a move, its head for a listing). */
export function rolloutMessages(lines: readonly string[]): { readonly meta: Record<string, unknown> | null; readonly messages: CliMessage[] } {
  let meta: Record<string, unknown> | null = null;
  const messages: CliMessage[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed['payload'])) continue;
    const payload = parsed['payload'];
    if (parsed['type'] === 'session_meta' && !meta) meta = payload;
    if (parsed['type'] !== 'response_item' || payload['type'] !== 'message') continue;
    const role = payload['role'];
    if (role !== 'user' && role !== 'assistant') continue;
    const content = Array.isArray(payload['content']) ? payload['content'] : [];
    const joined = content
      .filter(isRecord)
      .map((block) => text(block['text']) ?? '')
      .filter((part) => part !== '')
      .join('\n');
    if (joined === '' || (role === 'user' && isContextBlock(joined))) continue;
    messages.push({ role, text: joined, ts: text(parsed['timestamp']) });
  }
  return { meta, messages };
}

async function readHead(file: string, bytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    // Only whole lines.
    return bytesRead === bytes ? head.slice(0, head.lastIndexOf('\n') + 1) : head;
  } finally {
    await handle.close();
  }
}

/** The newest rollout files (by name: they start with their UTC time). */
async function rolloutFiles(home: string, limit: number): Promise<string[]> {
  const root = path.join(home, 'sessions');
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (found.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(full, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) found.push(full);
    }
  };
  await walk(root, 0);
  return found;
}

/** Codex's conversations from its rollout files (the newest {@link CODEX_ROLLOUT_LIMIT}). */
export async function codexConversations(env: NodeJS.ProcessEnv): Promise<CliConversation[]> {
  const out: CliConversation[] = [];
  for (const file of await rolloutFiles(codexHome(env), CODEX_ROLLOUT_LIMIT)) {
    try {
      const { meta, messages } = rolloutMessages((await readHead(file, ROLLOUT_HEAD_BYTES)).split('\n'));
      const id = meta ? text(meta['id']) : null;
      if (!id) continue;
      const first = messages.find((message) => message.role === 'user')?.text ?? null;
      const last = [...messages].reverse().find((message) => message.role === 'assistant')?.text ?? null;
      const started = (meta ? text(meta['timestamp']) : null) ?? (await stat(file)).mtime.toISOString();
      out.push({ provider: 'codex', nativeId: id, title: first ? clip(first, 80) : null, firstPrompt: first, lastText: last, startedAt: started, cwd: meta ? text(meta['cwd']) : null });
    } catch {
      // An unreadable file is left out.
    }
  }
  return out;
}

/** A Codex thread's messages from its rollout file (a move's import); `null` when there is none. */
export async function codexThreadMessages(env: NodeJS.ProcessEnv, threadId: string): Promise<CliMessage[] | null> {
  for (const file of await rolloutFiles(codexHome(env), Number.MAX_SAFE_INTEGER)) {
    if (!file.endsWith(`-${threadId}.jsonl`)) continue;
    const { messages } = rolloutMessages((await readHead(file, 32 * 1024 * 1024)).split('\n'));
    return messages;
  }
  return null;
}

/** `opencode session list --format json` rows (`[{id, title, updated, created, projectId, directory}]`). */
export function parseOpencodeSessions(stdout: string): CliConversation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecord).flatMap((row): CliConversation[] => {
    const id = text(row['id']);
    if (!id) return [];
    const created = typeof row['created'] === 'number' ? new Date(row['created']).toISOString() : (text(row['created']) ?? new Date(0).toISOString());
    return [{ provider: 'opencode', nativeId: id, title: text(row['title']), firstPrompt: null, lastText: null, startedAt: created, cwd: text(row['directory']) }];
  });
}

/** `opencode export <id>` (`{info, messages: [{info: {role, time}, parts}]}`) as messages (text parts only). */
export function parseOpencodeExport(stdout: string): CliMessage[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['messages'])) return null;
  const out: CliMessage[] = [];
  for (const message of parsed['messages'].filter(isRecord)) {
    const info = isRecord(message['info']) ? message['info'] : {};
    const role = info['role'];
    if (role !== 'user' && role !== 'assistant') continue;
    const parts = Array.isArray(message['parts']) ? message['parts'].filter(isRecord) : [];
    const joined = parts
      .filter((part) => part['type'] === 'text' && part['synthetic'] !== true)
      .map((part) => text(part['text']) ?? '')
      .filter((part) => part !== '')
      .join('\n');
    if (joined === '') continue;
    const time = isRecord(info['time']) ? info['time'] : {};
    out.push({ role, text: joined, ts: typeof time['created'] === 'number' ? new Date(time['created']).toISOString() : null });
  }
  return out;
}

/** Options of {@link CliHistory}. */
export interface CliHistoryOptions {
  readonly store: Store;
  readonly registry: CliRegistry;
  readonly env?: NodeJS.ProcessEnv;
  /** Where OpenCode's listing runs when no folder is saved. */
  readonly cwd: string;
  /** How long a listing is reused (ms). */
  readonly ttlMs?: number;
}

/**
 * D62 P7: History = Claude Code's rows ({@link base}) + the Codex / OpenCode
 * conversations not in Switchboard yet, each a terminal row with its `provider`
 * (Continue in Switchboard moves it with `POST /api/history/cli/{provider}/{id}/continue`).
 */
export class CliHistory implements HistoryProvider {
  readonly #base: HistoryProvider;
  readonly #options: CliHistoryOptions;
  #cache: { readonly at: number; readonly rows: CliConversation[] } | null = null;

  constructor(base: HistoryProvider, options: CliHistoryOptions) {
    this.#base = base;
    this.#options = options;
  }

  async history(q?: string): Promise<HistoryItem[]> {
    const [base, conversations] = await Promise.all([this.#base.history(q), this.conversations()]);
    const folders = await this.#options.store.folders.list();
    const rows: HistoryRow[] = [];
    for (const conversation of conversations) {
      if (await this.#options.store.providers.sessionByNative(conversation.provider, conversation.nativeId)) continue;
      const folder = conversation.cwd ? folders.filter((entry) => conversation.cwd === entry.canonicalPath || conversation.cwd?.startsWith(`${entry.canonicalPath}${path.sep}`)).sort((a, b) => b.canonicalPath.length - a.canonicalPath.length)[0] : undefined;
      const item: HistoryItem = {
        claudeSessionId: `${conversation.provider}:${conversation.nativeId}`,
        sessionId: null,
        startedAt: conversation.startedAt,
        name: clip(conversation.title ?? conversation.firstPrompt ?? conversation.nativeId, 80),
        mode: `terminal · ${CLI_LABELS[conversation.provider]}`,
        summary: clip(conversation.lastText ?? '', 240),
        branches: [],
        solutions: [],
        outcome: 'ended',
        status: 'idle',
        folder: folder?.id ?? null,
        folderPath: folder?.canonicalPath ?? conversation.cwd,
        terminal: true,
        firstPrompt: conversation.firstPrompt ? clip(conversation.firstPrompt, 240) : null,
        cwd: conversation.cwd,
        provider: conversation.provider,
        nativeId: conversation.nativeId,
      };
      rows.push({ item, search: [item.name, item.summary, item.firstPrompt ?? '', item.folderPath ?? '', conversation.nativeId, CLI_LABELS[conversation.provider]].join(' ').toLowerCase() });
    }
    const extra = filterHistory(rows, q);
    return [...base, ...extra].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Every Codex / OpenCode conversation the CLIs' own records list (cached for {@link CliHistoryOptions.ttlMs}). */
  async conversations(): Promise<CliConversation[]> {
    const ttl = this.#options.ttlMs ?? 30_000;
    if (this.#cache && Date.now() - this.#cache.at < ttl) return this.#cache.rows;
    const env = this.#options.env ?? process.env;
    const [codex, opencode] = await Promise.all([codexConversations(env).catch(() => []), this.#opencode(env).catch(() => [])]);
    const rows = [...codex, ...opencode];
    this.#cache = { at: Date.now(), rows };
    return rows;
  }

  /** One conversation by id (fresh, not from the cache). */
  async find(provider: Exclude<CliProviderId, 'claude'>, nativeId: string): Promise<CliConversation | null> {
    this.#cache = null;
    return (await this.conversations()).find((row) => row.provider === provider && row.nativeId === nativeId) ?? null;
  }

  /** The conversation's messages for a move's import. */
  async messages(conversation: CliConversation): Promise<CliMessage[]> {
    const env = this.#options.env ?? process.env;
    if (conversation.provider === 'codex') return (await codexThreadMessages(env, conversation.nativeId)) ?? [];
    const command = await this.#options.registry.command('opencode');
    const result = await runCommand(command, ['export', conversation.nativeId], { cwd: conversation.cwd ?? this.#options.cwd, env: childEnv(env), timeoutMs: 30_000, maxOutputBytes: 64 * 1024 * 1024 });
    return succeeded(result) ? (parseOpencodeExport(result.stdout) ?? []) : [];
  }

  async #opencode(env: NodeJS.ProcessEnv): Promise<CliConversation[]> {
    const command = await this.#options.registry.command('opencode');
    const folders = (await this.#options.store.folders.list()).map((folder) => folder.canonicalPath);
    const places = folders.length > 0 ? folders : [this.#options.cwd];
    const seen = new Map<string, CliConversation>();
    for (const cwd of places) {
      const result = await runCommand(command, ['session', 'list', '--format', 'json'], { cwd, env: childEnv(env), timeoutMs: 20_000, maxOutputBytes: 8 * 1024 * 1024 });
      if (!succeeded(result)) continue;
      for (const row of parseOpencodeSessions(result.stdout)) if (!seen.has(row.nativeId)) seen.set(row.nativeId, row);
    }
    return [...seen.values()];
  }
}
