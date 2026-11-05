/**
 * Timestamps on the service's plain lines (`docs/service.md` → *The service log*).
 * Most of Switchboard logs through Fastify's pino logger, whose JSON lines carry
 * `time`; many subsystems still print plain text through `console` (`switchboard
 * ci: …`, `switchboard team: …`, `[auto-clean] …`), and those lines had no time,
 * so a line could not be matched to anything else in the log. The service's
 * `main.ts` installs this once: every `console.log` / `info` / `warn` / `error` /
 * `debug` line starts with an ISO timestamp (`2026-11-05T09:12:03.456Z switchboard
 * ci: …`). Pino writes to stdout itself, never through `console`, so its lines
 * are untouched. Tests that build an app in-process never install it.
 */

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** A marker so a second install is a no-op. */
const INSTALLED = Symbol.for('switchboard.console-time');

/** The console methods this wraps. */
type ConsoleLike = Pick<Console, (typeof METHODS)[number]>;

/**
 * Prefixes every line `target` prints with `now()` as ISO 8601 (an extra first
 * argument, so a printed `Error` keeps its stack). Idempotent.
 * @returns the undo (tests).
 */
export function timestampConsole(target: ConsoleLike = console, now: () => Date = () => new Date()): () => void {
  const marked = target as ConsoleLike & { [INSTALLED]?: boolean };
  if (marked[INSTALLED]) return () => undefined;
  const originals = METHODS.map((method) => [method, target[method]] as const);
  for (const [method, original] of originals) {
    target[method] = (...args: unknown[]) => original.call(target, now().toISOString(), ...args);
  }
  marked[INSTALLED] = true;
  return () => {
    for (const [method, original] of originals) target[method] = original;
    delete marked[INSTALLED];
  };
}
