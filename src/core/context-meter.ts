/**
 * D49 · context window meter (`docs/chat.md` → *Context bar*, `docs/decisions.md`
 * → D49). Pure part: how full the main agent's context window is, and when the
 * CLI last compacted it.
 *
 * What the CLI itself does (CLI 2.1.284 binary, read with `strings`):
 * - **Tokens in use** = the latest main-conversation assistant message's usage,
 *   `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
 *   (the status line's `context_window.used_percentage`: `bmn(usage, window)` =
 *   `round(tokens / window * 100)`, clamped 0–100). `output_tokens` are **not**
 *   counted there. When the usage has `iterations`, the last one that is not a
 *   `compaction` / `advisor_message` iteration is used (`kTe`). A usage whose three
 *   input fields sum to 0 is no reading (the CLI shows no percentage then).
 * - **Window** = the result's `modelUsage[<model>].contextWindow` (the CLI fills it
 *   with its own resolution, `qg(model)`); otherwise a model whose name has `[1m]`
 *   (case-insensitive) has 1 000 000 tokens, every other one 200 000 (`J$e`, `a3`).
 * - **Compaction** = `system/compact_boundary` with `compact_metadata` `{trigger:
 *   "auto"|"manual", pre_tokens, post_tokens?}`. After it the CLI has no usage
 *   (the old messages are gone) until the next reply; Switchboard shows
 *   `post_tokens` meanwhile when the boundary carries it.
 *
 * Only the main agent counts: subagent (sidechain) messages, which carry a
 * `parent_tool_use_id` on stdout or `isSidechain: true` in the transcript, and
 * `<synthetic>` filler lines never change the reading.
 *
 * The state ({@link ContextState}) is stored as JSON on the session
 * (`sessions.context`, migration 0015) and resolved per read against the
 * session's model choice ({@link resolveContext}), so the window follows D31 /
 * D42 model changes.
 */

