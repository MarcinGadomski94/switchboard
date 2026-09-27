import path from 'node:path';
import type { Step } from './fixtures.ts';
import { type Json, type JsonObject, asObject, clone, isObject } from './json.ts';

/** Scenarios the fake builds itself (on top of every `manifest.json` scenario). */
export const BUILT_IN_SCENARIOS: readonly string[] = ['default', 'hang', 'crash'];

/** The recorded turn that `default` plays (and that every scenario falls back to once its turns are used up): `multiturn` turn 1, reply "OK". */
export const DEFAULT_FIXTURE = 'multiturn';

/**
 * When the developer's decision differs from the recorded one, the rest of the
 * turn comes from the sibling recording of the same prompt that got that decision.
 */
export const SIBLINGS: Readonly<Record<string, { allow?: string; deny?: string }>> = {
  'perm-allow': { deny: 'perm-deny' },
  'perm-deny': { allow: 'perm-allow' },
  'ask-interrupt': { allow: 'ask-delay' },
};

/**
 * Scenarios whose `system/init.permissionMode` is replayed as recorded instead
 * of derived from `--permission-mode`: `perm-auto` is the silent `auto` → `default`
 * fallback, so a supervisor asking for `acceptEdits` sees the mismatch it must flag.
 */
export const KEEP_RECORDED_PERMISSION_MODE: ReadonlySet<string> = new Set(['perm-auto']);

/**
 * `system/init.permissionMode` for a requested `--permission-mode`, as recorded on
 * CLI 2.1.283 (M0.1): `manual` is reported as `default`, and `auto` silently
 * falls back to `default` (Haiku, the only model M0 could probe, has no auto mode).
 */
export function reportedPermissionMode(requested: string | null): string {
  if (requested === null || requested === 'manual' || requested === 'auto') return 'default';
  return requested;
}

/** `[fake:<scenario>]` in a stdin user message selects a scenario for this and the following messages. */
export function scenarioToken(text: string): string | null {
  return /\[fake:([A-Za-z0-9-]+)\]/.exec(text)?.[1] ?? null;
}

/** `[fake:write <path>]` in a stdin user message: a real Write of `<path>` (relative to the cwd). */
export function writeToken(text: string): string | null {
  const match = /\[fake:write\s+([^\]]+)\]/.exec(text);
  return match?.[1]?.trim() || null;
}

/** Content the `[fake:write <path>]` Write puts in the file. */
export const WRITE_CONTENT = 'written by fake-claude\n';

/**
 * Resolves a `[fake:write]` path inside `cwd`.
 * @returns the absolute path, or `null` when it would leave the cwd (never written).
 */
export function resolveInside(cwd: string, relative: string): string | null {
  const target = path.resolve(cwd, relative);
  const rel = path.relative(cwd, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

/** The text of a user message (`content` string, or its text blocks joined). */
export function messageText(content: Json | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is JsonObject => isObject(b) && b['type'] === 'text' && typeof b['text'] === 'string')
    .map((b) => String(b['text']))
    .join('\n');
}

/**
 * The `tool_result` text the CLI builds from `updatedInput.answers` (M0.2,
 * `ask-2q` / `ask-multiselect`): `Your questions have been answered: "<q>"="<a>", …
 * You can now continue with these answers in mind.`
 */
export function formatAnswers(answers: JsonObject): string {
  const parts = Object.entries(answers).map(([question, answer]) => `"${question}"="${String(answer)}"`);
  return `Your questions have been answered: ${parts.join(', ')}. You can now continue with these answers in mind.`;
}

/**
 * `--max-turns <n>`: a turn that needs more than `n` main-chain model messages is
 * cut before message `n + 1` and ends with `result/error_max_turns` (M0.1
 * `max-turns`: `errors:["Reached maximum number of turns (n)"]`, `num_turns: n + 1`).
 */
export function applyMaxTurns(steps: readonly Step[], maxTurns: number, resultTemplate: JsonObject): readonly Step[] {
  const seen: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step?.t !== 'line' || step.line['type'] !== 'assistant' || step.line['parent_tool_use_id'] !== null) continue;
    const id = asObject(step.line['message'])?.['id'];
    if (typeof id !== 'string' || seen.includes(id)) continue;
    if (seen.length < maxTurns) {
      seen.push(id);
      continue;
    }
    let cut = i;
    for (;;) {
      const before = steps[cut - 1];
      if (before?.t === 'line' && before.line['type'] === 'system' && before.line['subtype'] === 'thinking_tokens') cut--;
      else break;
    }
    const result = clone(resultTemplate);
    result['errors'] = [`Reached maximum number of turns (${maxTurns})`];
    result['num_turns'] = maxTurns + 1;
    return [...steps.slice(0, cut), { t: 'line', line: result }];
  }
  return steps;
}
