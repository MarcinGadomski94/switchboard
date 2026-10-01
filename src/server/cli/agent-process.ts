import type { ProcessExit } from '../supervisor/process.ts';

export type { ProcessExit };

/**
 * D62 (`docs/providers.md` → *Design*): one supervised agent process, whatever
 * the CLI. The supervisor speaks Claude Code's stream-json to it: `write` takes
 * stream-json stdin objects (user messages, control requests and responses) and
 * `onLine` (given at spawn) gets stream-json stdout lines. For Claude Code that
 * is the CLI itself ({@link ClaudeProcess}); for Codex CLI and OpenCode a bridge
 * translates both ways (`cli/codex/bridge.ts`, `cli/opencode/bridge.ts`), so the
 * recorder, the status, the question pipeline and the chat stay one code path.
 */
export interface AgentProcess {
  /** The child's pid (the CLI, or the CLI's server for a bridge), `null` when it could not be started. */
  readonly pid: number | null;
  /** `true` until the process has ended. */
  readonly running: boolean;
  /** `true` once stdin was closed (or the process ended). */
  readonly inputClosed: boolean;
  /** Resolves once the process has ended and every line reached `onLine`. */
  readonly exited: Promise<ProcessExit>;
  /** The last few KB of the CLI's stderr. */
  stderrTail(): string;
  /** Writes one stream-json stdin object; `false` when input is already closed. */
  write(line: object): boolean;
  /** EOF: the running turn finishes, then the process exits. */
  endInput(): void;
  /** Sends `signal`; `false` when the process has already ended. */
  kill(signal: NodeJS.Signals): boolean;
  /** Resolves `true` if the process ends within `ms`, else `false`. */
  waitForExit(ms: number): Promise<boolean>;
}