/** The window of a model without a reported one and without `[1m]` (the CLI's `J$e`). */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** The window of a `[1m]` model (the CLI's `Kh`: `/\[1m\]/i` → 1e6). */
export const ONE_M_CONTEXT_WINDOW = 1_000_000;
/** From this percentage on the bar is yellow. */
export const CONTEXT_WARN_PERCENT = 60;
/** From this percentage on the bar is red. */
export const CONTEXT_HIGH_PERCENT = 80;
/** The model name of the CLI's own filler lines (`No response requested.`). */
const SYNTHETIC_MODEL = '<synthetic>';

/** What {@link reduceContext} keeps (stored as JSON; every field is plain data). */
export interface ContextState {
  /** Tokens in the main agent's context (the formula above); `null` = no reading yet (or compacted without an estimate). */
  readonly tokens: number | null;
  /** The model of the latest reading (the API's model id, e.g. `claude-opus-4-7`). */
  readonly model: string | null;
  /** The main-loop model the process reported in its latest `system/init` (may carry `[1m]`). */
  readonly initModel: string | null;
  /** `modelUsage` keys → `contextWindow`, from the results seen (the newest value per key). */
  readonly windows: Readonly<Record<string, number>>;
  /** When the reading last changed (ISO). */
  readonly updatedAt: string | null;
  /** The last compaction, `null` before the first one. */
  readonly compaction: ContextCompaction | null;
  /** `true` from a compaction until the next turn starts (the bar shows "compacted HH:MM" next to its text meanwhile). */
  readonly compactedRecently: boolean;
  /** Internal: a turn ended since the compaction (the next turn's start clears {@link compactedRecently}). */
  readonly compactTurnEnded: boolean;
}

/** One compaction (`system/compact_boundary`). */
export interface ContextCompaction {
  /** When it was seen (ISO). */
  readonly at: string;
  /** `auto` or `manual`; `null` when the CLI did not say. */
  readonly trigger: string | null;
  readonly preTokens: number | null;
  readonly postTokens: number | null;
}

/** The empty state: nothing seen yet. */
export const EMPTY_CONTEXT: ContextState = {
  tokens: null,
  model: null,
  initModel: null,
  windows: {},
  updatedAt: null,
  compaction: null,
  compactedRecently: false,
  compactTurnEnded: false,
};

/** One thing that changes the meter (from stdout or from a transcript). */
export type ContextInput =
  /** A turn starts (`system/init`, or a typed prompt in a transcript). */
  | { readonly kind: 'turn-start'; readonly model?: string | null }
  /** A main-agent assistant message with its `message.usage`. */
  | { readonly kind: 'usage'; readonly model: string | null; readonly usage: unknown; readonly at: string }
  /** A turn's `result`, with its `modelUsage`. */
  | { readonly kind: 'result'; readonly modelUsage: unknown }
  /** `system/compact_boundary`. */
  | { readonly kind: 'compact'; readonly trigger: string | null; readonly preTokens: number | null; readonly postTokens: number | null; readonly at: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The context tokens of one message's `usage` (the CLI's `hs(kTe(usage))`), or
 * `null` when it is no reading (not an object, or every input field 0).
 */
export function usageContextTokens(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  const input = count(usage['input_tokens']) ?? 0;
  const creation = count(usage['cache_creation_input_tokens']) ?? 0;
  const read = count(usage['cache_read_input_tokens']) ?? 0;
  const total = input + creation + read;
  if (total === 0) return null;
  const iterations = usage['iterations'];
  if (Array.isArray(iterations)) {
    const last = [...iterations].reverse().find((it) => !(isRecord(it) && (it['type'] === 'compaction' || it['type'] === 'advisor_message')));
    if (isRecord(last) && (last['type'] === 'message' || last['type'] === 'fallback_message')) {
      const a = count(last['input_tokens']);
      const b = count(last['cache_creation_input_tokens']);
      const c = count(last['cache_read_input_tokens']);
      if (a !== null && b !== null && c !== null && count(last['output_tokens']) !== null && a + b + c > 0) return a + b + c;
    }
  }
  return total;
}

/** The `modelUsage` windows of a result (`{<model>: {contextWindow}}`), positive whole numbers only. */
export function reportedWindows(modelUsage: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(modelUsage)) return out;
  for (const [model, entry] of Object.entries(modelUsage)) {
    const window = isRecord(entry) ? count(entry['contextWindow']) : null;
    if (window !== null && window > 0) out[model] = window;
  }
  return out;
}

/** Applies one input; returns the same object when nothing changed. */
export function reduceContext(state: ContextState, input: ContextInput): ContextState {
  switch (input.kind) {
    case 'turn-start': {
      const initModel = input.model === undefined ? state.initModel : input.model;
      const clear = state.compactedRecently && state.compactTurnEnded;
      if (!clear && initModel === state.initModel) return state;
      return { ...state, initModel, ...(clear ? { compactedRecently: false, compactTurnEnded: false } : {}) };
    }
    case 'usage': {
      if (input.model === SYNTHETIC_MODEL) return state;
      const tokens = usageContextTokens(input.usage);
      if (tokens === null) return state;
      if (tokens === state.tokens && input.model === state.model) return state;
      return { ...state, tokens, model: input.model ?? state.model, updatedAt: input.at };
    }
    case 'result': {
      let next = state;
      // The compaction's turn is over: the next turn's start clears "compacted HH:MM".
      if (next.compactedRecently && !next.compactTurnEnded) next = { ...next, compactTurnEnded: true };
      const reported = reportedWindows(input.modelUsage);
      if (Object.keys(reported).some((key) => next.windows[key] !== reported[key])) next = { ...next, windows: { ...next.windows, ...reported } };
      return next;
    }
    case 'compact':
      return {
        ...state,
        tokens: input.postTokens,
        updatedAt: input.at,
        compaction: { at: input.at, trigger: input.trigger, preTokens: input.preTokens, postTokens: input.postTokens },
        compactedRecently: true,
        compactTurnEnded: false,
      };
  }
}

