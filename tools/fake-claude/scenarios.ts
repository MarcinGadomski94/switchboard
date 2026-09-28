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

/**
 * `[fake:tool <Name> {json}]` in a stdin user message: the `tx-main` tool turn with
 * `<Name>` called with the JSON object as its input (M7.2 loop cards: CronCreate,
 * ScheduleWakeup, CronDelete, Workflow). The JSON must not contain `}]`.
 * @returns the tool name and input, `{ error }` for a token whose JSON is not an object, `null` without a token.
 */
export function toolToken(text: string): { name: string; input: JsonObject } | { error: string } | null {
  const match = /\[fake:tool\s+([A-Za-z][A-Za-z0-9_]*)\s+(\{[\s\S]*?\})\]/.exec(text);
  // `[fake:tool-use]` is a scenario token, not this one: only `[fake:tool` + space or `]` counts.
  if (!match) return /\[fake:tool(?:\s|\])/.test(text) ? { error: 'expected [fake:tool <Name> {json}]' } : null;
  try {
    const input: unknown = JSON.parse(match[2] ?? '');
    return isObject(input) ? { name: match[1] ?? '', input } : { error: 'the input is not a JSON object' };
  } catch (error) {
    return { error: `the input is not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** The tool_result text of a `[fake:tool]` call (invented: the real tools' results were never recorded). */
export function toolResultText(name: string): string {
  return `fake-claude: ${name} done`;
}

/**
 * `[fake:fire <n> <ms>]` in a stdin user message: after that message's turn, the
 * fake runs `n` turns of its own (no stdin message behind them), one every `ms`
 * milliseconds, like the CLI firing a `/loop` cron job or wake-up (M7.2).
 */
export function fireToken(text: string): { count: number; everyMs: number } | null {
  const match = /\[fake:fire\s+(\d+)\s+(\d+)\]/.exec(text);
  if (!match) return null;
  return { count: Math.min(Number(match[1]), 100), everyMs: Math.max(Number(match[2]), 10) };
}

/** The prompt text a `[fake:fire]` turn writes to the transcript. */
export const FIRE_PROMPT = 'fake-claude: scheduled firing';

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
