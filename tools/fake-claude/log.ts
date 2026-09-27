import { appendFile } from 'node:fs/promises';

/**
 * `FAKE_CLAUDE_LOG=<file>`: appends one JSON line per event so tests can assert
 * what the supervisor sent. `{"kind":"argv",pid,cwd,argv,env,claudeEnvKeys}` at
 * start, then `{"kind":"stdin",pid,line}` for every stdin line, verbatim.
 * Several fake processes may share one file (small appends).
 */
export class Logger {
  private readonly file: string;
  private writes: Promise<void> = Promise.resolve();

  private constructor(file: string) {
    this.file = file;
  }

  /** A logger when `FAKE_CLAUDE_LOG` is set, else `null`. */
  static fromEnv(env: NodeJS.ProcessEnv): Logger | null {
    const file = env['FAKE_CLAUDE_LOG'];
    return file && file.trim() !== '' ? new Logger(file) : null;
  }

  private append(entry: Record<string, unknown>): Promise<void> {
    const text = `${JSON.stringify({ ...entry, pid: process.pid })}\n`;
    this.writes = this.writes.then(() => appendFile(this.file, text));
    return this.writes;
  }

  /**
   * Logs argv and cwd. `env` has the values of `CLAUDE_CONFIG_DIR` and every
   * `FAKE_CLAUDE_*`; `claudeEnvKeys` lists the names (only) of every `CLAUDE*`
   * variable, so a test can check that `CLAUDECODE` / `CLAUDE_CODE_*` were dropped
   * without secrets landing in the log.
   */
  argv(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    const logged: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined && (key === 'CLAUDE_CONFIG_DIR' || key.startsWith('FAKE_CLAUDE_'))) logged[key] = value;
    }
    const claudeEnvKeys = Object.keys(env).filter((key) => key.startsWith('CLAUDE')).sort();
    return this.append({ kind: 'argv', cwd, argv, env: logged, claudeEnvKeys });
  }

  /** Logs one raw stdin line (without its newline). */
  stdin(line: string): Promise<void> {
    return this.append({ kind: 'stdin', line });
  }

  /** Waits for every queued append. */
  flush(): Promise<void> {
    return this.writes;
  }
}
