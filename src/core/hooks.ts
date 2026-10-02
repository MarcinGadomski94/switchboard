/**
 * D48 P4 "hook into hand-started terminal sessions" (`docs/peers.md` → *Hooked
 * terminal sessions*, the design of `docs/spike-remote-pc.md`): the pure part.
 * Switchboard's hook entries in a user `settings.json` (added and removed
 * without touching anything else), the CLI-version check of the internal
 * `rewakeMessage` / `rewakeSummary` fields, the text of a message Switchboard
 * woke a session with (as the transcript shows it), the delivery rate limit, and
 * the rows of `claude agents --json`. No I/O.
 */

/** Marks every hook entry Switchboard writes (an argument of its command), so it can find exactly its own. */
export const HOOK_MARKER = '--switchboard-hook';

/** What a hook entry does (the hook script's first argument after the marker). */
export type HookKind = 'event' | 'permission' | 'waiter';

/** The CLI hook events Switchboard installs, with what each runs. */
export const HOOK_PLAN: ReadonlyArray<{ readonly event: string; readonly kind: HookKind }> = [
  { event: 'SessionStart', kind: 'event' },
  { event: 'SessionStart', kind: 'waiter' },
  { event: 'UserPromptSubmit', kind: 'event' },
  { event: 'PostToolUse', kind: 'event' },
  { event: 'Stop', kind: 'event' },
  { event: 'Stop', kind: 'waiter' },
  { event: 'SessionEnd', kind: 'event' },
  { event: 'PermissionRequest', kind: 'permission' },
];

/** A PermissionRequest hook waits for the developer this long at most (the CLI's own dialog stays open meanwhile). */
export const PERMISSION_HOOK_TIMEOUT_S = 3600;

/** Event hooks run in the background (`async`): they never delay the terminal. Their own limit. */
export const EVENT_HOOK_TIMEOUT_S = 30;

/**
 * The waiter (the `asyncRewake` hook) lives this long at most: 7 days, an explicit `timeout` on its entry. VERIFIED on
 * the 2.1.285 binary: an async / asyncRewake hook without `timeout` is killed after 10 minutes (the CLI's default,
 * `600000` ms); the schema takes any positive number, with no maximum. The practical ceiling is the CLI's `setTimeout`
 * (2^31-1 ms, about 24.8 days: a larger value would fire at once), so 7 days stays far below it. A killed waiter is
 * re-armed by the CLI only at the next SessionStart / Stop, so the waiter must outlive idle stretches (ruling D48: unlimited).
 */
export const WAITER_HOOK_TIMEOUT_S = 7 * 24 * 3600;

/** The prefix the CLI puts before a wake-up message (internal `rewakeMessage`); also the fallback's own first words. */
export const REWAKE_MESSAGE = 'The developer sent this message from Switchboard:';

/** The terminal's one-line label of a wake-up (internal `rewakeSummary`). */
export const REWAKE_SUMMARY = 'Message from Switchboard';

/** Where the hook script runs and what it reaches. */
export interface HookCommand {
  /** Absolute path of the node that runs the script (`process.execPath`). */
  readonly nodePath: string;
  /** Absolute path of `src/hook/sb-hook.ts`. */
  readonly scriptPath: string;
  /** The Switchboard UI port on 127.0.0.1 the hook calls. */
  readonly port: number;
  /** The hook token file (readable only by the user). */
  readonly tokenFile: string;
  /** `win32`: exec form (`command` + `args`, no shell); otherwise one quoted command string. */
  readonly platform: NodeJS.Platform;
  /** Use the internal `rewakeMessage` / `rewakeSummary` fields (the CLI version was tested with them). */
  readonly rewake: boolean;
}

/** One command hook as `settings.json` holds it. */
export type HookEntry = Readonly<Record<string, unknown>>;