/** `true` when a model name asks for the 1M window (`[1m]`, any case: the CLI's `pft`). */
export function hasOneM(model: string | null | undefined): boolean {
  return typeof model === 'string' && /\[1m\]/i.test(model);
}

function stripOneM(model: string): string {
  return model.replace(/\[1m\]/gi, '');
}

/** Where {@link ResolvedContext.window} came from. */
export type ContextWindowSource = 'reported' | 'model';

/**
 * The window for `state.model` given the session's model choice (`sessions.model`,
 * D31; `null` = the CLI's default, then the process's own `init` model counts):
 * 1. a reported `modelUsage` window whose key is that model (exactly, or with
 *    `[1m]` dropped), preferring the key whose `[1m]` matches the choice, else a
 *    plain key; a `[1m]` key never answers a plain choice, and a report under 1M
 *    never answers a `[1m]` choice (the choice changed since that report);
 * 2. else 1 000 000 when the choice (or the init model) has `[1m]`, else 200 000.
 */
export function contextWindow(state: ContextState, choice: string | null): { window: number; source: ContextWindowSource } {
  const wanted = choice !== null && choice !== 'default' ? choice : state.initModel;
  const wantOneM = hasOneM(wanted);
  const model = state.model;
  if (model !== null) {
    const base = stripOneM(model);
    const matches = Object.keys(state.windows).filter((key) => key === model || stripOneM(key) === base);
    // A key with the choice's `[1m]`, else a plain key (the CLI may key the 1M model without the suffix); a `[1m]` key never answers a plain choice.
    const pick = matches.find((key) => hasOneM(key) === wantOneM) ?? matches.find((key) => !hasOneM(key));
    const reported = pick !== undefined ? state.windows[pick] : undefined;
    // A reported window that contradicts a `[1m]` choice (a key without `[1m]` at 200k) is stale: the choice changed.
    if (reported !== undefined && !(wantOneM && reported < ONE_M_CONTEXT_WINDOW)) return { window: reported, source: 'reported' };
  }
  return { window: wantOneM ? ONE_M_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW, source: 'model' };
}

/** The meter's color band: `ok` (green) below 60 %, `warn` (yellow) from 60 %, `high` (red) from 80 %; `unknown` without a reading. */
export type ContextBand = 'ok' | 'warn' | 'high' | 'unknown';

/** Percentage shown for `tokens` of `window` (the CLI's rounding, clamped 0–100). */
export function contextPercent(tokens: number, window: number): number {
  if (!(window > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((tokens / window) * 100)));
}

/** The band of a shown percentage (so `60%` is yellow and `80%` red, as the text reads). */
export function contextBand(percent: number | null): ContextBand {
  if (percent === null) return 'unknown';
  if (percent >= CONTEXT_HIGH_PERCENT) return 'high';
  if (percent >= CONTEXT_WARN_PERCENT) return 'warn';
  return 'ok';
}

/** What the session's wire shape carries (`Session.context`, additive D49). */
export interface ResolvedContext {
  /** Tokens in the main agent's context; `null` = unknown ("Context —"). */
  readonly tokens: number | null;
  /** The context window in tokens. */
  readonly window: number;
  /** `reported` = the CLI's `modelUsage[…].contextWindow`; `model` = derived from the model name. */
  readonly windowSource: ContextWindowSource;
  /** The model of the reading (`null` before one). */
  readonly model: string | null;
  /** `round(tokens / window × 100)` clamped 0–100; `null` without a reading. */
  readonly percent: number | null;
  readonly band: ContextBand;
  /** When the reading last changed (ISO), `null` before one. */
  readonly updatedAt: string | null;
  /** The last compaction, `null` before one. */
  readonly compaction: ContextCompaction | null;
  /** From a compaction until the next turn starts. */
  readonly compactedRecently: boolean;
}

/** The stored state resolved against the session's model choice (the window follows it). */
export function resolveContext(state: ContextState, choice: string | null): ResolvedContext {
  const { window, source } = contextWindow(state, choice);
  const percent = state.tokens === null ? null : contextPercent(state.tokens, window);
  return {
    tokens: state.tokens,
    window,
    windowSource: source,
    model: state.model,
    percent,
    band: contextBand(percent),
    updatedAt: state.updatedAt,
    compaction: state.compaction,
    compactedRecently: state.compactedRecently,
  };
}

