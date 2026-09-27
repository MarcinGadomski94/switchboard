/**
 * Timeline kinds (decisions gap #7; `docs/derivations.md` → *Event kinds*):
 * Read / Grep / Glob / search → `plan`; Edit / Write / Bash → `impl`; `/loop`,
 * ScheduleWakeup, rebuild / self-heal → `loop`; question / permission → `ask`;
 * a successful result → `ok`. Everything else a tool does is `tool`; text is
 * `text`; failures are `error`.
 */
import type { EventKind } from '../model.ts';

/** Tools that only look at code (`plan`). Any tool whose name contains "search" counts too. */
export const PLAN_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'];

/** Tools that change files or run commands (`impl`). */
export const IMPL_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];

/** Tools that drive a loop (`loop`): `/loop`'s wake-ups and cron jobs. */
export const LOOP_TOOLS: readonly string[] = ['ScheduleWakeup', 'CronCreate'];

/** Tools that ask the developer (`ask`). */
export const ASK_TOOLS: readonly string[] = ['AskUserQuestion'];

/** Tools that write a file (`file_path` / `notebook_path` input). */
export const WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** Tools that start a subagent (`init.tools` lists `Task`, the model calls `Agent`; gap #8). */
export const AGENT_TOOLS: readonly string[] = ['Agent', 'Task'];

/** Context for {@link toolEventKind}: what the same turn already ran. */
export interface ToolKindContext {
  /**
   * `true` when this is a Bash command identical to an earlier Bash command of the
   * same turn whose result was an error: a rebuild after a failure (self-heal).
   */
  readonly rerunAfterError?: boolean;
}

/** The timeline kind of a tool call. */
export function toolEventKind(name: string, context: ToolKindContext = {}): EventKind {
  if (ASK_TOOLS.includes(name)) return 'ask';
  if (LOOP_TOOLS.includes(name)) return 'loop';
  if (name === 'Bash' && context.rerunAfterError) return 'loop';
  if (IMPL_TOOLS.includes(name)) return 'impl';
  if (PLAN_TOOLS.includes(name) || /search/i.test(name)) return 'plan';
  return 'tool';
}

/** The timeline kind of a user message: `/loop …` starts a loop, anything else is text. */
export function userMessageKind(text: string): EventKind {
  return /^\/loop(\s|$)/.test(text.trim()) ? 'loop' : 'text';
}

/** The timeline kind of a turn result: `ok` on success, `error` otherwise. */
export function resultEventKind(isError: boolean): EventKind {
  return isError ? 'error' : 'ok';
}

/** The normalized command of a Bash input (whitespace collapsed), for the rerun check. */
export function bashCommand(input: Readonly<Record<string, unknown>>): string | null {
  const command = input['command'];
  return typeof command === 'string' ? command.trim().replace(/\s+/g, ' ') : null;
}

function firstLine(text: string, max = 120): string {
  const line = text.trim().split('\n', 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function baseName(file: string): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? file;
}

/** A one-line label for a tool call (the timeline block and terminal-tail text). */
export function toolLabel(name: string, input: Readonly<Record<string, unknown>>): string {
  const s = (key: string): string | null => (typeof input[key] === 'string' ? (input[key] as string) : null);
  const file = s('file_path') ?? s('notebook_path') ?? s('path');
  if (name === 'Bash') {
    const command = s('command');
    return command ? `Bash · ${firstLine(command)}` : 'Bash';
  }
  if (AGENT_TOOLS.includes(name)) {
    const description = s('description');
    const type = s('subagent_type');
    return `${name} · ${[type, description].filter(Boolean).join(' · ') || 'subagent'}`;
  }
  if (name === 'AskUserQuestion') {
    const questions = Array.isArray(input['questions']) ? (input['questions'] as unknown[]) : [];
    const first = questions[0];
    const text = first && typeof first === 'object' && typeof (first as Record<string, unknown>)['question'] === 'string'
      ? ((first as Record<string, unknown>)['question'] as string)
      : null;
    const count = questions.length;
    return text ? `${count > 1 ? `${count} questions · ` : ''}${firstLine(text)}` : 'AskUserQuestion';
  }
  if (name === 'Grep' || name === 'Glob') {
    const pattern = s('pattern');
    return pattern ? `${name} · ${firstLine(pattern)}` : name;
  }
  if (file) return `${name} · ${baseName(file)}`;
  const description = s('description') ?? s('prompt') ?? s('query') ?? s('url');
  return description ? `${name} · ${firstLine(description)}` : name;
}

/** A one-line label for a text event. */
export function textLabel(text: string): string {
  return firstLine(text);
}