/** POSIX single-quoting. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command hook of one kind (exec form on Windows, a quoted command string elsewhere). */
export function hookEntry(command: HookCommand, kind: HookKind): HookEntry {
  const args = [command.scriptPath, HOOK_MARKER, kind, String(command.port), command.tokenFile];
  const run: Record<string, unknown> =
    command.platform === 'win32'
      ? { type: 'command', command: command.nodePath, args }
      : { type: 'command', command: [command.nodePath, ...args].map((part) => (part === HOOK_MARKER || /^[\w.-]+$/.test(part) ? part : shellQuote(part))).join(' ') };
  if (kind === 'waiter') {
    run['asyncRewake'] = true;
    run['timeout'] = WAITER_HOOK_TIMEOUT_S;
    if (command.rewake) {
      run['rewakeMessage'] = REWAKE_MESSAGE;
      run['rewakeSummary'] = REWAKE_SUMMARY;
    }
  } else if (kind === 'permission') {
    run['timeout'] = PERMISSION_HOOK_TIMEOUT_S;
  } else {
    run['async'] = true;
    run['timeout'] = EVENT_HOOK_TIMEOUT_S;
  }
  return run;
}

/** `true` for a command hook Switchboard wrote (its command or args carry {@link HOOK_MARKER}). */
export function isSwitchboardHook(hook: unknown): boolean {
  if (typeof hook !== 'object' || hook === null) return false;
  const record = hook as Record<string, unknown>;
  if (Array.isArray(record['args']) && record['args'].includes(HOOK_MARKER)) return true;
  return typeof record['command'] === 'string' && record['command'].split(/\s+/).includes(HOOK_MARKER);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `settings` without Switchboard's hook entries: its hooks removed from every
 * matcher group; a group left without hooks, an event left without groups and a
 * `hooks` object left empty are removed; everything else (other keys, other
 * hooks, their order) stays as it was. `removed` counts the hooks taken out.
 */
export function withoutSwitchboardHooks(settings: Readonly<Record<string, unknown>>): { readonly settings: Record<string, unknown>; readonly removed: number } {
  const out: Record<string, unknown> = { ...settings };
  let removed = 0;
  if (!isRecord(settings['hooks'])) return { settings: out, removed };
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(settings['hooks'])) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group['hooks'])) {
        kept.push(group);
        continue;
      }
      const inner = group['hooks'].filter((hook) => !isSwitchboardHook(hook));
      removed += group['hooks'].length - inner.length;
      if (inner.length === group['hooks'].length) kept.push(group);
      else if (inner.length > 0) kept.push({ ...group, hooks: inner });
    }
    if (kept.length > 0 || groups.length === 0) hooks[event] = kept;
  }
  if (Object.keys(hooks).length > 0) out['hooks'] = hooks;
  else delete out['hooks'];
  return { settings: out, removed };
}

/**
 * `settings` with exactly Switchboard's hook entries ({@link HOOK_PLAN}): any it
 * had are replaced (idempotent), each added as its own matcher group at the end
 * of its event; nothing else changes.
 */
export function withSwitchboardHooks(settings: Readonly<Record<string, unknown>>, command: HookCommand): Record<string, unknown> {
  const base = withoutSwitchboardHooks(settings).settings;
  const hooks: Record<string, unknown> = isRecord(base['hooks']) ? { ...base['hooks'] } : {};
  for (const { event, kind } of HOOK_PLAN) {
    const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    groups.push({ hooks: [hookEntry(command, kind)] });
    hooks[event] = groups;
  }
  return { ...base, hooks };
}

/** How many of Switchboard's hooks `settings` holds, and whether they are exactly the current plan for `command`. */
export function switchboardHooksState(settings: Readonly<Record<string, unknown>>, command: HookCommand): 'installed' | 'outdated' | 'none' {
  const found = withoutSwitchboardHooks(settings).removed;
  if (found === 0) return 'none';
  const expected = JSON.stringify(withSwitchboardHooks(settings, command)['hooks']);
  return expected === JSON.stringify(settings['hooks']) ? 'installed' : 'outdated';
}

// ── CLI version ──────────────────────────────────────────────────────────

/** The CLI versions the internal `rewakeMessage` / `rewakeSummary` fields were tested with (spike + D48 probes: 2.1.284). */
export const REWAKE_TESTED = { from: [2, 1, 284], below: [2, 2, 0] } as const;

/** `[major, minor, patch]` of `claude --version` output (`2.1.284 (Claude Code)`), `null` when unreadable. */
export function parseCliVersion(text: string | null | undefined): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/** `true` when the CLI version is in the tested range for the internal rewake fields (else the documented fallback). */
export function rewakeSupported(version: string | null | undefined): boolean {
  const parsed = parseCliVersion(version);
  return parsed !== null && compare(parsed, REWAKE_TESTED.from) >= 0 && compare(parsed, REWAKE_TESTED.below) < 0;
}

