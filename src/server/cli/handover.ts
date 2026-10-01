import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLI_LABELS, type CliProviderId } from '../../core/cli-providers.ts';
import type { EventRecord } from '../db/repos/events.ts';

/**
 * D62 P5 (`docs/providers.md` → *Switching CLIs*): the texts of a mid-session
 * switch and the history export the incoming agent reads when the outgoing one
 * cannot write a handover.
 */

/** What Switchboard asks the outgoing agent for (sent as a service message). */
export function handoverRequest(to: CliProviderId): string {
  const next = CLI_LABELS[to];
  return [
    `Switchboard is handing this session over to ${next} now.`,
    `Write a handover for it as your whole reply: the goal, the decisions made so far, the files you changed, the open tasks, the next step, and anything uncommitted (run \`git status\` to check).`,
    `Don't start new work: ${next} continues from your handover.`,
  ].join(' ');
}

/** The incoming agent's first message when the outgoing one wrote the handover. */
export function incomingWithHandover(from: CliProviderId, to: CliProviderId, cwd: string, handover: string): string {
  return [
    `You are continuing a session that ${CLI_LABELS[from]} worked on until now, in this folder: ${cwd}. Switchboard switched it from ${CLI_LABELS[from]} to ${CLI_LABELS[to]}; ${CLI_LABELS[from]} wrote this handover:`,
    '',
    '---',
    handover.trim(),
    '---',
    '',
    'Read it, check `git status` for anything uncommitted, then continue with the next step.',
  ].join('\n');
}

/** The incoming agent's first message when it reads the history itself. */
export function incomingFromHistory(input: {
  readonly from: CliProviderId;
  readonly to: CliProviderId;
  readonly cwd: string;
  readonly reason: string;
  readonly exportPath: string;
  readonly transcriptPath: string | null;
  readonly nativeHint: string | null;
}): string {
  const from = CLI_LABELS[input.from];
  const sources = [`the session's chat so far, exported by Switchboard: ${input.exportPath}`];
  if (input.transcriptPath) sources.push(`${from}'s own transcript: ${input.transcriptPath}`);
  if (input.nativeHint) sources.push(input.nativeHint);
  return [
    `You are continuing a session that ${from} worked on until now, in this folder: ${input.cwd}. Switchboard switched it from ${from} to ${CLI_LABELS[input.to]}, and ${from} could not write a handover (${input.reason}).`,
    '',
    `Read ${sources.length === 1 ? 'this file' : 'these'} first:`,
    ...sources.map((source) => `- ${source}`),
    '',
    'Then summarize where things stand (the goal, decisions made, files changed, open tasks, the next step), check `git status` for anything uncommitted, and continue.',
  ].join('\n');
}

/**
 * D63: the first message after an account switch that could not carry the CLI's own
 * conversation over (OpenCode's storage is not copyable; a Codex rollout that could not
 * be copied): the same CLI on another account reads the exported chat and continues.
 */
export function incomingAfterAccountSwitch(input: {
  readonly cli: CliProviderId;
  readonly cwd: string;
  readonly fromName: string;
  readonly toName: string;
  readonly reason: string;
  readonly exportPath: string;
  readonly transcriptPath: string | null;
}): string {
  const sources = [`the session's chat so far, exported by Switchboard: ${input.exportPath}`];
  if (input.transcriptPath) sources.push(`${CLI_LABELS[input.cli]}'s own record of it: ${input.transcriptPath}`);
  return [
    `You are continuing a session in this folder: ${input.cwd}. Switchboard moved it from the account "${input.fromName}" to "${input.toName}" (${input.reason}); the earlier conversation could not be carried over, so it was exported.`,
    '',
    `Read ${sources.length === 1 ? 'this file' : 'these'} first:`,
    ...sources.map((source) => `- ${source}`),
    '',
    'Then summarize where things stand (the goal, decisions made, files changed, open tasks, the next step), check `git status` for anything uncommitted, and continue. The turn that was running when the limit hit was interrupted: finish it.',
  ].join('\n');
}

