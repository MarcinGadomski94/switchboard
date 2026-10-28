/**
 * D145 (`docs/worktrees.md` → *Worktrees an agent made (D145)*; D38 extended): how a session's
 * tool calls name a worktree its agent made. Server-only (it reads Bash commands with
 * `splitStatements`); the UI never needs it.
 */
import { splitStatements } from './derive/artifacts.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a session's tool call says about a worktree its agent made: Claude Code's
 * `EnterWorktree` (`.claude/worktrees/<name>`), an `Agent` / `Task` run with
 * `isolation: "worktree"` (its result names the worktree when the subagent changed
 * something), or a `git worktree add` in a Bash command.
 */
export interface WorktreeEvidence {
  readonly kind: 'enter' | 'agent' | 'bash';
  /** Absolute worktree paths the call names. */
  readonly paths: readonly string[];
  /** `.claude/worktrees/<name>` names (enter / agent), or the folder name of the `git worktree add` path (bash). */
  readonly names: readonly string[];
  /** Branches a `git worktree add -b <branch>` named. */
  readonly branches: readonly string[];
  /** `false` while the call's result has not arrived and nothing names the worktree yet (read it again later). */
  readonly complete: boolean;
}

const CLAUDE_WORKTREE_NAME = /\.claude[\\/]worktrees[\\/]([A-Za-z0-9._-]+)/g;
const CLAUDE_WORKTREE_PATH = /((?:[A-Za-z]:)?[\\/][^\s"'`<>|*?]*?[\\/]\.claude[\\/]worktrees[\\/][A-Za-z0-9._-]+)/g;

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((value) => value !== '');
}

function claudeWorktreesIn(text: string): { readonly paths: string[]; readonly names: string[] } {
  // JSON escapes a Windows path's backslashes: read them as single ones.
  const plain = text.replace(/\\\\/g, '\\');
  return {
    paths: unique([...plain.matchAll(CLAUDE_WORKTREE_PATH)].map((match) => (match[1] as string).replace(/[\\/]+$/, ''))),
    names: unique([...plain.matchAll(CLAUDE_WORKTREE_NAME)].map((match) => match[1] as string)),
  };
}

/** The `git worktree add` calls of a command: each one's path (as written) and `-b` / `-B` branch. */
export function worktreeAdds(command: string): Array<{ readonly path: string | null; readonly branch: string | null }> {
  const out: Array<{ path: string | null; branch: string | null }> = [];
  for (const words of splitStatements(command)) {
    const at = words.findIndex((word, i) => word === 'worktree' && words[i + 1] === 'add');
    if (at < 0 || !words.slice(0, at).includes('git')) continue;
    let branch: string | null = null;
    let target: string | null = null;
    for (let i = at + 2; i < words.length; i++) {
      const word = words[i] as string;
      if (word === '-b' || word === '-B') {
        branch = words[i + 1] ?? null;
        i++;
      } else if (word === '--reason') {
        i++;
      } else if (word.startsWith('-')) {
        continue;
      } else if (target === null) {
        target = word;
      }
    }
    out.push({ path: target, branch });
  }
  return out;
}

/** A tool event's payload as evidence of a worktree its agent made, else `null`. */
export function worktreeEvidence(payload: unknown): WorktreeEvidence | null {
  if (!isRecord(payload) || payload['type'] !== 'tool' || payload['isError'] === true) return null;
  const name = payload['name'];
  const input = isRecord(payload['input']) ? payload['input'] : {};
  const hasResult = typeof payload['result'] === 'string';
  const result = hasResult ? (payload['result'] as string) : '';
  if (name === 'EnterWorktree') {
    const found = claudeWorktreesIn(`${textOf(input)}\n${result}`);
    const given = typeof input['name'] === 'string' && /^[A-Za-z0-9._-]+$/.test(input['name']) ? [input['name']] : [];
    const names = unique([...given, ...found.names]);
    return { kind: 'enter', paths: found.paths, names, branches: [], complete: hasResult || names.length > 0 };
  }
  if ((name === 'Agent' || name === 'Task') && input['isolation'] === 'worktree') {
    const found = claudeWorktreesIn(result);
    return { kind: 'agent', paths: found.paths, names: found.names, branches: [], complete: hasResult };
  }
  if (name === 'Bash' && typeof input['command'] === 'string') {
    if (!hasResult) return null;
    const adds = worktreeAdds(input['command']);
    if (adds.length === 0) return null;
    const paths = adds.flatMap((add) => (add.path !== null && /^(?:[A-Za-z]:)?[\\/]/.test(add.path) ? [add.path.replace(/[\\/]+$/, '')] : []));
    const names = adds.flatMap((add) => (add.path !== null ? [add.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''] : []));
    return { kind: 'bash', paths: unique(paths), names: unique(names), branches: unique(adds.flatMap((add) => (add.branch ? [add.branch] : []))), complete: true };
  }
  return null;
}

function normalized(file: string): string {
  return file.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Whether a listed worktree (`paths`: as git lists it and its real path; its branch) is the one
 * `evidence` names, in the repository `repoPath` (its main checkout).
 */
export function evidenceNames(evidence: WorktreeEvidence, worktree: { readonly paths: readonly string[]; readonly branch: string | null }, repoPaths: readonly string[]): boolean {
  const mine = worktree.paths.map(normalized);
  if (evidence.paths.some((file) => mine.includes(normalized(file)))) return true;
  if (evidence.kind === 'bash') {
    if (worktree.branch !== null && evidence.branches.includes(worktree.branch)) return true;
    return worktree.paths.some((file) => evidence.names.includes(file.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''));
  }
  // `.claude/worktrees/<name>` of this repository.
  return evidence.names.some((name) => repoPaths.some((repo) => mine.includes(normalized(`${repo}/.claude/worktrees/${name}`))));
}
