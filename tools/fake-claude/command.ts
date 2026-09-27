import path from 'node:path';

/** Absolute path of the fake CLI's entry script. */
export const FAKE_CLAUDE_ENTRY = path.join(import.meta.dirname, 'main.ts');

/**
 * The argv prefix that starts the fake on macOS, Linux and Windows:
 * `[<this node>, <abs path>/tools/fake-claude/main.ts]` (Node ≥ 24 runs the
 * TypeScript directly). Spawn it with `shell: false` like the real CLI.
 */
export function fakeClaudeCommand(): string[] {
  return [process.execPath, FAKE_CLAUDE_ENTRY];
}

/** {@link fakeClaudeCommand} as a `SWITCHBOARD_CLAUDE_BIN` value (a JSON array, `docs/configuration.md`). */
export function fakeClaudeBinEnv(): string {
  return JSON.stringify(fakeClaudeCommand());
}