/**
 * What the waiter writes to stderr for `text`: with the internal fields the CLI
 * puts {@link REWAKE_MESSAGE} before it itself; without them (the fallback, where
 * the model reads `Stop hook blocking error from command …: <stderr>`), the text
 * carries the same words, so the model and the transcript read the same.
 */
export function waiterText(text: string, rewake: boolean): string {
  return rewake ? text : `${REWAKE_MESSAGE} ${text}`;
}

/** Longest message Switchboard sends to a hooked session (it goes in as model-visible text). */
export const HOOK_MESSAGE_MAX = 8_000;

/**
 * The developer's message in a wake-up as the transcript shows it (a `user` line
 * or a `queued_command` attachment: `<task-notification>…</task-notification>
 * <system-reminder>\n<REWAKE_MESSAGE> <text>\n</system-reminder>`, verified on
 * CLI 2.1.284), or in the fallback's wording; `null` for anything else.
 */
export function switchboardMessageText(prompt: string): string | null {
  const at = prompt.indexOf(REWAKE_MESSAGE);
  if (at < 0) return null;
  let rest = prompt.slice(at + REWAKE_MESSAGE.length);
  const end = rest.indexOf('</system-reminder>');
  if (end >= 0) rest = rest.slice(0, end);
  // The fallback's wording repeats the prefix inside the stderr text.
  if (rest.trimStart().startsWith(REWAKE_MESSAGE)) rest = rest.trimStart().slice(REWAKE_MESSAGE.length);
  const text = rest.trim();
  return text === '' ? null : text;
}

// ── delivery rate limit ──────────────────────────────────────────────────

/** At most this many wake-ups of one session … */
export const DELIVERY_MAX = 3;
/** … within this window (the circuit breaker of the spike's runaway: one message re-delivered after every turn). */
export const DELIVERY_WINDOW_MS = 60_000;

/** A sliding-window limit on wake-ups of one session. */
export class DeliveryLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  #times: number[] = [];

  constructor(max: number = DELIVERY_MAX, windowMs: number = DELIVERY_WINDOW_MS) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  #prune(now: number): void {
    this.#times = this.#times.filter((at) => now - at < this.#windowMs);
  }

  /** `true` when a wake-up may go out at `now`. */
  allows(now: number): boolean {
    this.#prune(now);
    return this.#times.length < this.#max;
  }

  /** Counts a wake-up at `now`. */
  record(now: number): void {
    this.#prune(now);
    this.#times.push(now);
  }

  /** When the next wake-up may go out (`now` when one may already). */
  nextAt(now: number): number {
    this.#prune(now);
    return this.#times.length < this.#max ? now : (this.#times[0] as number) + this.#windowMs;
  }
}

// ── claude agents --json ─────────────────────────────────────────────────

/** One row of `claude agents --json` (spike: `pid, cwd, kind, startedAt, sessionId, name, status, waitingFor?`). */
export interface TerminalAgentRow {
  readonly pid: number;
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly kind: string | null;
  readonly name: string | null;
  readonly status: string | null;
  readonly waitingFor: string | null;
  /** Epoch ms. */
  readonly startedAt: number | null;
}

/** Parses `claude agents --json`; rows without a numeric pid and a string session id are skipped; not an array → `null`. */
export function parseTerminalAgents(text: string): TerminalAgentRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: TerminalAgentRow[] = [];
  for (const item of parsed) {
    if (!isRecord(item) || typeof item['pid'] !== 'number' || typeof item['sessionId'] !== 'string') continue;
    const text = (key: string): string | null => (typeof item[key] === 'string' ? (item[key] as string) : null);
    rows.push({
      pid: item['pid'],
      sessionId: item['sessionId'],
      cwd: text('cwd'),
      kind: text('kind'),
      name: text('name'),
      status: text('status'),
      waitingFor: text('waitingFor'),
      startedAt: typeof item['startedAt'] === 'number' ? item['startedAt'] : null,
    });
  }
  return rows;
}