function storedWindows(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [model, window] of Object.entries(value)) {
    const n = count(window);
    if (n !== null && n > 0) out[model] = n;
  }
  return out;
}

/** A stored state read back leniently (unknown or malformed JSON → the empty state's fields). */
export function readContextState(value: unknown): ContextState {
  if (!isRecord(value)) return EMPTY_CONTEXT;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const compaction = isRecord(value['compaction']) && typeof value['compaction']['at'] === 'string'
    ? {
        at: value['compaction']['at'],
        trigger: str(value['compaction']['trigger']),
        preTokens: count(value['compaction']['preTokens']),
        postTokens: count(value['compaction']['postTokens']),
      }
    : null;
  return {
    tokens: count(value['tokens']),
    model: str(value['model']),
    initModel: str(value['initModel']),
    windows: storedWindows(value['windows']),
    updatedAt: str(value['updatedAt']),
    compaction,
    compactedRecently: value['compactedRecently'] === true && compaction !== null,
    compactTurnEnded: value['compactTurnEnded'] === true,
  };
}

/**
 * The meter from a transcript's main chain (oldest first; `newestChain` of
 * `transcript-sync.ts`, which already leaves sidechain lines out), on top of
 * `from` (whose reported windows and init model it keeps). Assistant entries give
 * the usage, `system/compact_boundary` entries (`compactMetadata`: `trigger`,
 * `preTokens`, `postTokens`) the compactions, and a typed prompt starts a turn
 * (a user entry that is neither meta, a compact summary nor a tool result).
 * Used when Switchboard imports a terminal's turns (Attach here, a move, a
 * teleported copy), so the bar also knows what happened outside it.
 */
export function contextFromTranscript(from: ContextState, chain: readonly Readonly<Record<string, unknown>>[]): ContextState {
  let state: ContextState = { ...from, tokens: null, model: null, updatedAt: null, compaction: null, compactedRecently: false, compactTurnEnded: false };
  let seen = false;
  for (const entry of chain) {
    if (entry['isSidechain'] === true) continue;
    const at = typeof entry['timestamp'] === 'string' && !Number.isNaN(Date.parse(entry['timestamp'])) ? new Date(entry['timestamp']).toISOString() : (from.updatedAt ?? new Date(0).toISOString());
    const type = entry['type'];
    if (type === 'assistant' && isRecord(entry['message'])) {
      const message = entry['message'];
      const next = reduceContext(state, { kind: 'usage', model: typeof message['model'] === 'string' ? message['model'] : null, usage: message['usage'], at });
      if (next !== state) seen = true;
      state = next;
    } else if (type === 'system' && entry['subtype'] === 'compact_boundary') {
      const metadata = isRecord(entry['compactMetadata']) ? entry['compactMetadata'] : {};
      state = reduceContext(state, {
        kind: 'compact',
        trigger: typeof metadata['trigger'] === 'string' ? metadata['trigger'] : null,
        preTokens: count(metadata['preTokens']),
        postTokens: count(metadata['postTokens']),
        at,
      });
      seen = true;
    } else if (type === 'user' && entry['isMeta'] !== true && entry['isCompactSummary'] !== true && isRecord(entry['message'])) {
      const content = entry['message']['content'];
      const toolResult = Array.isArray(content) && content.some((block) => isRecord(block) && block['type'] === 'tool_result');
      // A typed prompt after a compaction starts the next turn (the transcript has no `init` / `result`).
      if (!toolResult) state = reduceContext(state.compactedRecently ? { ...state, compactTurnEnded: true } : state, { kind: 'turn-start' });
    }
  }
  if (!seen) return from;
  // The imported turns are over (the terminal's process is gone): the next turn's start clears "compacted".
  return state.compactedRecently ? { ...state, compactTurnEnded: true } : state;
}