/** Bytes of chat an export keeps (the newest part when a session's chat is longer). */
export const EXPORT_LIMIT_BYTES = 2 * 1024 * 1024;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** One tool step as a line (`- Bash: npm test → failed`). */
function toolLine(payload: Record<string, unknown>): string {
  const name = text(payload['name']) || 'tool';
  const input = record(payload['input']);
  const what = text(input['command']) || text(input['file_path']) || text(input['pattern']) || text(input['description']) || text(input['url']);
  const outcome = payload['isError'] === true ? 'failed' : payload['result'] !== undefined ? 'done' : 'started';
  return `- ${name}${what ? `: ${what.split('\n')[0]?.slice(0, 200)}` : ''} → ${outcome}`;
}

/**
 * The chat as Markdown (D62 P5): the developer's messages, the agents' texts
 * (subagents marked), the tool steps one line each, errors and earlier
 * switches; the newest {@link EXPORT_LIMIT_BYTES} when longer.
 */
export function chatMarkdown(input: {
  readonly title: string;
  readonly cwd: string;
  readonly from: CliProviderId;
  readonly to: CliProviderId;
  readonly at: Date;
  readonly events: readonly EventRecord[];
  readonly mainAgentId: string | null;
}): string {
  const head = [
    `# ${input.title} — the chat so far`,
    '',
    `Exported by Switchboard on ${input.at.toISOString()} for the switch from ${CLI_LABELS[input.from]} to ${CLI_LABELS[input.to]}.`,
    `Folder: ${input.cwd}`,
    '',
  ];
  const body: string[] = [];
  for (const event of input.events) {
    const payload = record(event.payload);
    const who = event.agentId && input.mainAgentId && event.agentId !== input.mainAgentId ? ' (subagent)' : '';
    switch (payload['type']) {
      case 'user':
        body.push(`## ${event.ts} · ${payload['origin'] === 'service' ? 'Switchboard' : 'Developer'}`, '', text(payload['sentText']) || text(payload['text']), '');
        break;
      case 'assistant':
        body.push(`## ${event.ts} · Agent${who}`, '', text(payload['text']), '');
        break;
      case 'tool':
        body.push(toolLine(payload));
        break;
      case 'result':
        if (payload['isError'] === true) body.push(`- turn ended with an error: ${event.label}`, '');
        break;
      case 'lifecycle':
        if (payload['action'] === 'switched') body.push('', `--- ${event.label} ---`, '');
        break;
      default:
        if (event.kind === 'error') body.push(`- error: ${event.label}`);
    }
  }
  let joined = body.join('\n');
  if (Buffer.byteLength(joined) > EXPORT_LIMIT_BYTES) {
    joined = `[… the older part of the chat is left out: the export keeps the newest ${EXPORT_LIMIT_BYTES / 1024 / 1024} MB …]\n\n${Buffer.from(joined).subarray(-EXPORT_LIMIT_BYTES).toString('utf8')}`;
  }
  return `${head.join('\n')}${joined}\n`;
}

/** Writes an export to `<dir>/<session id>/<stamp>-<from>-to-<to>.md` (folder 0700, file 0600); its path. */
export async function writeExport(dir: string, sessionId: string, from: CliProviderId, to: CliProviderId, at: Date, markdown: string): Promise<string> {
  const folder = path.join(dir, sessionId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const file = path.join(folder, `${stamp}-${from}-to-${to}.md`);
  await writeFile(file, markdown, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
  return file;
}

/**
 * A Codex thread's rollout file (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl`,
 * VERIFIED `codex-rs/rollout`), `null` when none is found. Read only by name.
 */
export async function findCodexRollout(env: NodeJS.ProcessEnv, threadId: string): Promise<string | null> {
  const home = env['CODEX_HOME'] && env['CODEX_HOME'].trim() !== '' ? env['CODEX_HOME'] : path.join(os.homedir(), '.codex');
  const root = path.join(home, 'sessions');
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) {
        const found = await walk(full, depth + 1);
        if (found) return found;
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && (entry.name.endsWith(`-${threadId}.jsonl`) || entry.name.endsWith(`-${threadId}.jsonl.zst`))) {
        return full;
      }
    }
    return null;
  };
  return walk(root, 0);
}
