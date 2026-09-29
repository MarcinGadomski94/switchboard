import path from 'node:path';
import type { WorkflowGrid } from './workflow.ts';
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
 * Whether the simulated model has auto mode. By default it has, like the CLI's
 * default model (probe 2026-09-28, `docs/spike-m0.md` → *D6 follow-up*);
 * `FAKE_CLAUDE_AUTO_MODE=unsupported` simulates a model without it (Haiku, as M0
 * recorded): `auto` is then silently reported as `default` and
 * `set_permission_mode auto` fails with `auto_mode_model`.
 */
export function autoModeSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['FAKE_CLAUDE_AUTO_MODE'] !== 'unsupported';
}

/**
 * `system/init.permissionMode` for a requested `--permission-mode`, as recorded on
 * CLI 2.1.283 (M0.1): `manual` is reported as `default`; `auto` stays `auto` on a
 * model with auto mode and silently falls back to `default` on one without.
 */
export function reportedPermissionMode(requested: string | null, autoSupported: boolean = autoModeSupported()): string {
  if (requested === null || requested === 'manual') return 'default';
  if (requested === 'auto') return autoSupported ? 'auto' : 'default';
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

/** Longest `[fake:hold <seconds>]` (ten minutes). */
export const MAX_HOLD_SECONDS = 600;

/**
 * `[fake:hold <seconds>]` in a stdin user message (D44): the `default` turn, held
 * `<seconds>` (decimals allowed, at most {@link MAX_HOLD_SECONDS}) after it started
 * (its `init` and replay) and before its reply, like a model that thinks for a
 * while without calling a tool: a message written meanwhile has no tool boundary
 * to be absorbed at, so it waits for the turn's `result` and gets a turn of its own.
 * An interrupt or SIGINT during the hold ends the turn like `hang`.
 * @returns the milliseconds, `{ error }` for a malformed token, `null` without one.
 */
export function holdToken(text: string): number | { error: string } | null {
  const match = /\[fake:hold\s+(\d+(?:\.\d+)?)\]/.exec(text);
  if (match) return Math.round(Math.min(Number(match[1]), MAX_HOLD_SECONDS) * 1000);
  return /\[fake:hold(?:\s|\])/.test(text) ? { error: 'expected [fake:hold <seconds>]' } : null;
}

/**
 * D44: a queued stdin message a running turn may absorb at a tool boundary (the
 * CLI's mid-turn `queued_command`): a plain message. One that carries a `[fake:…]`
 * token asks for a turn of its own (a scenario, a write, a hold, …), so it waits.
 */
export function absorbable(text: string): boolean {
  return !text.includes('[fake:');
}

/**
 * `[fake:say "<json string>"]` in a stdin user message (D20): the `default` turn
 * with the reply text replaced by the JSON string's value (Markdown, raw HTML, …),
 * so chat rendering can be tested on the real path. Newlines are written `\n`
 * inside the JSON string, so the token fits on one line (the composer's field).
 * @returns the reply text, `{ error }` for a token whose argument is not one JSON string, `null` without a token.
 */
export function sayToken(text: string): { text: string } | { error: string } | null {
  const match = /\[fake:say\s+("(?:[^"\\]|\\.)*")\]/.exec(text);
  if (!match) return /\[fake:say(?:\s|\])/.test(text) ? { error: 'expected [fake:say "<json string>"]' } : null;
  try {
    const value: unknown = JSON.parse(match[1] ?? '');
    return typeof value === 'string' ? { text: value } : { error: 'the argument is not a JSON string' };
  } catch (error) {
    return { error: `the argument is not JSON (${error instanceof Error ? error.message : String(error)})` };
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

/** D30: the background command recorded in the `bg-bash` fixture (the D30 probe); `[fake:background]` replaces it. */
export const RECORDED_BACKGROUND_COMMAND = 'sleep 5; echo done';

/** D30: the background task id recorded in the `bg-bash` fixture; each `[fake:background]` gets a fresh one. */
export const RECORDED_BACKGROUND_TASK = 'b6kg3qgya';

/** D30: the command `[fake:background-gh <seconds>]` runs in the background: a GitHub Actions wait like the ones agents write. */
export const GH_WAIT_COMMAND = 'for i in $(seq 1 60); do gh run view 4242 --json status --jq .status | grep -qx completed && break; sleep 20; done';

/** D30: the reason of the `ScheduleWakeup` call `[fake:wakeup <seconds>]` makes. */
export const WAKEUP_REASON = 'fake-claude: check again later';

/** D43: the `meta.name` of the workflow `[fake:workflow <seconds>]` launches (`workflow_name`, `tool_use_result.workflowName`). */
export const FAKE_WORKFLOW_NAME = 'fake-audit';

/** D43: the `meta.description` of that workflow: its launch result's `Summary:` and its `task_started` description. */
export const FAKE_WORKFLOW_SUMMARY = 'fake-claude: read-only audit of the recorded fixtures';

/** D43: the script `[fake:workflow <seconds>]` passes to the `Workflow` tool (never run). */
export const FAKE_WORKFLOW_SCRIPT = `export const meta = { name: '${FAKE_WORKFLOW_NAME}', description: '${FAKE_WORKFLOW_SUMMARY}', phases: [{ title: 'Audit' }] }\nphase('Audit')\nawait agent('Audit the recorded fixtures read-only')`;

/** D43: the task type `[fake:bg-task <seconds>]` reports without one given: a type Switchboard does not know. */
export const FAKE_TASK_TYPE = 'fake_task';

/** D43: the description of the task `[fake:bg-task …]` reports (its `task_started` description and notification summary). */
export const FAKE_TASK_DESCRIPTION = 'fake-claude: a background task of the CLI';

/**
 * D43: the `Workflow` tool's result for a background launch, as CLI 2.1.284 words it
 * (its `mapToolResultToToolResultBlockParam`, read in the binary): the task id, the
 * `Summary:` (the script's `meta.description`), the transcript dir, the script file,
 * the run id, then "You will be notified when it completes."
 */
export function workflowLaunchText(taskId: string, runId: string, scriptPath: string, transcriptDir: string): string {
  return [
    `Workflow launched in background. Task ID: ${taskId}`,
    `Summary: ${FAKE_WORKFLOW_SUMMARY}`,
    `Transcript dir: ${transcriptDir}`,
    `Script file: ${scriptPath}`,
    `(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "${scriptPath}"} to iterate without resending the script.)`,
    `Run ID: ${runId}`,
    `To resume after editing the script: Workflow({scriptPath: "${scriptPath}", resumeFromRunId: "${runId}"}) \u2014 completed agents return cached results (cached results may themselves be empty \u2014 inspect journal.jsonl before assuming there is something to recover).`,
    '',
    'You will be notified when it completes. Use /workflows to watch live progress.',
  ].join('\n');
}

/** Longest background delay a D30 token accepts (seconds). */
const MAX_BACKGROUND_SECONDS = 3_600;

/**
 * What a D30 / D43 token asks for: a background `Bash` that ends after `seconds`, a
 * `ScheduleWakeup` that fires after `seconds`, a background `Workflow` that ends after
 * `seconds` (D43), or a task of `taskType` the CLI reports without a tool call (D43).
 */
export type BackgroundSpec =
  | { readonly kind: 'bash'; readonly seconds: number; readonly command: string }
  | { readonly kind: 'wakeup'; readonly seconds: number }
  /** D51: `grid` (`<P>x<A>`): its agents run and write their files; `null`: D43's launch alone. */
  | { readonly kind: 'workflow'; readonly seconds: number; readonly grid: WorkflowGrid | null }
  | { readonly kind: 'task'; readonly seconds: number; readonly taskType: string };

function seconds(value: string | undefined): number {
  return Math.min(Number(value ?? 0), MAX_BACKGROUND_SECONDS);
}

/**
 * D30 background tokens in a stdin user message (`docs/fake-claude.md` → *Scenarios*):
 * - `[fake:background <seconds> <cmd>]`: the `bg-bash` recording with `<cmd>` (up to
 *   the closing `]`, so it cannot contain one) run in the background: its turn ends,
 *   and `<seconds>` later the task's end and a turn of the CLI's own follow;
 * - `[fake:background-gh <seconds>]`: the same with {@link GH_WAIT_COMMAND};
 * - `[fake:wakeup <seconds>]`: a `ScheduleWakeup` call (`delaySeconds` = `<seconds>`,
 *   not clamped as the real tool is), then `<seconds>` later a turn of its own;
 * - D43 `[fake:workflow <seconds>]`: the same recording as a background `Workflow`
 *   ({@link FAKE_WORKFLOW_SCRIPT}, the launch text {@link workflowLaunchText}, a
 *   `local_workflow` `task_started`); D51 `[fake:workflow <seconds> <P>x<A>]`: its
 *   `P` phases × `A` agents run meanwhile (`workflow.ts`), 1 to 9 each;
 * - D43 `[fake:bg-task <seconds> [<type>]]`: the same recording without its tool call:
 *   only a `task_started` of `<type>` (default {@link FAKE_TASK_TYPE}) without a
 *   `tool_use_id`, then its end.
 * `<seconds>` may have decimals and is capped at an hour.
 * @returns the spec, `{ error }` for a malformed token, `null` without one.
 */
export function backgroundToken(text: string): BackgroundSpec | { error: string } | null {
  const gh = /\[fake:background-gh\s+(\d+(?:\.\d+)?)\]/.exec(text);
  if (gh) return { kind: 'bash', seconds: seconds(gh[1]), command: GH_WAIT_COMMAND };
  const bash = /\[fake:background\s+(\d+(?:\.\d+)?)\s+([^\]]+)\]/.exec(text);
  const command = bash?.[2]?.trim();
  if (bash && command) return { kind: 'bash', seconds: seconds(bash[1]), command };
  const wake = /\[fake:wakeup\s+(\d+(?:\.\d+)?)\]/.exec(text);
  if (wake) return { kind: 'wakeup', seconds: seconds(wake[1]) };
  const workflow = /\[fake:workflow\s+(\d+(?:\.\d+)?)(?:\s+([1-9])x([1-9]))?\]/.exec(text);
  if (workflow) {
    const grid = workflow[2] && workflow[3] ? { phases: Number(workflow[2]), agents: Number(workflow[3]) } : null;
    return { kind: 'workflow', seconds: seconds(workflow[1]), grid };
  }
  const task = /\[fake:bg-task\s+(\d+(?:\.\d+)?)(?:\s+([A-Za-z0-9_-]+))?\s*\]/.exec(text);
  if (task) return { kind: 'task', seconds: seconds(task[1]), taskType: task[2] ?? FAKE_TASK_TYPE };
  if (/\[fake:(?:background|background-gh|wakeup|workflow|bg-task)(?:\s|\])/.test(text)) {
    return {
      error:
        'expected [fake:background <seconds> <cmd>], [fake:background-gh <seconds>], [fake:wakeup <seconds>], [fake:workflow <seconds> [<P>x<A>]] or [fake:bg-task <seconds> [<type>]]',
    };
  }
  return null;
}

/**
 * `[fake:remote-answer <ms>]` in a stdin user message (D24): when this message's
 * turn opens a question or permission request, "the phone" answers it `ms`
 * milliseconds later if Remote Control is on (a `remote_control` `enabled: true`
 * came before): the fake writes `control_cancel_request` for it, as the CLI does
 * when claude.ai answers first (`docs/spike-remote.md` → R.6), and the turn goes on
 * with that answer (each question's first option; any other tool allowed). The
 * milliseconds are required (`[fake:remote-answer]` alone would be a scenario name).
 */
export function remoteAnswerToken(text: string): number | null {
  const match = /\[fake:remote-answer\s+(\d+)\]/.exec(text);
  return match ? Math.min(Number(match[1]), 600_000) : null;
}

/** D49 `[fake:usage <tokens> [<window>]]`: the main agent's context size (and the result's reported window). */
export interface UsageSpec {
  /** `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` of every main-agent assistant line. */
  readonly tokens: number;
  /** The result's `modelUsage[<model>].contextWindow`; `null` keeps the recorded one (200 000). */
  readonly window: number | null;
}

/**
 * D49 `[fake:usage <tokens> [<window>]]` in a stdin user message: the turn's
 * main-agent assistant lines carry a usage whose context tokens (input + cache
 * creation + cache read) are `<tokens>` (their `iterations` dropped), and with
 * `<window>` the result's `modelUsage` reports that `contextWindow` for every model.
 * Orthogonal to the other tokens: it changes neither the scenario nor its turn counter.
 * @returns the spec, `{ error }` for a malformed token, `null` without one.
 */
export function usageToken(text: string): UsageSpec | { error: string } | null {
  const match = /\[fake:usage\s+(\d+)(?:\s+(\d+))?\]/.exec(text);
  if (match) return { tokens: Number(match[1]), window: match[2] === undefined ? null : Number(match[2]) };
  return /\[fake:usage(?:\s|\])/.test(text) ? { error: 'expected [fake:usage <tokens> [<window>]]' } : null;
}

/** D49 `[fake:compact <auto|manual> <pre> [<post>]]`: a compaction at the turn's start. */
export interface CompactSpec {
  readonly trigger: 'auto' | 'manual';
  readonly preTokens: number;
  readonly postTokens: number | null;
}

/**
 * D49 `[fake:compact <auto|manual> <pre> [<post>]]` in a stdin user message: right
 * after the turn's `system/init` the fake writes a `system/compact_boundary` as CLI
 * 2.1.284 streams one (read in its code, never recorded): `{type:"system",
 * subtype:"compact_boundary", session_id, uuid, compact_metadata:{trigger,
 * pre_tokens, post_tokens?}}`, and the transcript gets the CLI's boundary entry
 * (`content:"Conversation compacted"`, `compactMetadata`, `parentUuid: null`,
 * `logicalParentUuid` = the chain tip). Orthogonal like `[fake:usage]`.
 * @returns the spec, `{ error }` for a malformed token, `null` without one.
 */
export function compactToken(text: string): CompactSpec | { error: string } | null {
  const match = /\[fake:compact\s+(auto|manual)\s+(\d+)(?:\s+(\d+))?\]/.exec(text);
  if (match) return { trigger: match[1] as 'auto' | 'manual', preTokens: Number(match[2]), postTokens: match[3] === undefined ? null : Number(match[3]) };
  return /\[fake:compact(?:\s|\])/.test(text) ? { error: 'expected [fake:compact <auto|manual> <pre> [<post>]]' } : null;
}

/**
 * The fake's Remote Control (D24), from `FAKE_CLAUDE_REMOTE_CONTROL`:
 * - unset / anything else: `initialize` reports `remote_control_available: true`
 *   and `remote_control` succeeds (`on`);
 * - `unavailable`: `initialize` reports `remote_control_available: false` and
 *   `remote_control` `enabled: true` answers an error;
 * - `no-url`: `remote_control` `enabled: true` succeeds without a `session_url`.
 */
export type RemoteControlMode = 'on' | 'unavailable' | 'no-url';

/** {@link RemoteControlMode} of `env`. */
export function remoteControlMode(env: NodeJS.ProcessEnv = process.env): RemoteControlMode {
  const value = env['FAKE_CLAUDE_REMOTE_CONTROL'];
  return value === 'unavailable' || value === 'no-url' ? value : 'on';
}

/** `FAKE_CLAUDE_REMOTE_CONTROL_ERROR`: every `remote_control` request answers an error with this text (unset / empty: none). */
export function remoteControlError(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env['FAKE_CLAUDE_REMOTE_CONTROL_ERROR'];
  return value !== undefined && value !== '' ? value : null;
}

/** The longest `FAKE_CLAUDE_STARTUP_MS` the fake takes (one minute). */
export const MAX_STARTUP_MS = 60_000;

/**
 * D44: `FAKE_CLAUDE_STARTUP_MS`, how long the fake takes to start before it takes
 * up stdin user messages (the real CLI first runs its SessionStart hooks and
 * connects its MCP servers: ~1.6 s of hooks and ~3.5 s for a control-only run in
 * M0.3); messages written meanwhile wait, control requests are answered at once.
 * Unset / empty = 0. Returns an error text for anything but a whole number of
 * milliseconds from 0 to {@link MAX_STARTUP_MS}.
 */
export function startupDelayMs(env: NodeJS.ProcessEnv = process.env): number | { readonly error: string } {
  const value = env['FAKE_CLAUDE_STARTUP_MS'];
  if (value === undefined || value.trim() === '') return 0;
  const ms = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(ms) || ms > MAX_STARTUP_MS) {
    return { error: `fake-claude: FAKE_CLAUDE_STARTUP_MS must be a whole number of milliseconds from 0 to ${MAX_STARTUP_MS}, got "${value}"` };
  }
  return ms;
}

/** The error text `remote_control` `enabled: true` answers with `FAKE_CLAUDE_REMOTE_CONTROL=unavailable`. */
export const REMOTE_CONTROL_UNAVAILABLE = 'fake-claude: Remote Control is not available (FAKE_CLAUDE_REMOTE_CONTROL=unavailable)';

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
