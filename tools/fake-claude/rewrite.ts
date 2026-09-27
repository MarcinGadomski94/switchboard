import { randomBytes, randomUUID } from 'node:crypto';
import { type Json, type JsonObject, isObject } from './json.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Anthropic API ids as they appear in the stream: `toolu_01…`, `msg_01…`, `req_01…`, `srvtoolu_01…`. */
const API_ID_RE = /^(toolu|msg|req|srvtoolu)_01[A-Za-z0-9]{10,}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += BASE62[byte % 62];
  return out;
}

/** `true` for a value the fake rewrites as an id (uuid or API id). */
export function isRewritableId(value: string): boolean {
  return UUID_RE.test(value) || API_ID_RE.test(value);
}

/**
 * Maps recorded ids to fresh ones for one playback, so every run gets new ids
 * while references inside the playback stay consistent (a `tool_use.id` and the
 * `tool_result.tool_use_id` that answers it get the same new id).
 */
export class IdMap {
  private readonly map = new Map<string, string>();

  /** Makes `recorded` map to `current` (used when a line from another fixture must refer to an id already emitted). */
  alias(recorded: string, current: string): void {
    this.map.set(recorded, current);
  }

  /** The current id for a recorded one, created on first use. */
  id(recorded: string): string {
    let current = this.map.get(recorded);
    if (current === undefined) {
      const api = API_ID_RE.exec(recorded);
      current = api ? `${api[1]}_01${randomBase62(22)}` : randomUUID();
      this.map.set(recorded, current);
    }
    return current;
  }
}

/** What a rewrite replaces (see {@link rewriteJson}). */
export interface RewriteContext {
  /** Literal substring replacements, applied longest `from` first (recorded cwd → real cwd, recorded session ids → current id, …). */
  readonly replacements: ReadonlyArray<readonly [string, string]>;
  /** Ids that are already current and must not be remapped (the session id). */
  readonly keep: ReadonlySet<string>;
  /** Current time as ISO-8601, used for every `timestamp` field. */
  now(): string;
}

function replaceAll(text: string, replacements: RewriteContext['replacements']): string {
  let out = text;
  for (const [from, to] of replacements) {
    if (from !== '' && out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

function rewriteString(value: string, key: string | undefined, ctx: RewriteContext, ids: IdMap): string {
  const replaced = replaceAll(value, ctx.replacements);
  if (ctx.keep.has(replaced)) return replaced;
  if (isRewritableId(replaced)) return ids.id(replaced);
  if (key === 'timestamp' && ISO_RE.test(replaced)) return ctx.now();
  return replaced;
}

/**
 * Deep-rewrites one recorded value: string replacements (paths, session ids),
 * fresh ids for every uuid / API id (object keys included, e.g.
 * `wire_tool_inputs`), and `timestamp` fields set to now.
 */
export function rewriteJson(value: Json, ctx: RewriteContext, ids: IdMap, key?: string): Json {
  if (typeof value === 'string') return rewriteString(value, key, ctx, ids);
  if (Array.isArray(value)) return value.map((item) => rewriteJson(item, ctx, ids));
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      const newKey = isRewritableId(k) ? ids.id(k) : k;
      out[newKey] = rewriteJson(v, ctx, ids, k);
    }
    return out;
  }
  return value;
}

/** {@link rewriteJson} for one stream-json line. */
export function rewriteLine(line: JsonObject, ctx: RewriteContext, ids: IdMap): JsonObject {
  return rewriteJson(line, ctx, ids) as JsonObject;
}

/** Sorts replacement pairs longest `from` first, so `…/handoff-mid` is replaced before `…/handoff`. */
export function sortReplacements(pairs: Iterable<readonly [string, string]>): Array<readonly [string, string]> {
  return [...pairs].sort((a, b) => b[0].length - a[0].length);
}
