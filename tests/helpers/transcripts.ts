import { randomUUID } from 'node:crypto';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { slugForCwd } from '../../tools/fake-claude/transcript.ts';
import { REPO_ROOT } from './net.ts';

/**
 * Transcript fixtures for History tests (M7.4): the M0.3/M0.4 recordings in
 * `tools/fake-claude/fixtures/transcripts/`, moved into a temp workspace root and
 * turned into the variants History has to tell apart (terminal `cli` sessions,
 * titles, stubs, other roots). Everything is written under a temp
 * `CLAUDE_CONFIG_DIR`; nothing touches `~/.claude`.
 */

/** The folder the fixtures were recorded under (home dir scrubbed to `/Users/dev`). */
export const FIXTURE_SANDBOX = '/Users/dev/RiderProjects/Acme Corp/workspace/other/switchboard/.spike/sandbox';

/** Session ids of the recorded transcripts. */
export const FIXTURE_IDS = {
  'tx-main': 'b8b908e5-75ad-4201-8f37-056b3bb0a379',
  handoff: 'bf41e86f-38c1-4b6f-b795-4084d86d0787',
  'handoff-mid': '8c831952-16b8-47eb-8cf8-7a89a69dfad6',
  'handoff-conc': '4c639eeb-0edd-4a82-ba64-4d55e93e01d2',
} as const;

/** A recorded transcript's name. */
export type FixtureName = keyof typeof FIXTURE_IDS;

type Line = Record<string, unknown>;

/** The recorded transcript as parsed lines, with `FIXTURE_SANDBOX` replaced by `sandbox` in every string. */
export async function fixtureLines(name: FixtureName, sandbox: string): Promise<Line[]> {
  const raw = await readFile(path.join(REPO_ROOT, 'tools', 'fake-claude', 'fixtures', 'transcripts', `${name}.jsonl`), 'utf8');
  const from = JSON.stringify(FIXTURE_SANDBOX).slice(1, -1);
  const to = JSON.stringify(sandbox).slice(1, -1);
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line.replaceAll(from, to)) as Line);
}

/** Every `sessionId` → `id`. */
export function withSessionId(lines: readonly Line[], id: string): Line[] {
  return lines.map((line) => (typeof line['sessionId'] === 'string' ? { ...line, sessionId: id } : line));
}

/**
 * The same conversation as if typed in an interactive terminal: `entrypoint`
 * `cli` on every envelope line and the prompts marked `typed` / `human`.
 */
export function asTerminal(lines: readonly Line[]): Line[] {
  return lines.map((line) => {
    if (typeof line['entrypoint'] !== 'string') return line;
    const next: Line = { ...line, entrypoint: 'cli' };
    if (line['promptSource'] === 'sdk') next['promptSource'] = 'typed';
    if (line['turnOrigin'] === 'sdk') next['turnOrigin'] = 'human';
    return next;
  });
}

/**
 * The conversation chain as the CLI wrote it (D16 tests): the recordings dropped
 * the private `attachment` lines (`docs/spike-m0.md` → M0.3), so some `parentUuid`
 * links dangle and the Attach-here import (`newestChain`) would stop at the first
 * gap. Each dangling link is pointed at the previous chain entry in file order.
 */
export function withChainRepaired(lines: readonly Line[]): Line[] {
  const known = new Set(lines.map((line) => line['uuid']).filter((uuid): uuid is string => typeof uuid === 'string'));
  let previous: string | null = null;
  return lines.map((line) => {
    const uuid = line['uuid'];
    if (typeof uuid !== 'string' || line['isSidechain'] === true) return line;
    const parent = line['parentUuid'];
    const next = typeof parent === 'string' && !known.has(parent) ? { ...line, parentUuid: previous } : line;
    previous = uuid;
    return next;
  });
}

/** Without the entries of `types` (e.g. `custom-title`, `agent-name`). */
export function withoutTypes(lines: readonly Line[], ...types: string[]): Line[] {
  return lines.filter((line) => !types.includes(String(line['type'])));
}

/** A `user` line as an interactive terminal writes it (`entrypoint: "cli"`). */
export function terminalUserLine(options: { sessionId: string; cwd: string; content: string; parentUuid: string | null; timestamp: string; gitBranch?: string }): Line {
  return {
    parentUuid: options.parentUuid,
    isSidechain: false,
    promptId: randomUUID(),
    type: 'user',
    message: { role: 'user', content: options.content },
    uuid: randomUUID(),
    timestamp: options.timestamp,
    permissionMode: 'default',
    promptSource: 'typed',
    turnOrigin: 'human',
    userType: 'external',
    entrypoint: 'cli',
    cwd: options.cwd,
    sessionId: options.sessionId,
    version: '2.1.283',
    gitBranch: options.gitBranch ?? 'HEAD',
  };
}

/** An assistant text line (`entrypoint` as given). */
export function assistantTextLine(options: {
  sessionId: string;
  cwd: string;
  text: string;
  parentUuid: string | null;
  timestamp: string;
  entrypoint?: string;
  gitBranch?: string;
}): Line {
  return {
    parentUuid: options.parentUuid,
    isSidechain: false,
    message: {
      model: 'claude-haiku-4-5-20251001',
      id: `msg_${randomUUID().replaceAll('-', '')}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: options.text }],
      stop_reason: 'end_turn',
    },
    requestId: `req_${randomUUID().replaceAll('-', '')}`,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: options.timestamp,
    userType: 'external',
    entrypoint: options.entrypoint ?? 'cli',
    cwd: options.cwd,
    sessionId: options.sessionId,
    version: '2.1.283',
    gitBranch: options.gitBranch ?? 'HEAD',
  };
}

/** D52: an assistant line calling one tool (`stop_reason: tool_use`). */
export function assistantToolLine(options: { sessionId: string; cwd: string; toolUseId: string; name: string; input: Record<string, unknown>; parentUuid: string | null; timestamp: string }): Line {
  return {
    parentUuid: options.parentUuid,
    isSidechain: false,
    message: {
      model: 'claude-haiku-4-5-20251001',
      id: `msg_${randomUUID().replaceAll('-', '')}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: options.toolUseId, name: options.name, input: options.input }],
      stop_reason: 'tool_use',
    },
    requestId: `req_${randomUUID().replaceAll('-', '')}`,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: options.timestamp,
    userType: 'external',
    entrypoint: 'cli',
    cwd: options.cwd,
    sessionId: options.sessionId,
    version: '2.1.283',
    gitBranch: 'HEAD',
  };
}

/** D52: the user line carrying one tool's result. */
export function toolResultLine(options: { sessionId: string; cwd: string; toolUseId: string; text: string; isError?: boolean; parentUuid: string | null; timestamp: string }): Line {
  return {
    parentUuid: options.parentUuid,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: options.toolUseId, content: options.text, is_error: options.isError === true }] },
    uuid: randomUUID(),
    timestamp: options.timestamp,
    userType: 'external',
    entrypoint: 'cli',
    cwd: options.cwd,
    sessionId: options.sessionId,
    version: '2.1.283',
    gitBranch: 'HEAD',
  };
}

/**
 * D52: one assistant message as the interactive CLI writes it (VERIFIED D52-probe-blocks,
 * CLI 2.1.284): one line per content block (a thinking block, then the text), each
 * carrying the same `message.id` and the message's `stop_reason`; chained one after
 * the other. Returns the lines.
 */
export function assistantBlockLines(options: { sessionId: string; cwd: string; text: string; parentUuid: string | null; timestamp: string; stopReason?: string }): Line[] {
  const id = `msg_${randomUUID().replaceAll('-', '')}`;
  const base = (content: unknown[], parentUuid: string | null): Line => ({
    parentUuid,
    isSidechain: false,
    message: { model: 'claude-haiku-4-5-20251001', id, type: 'message', role: 'assistant', content, stop_reason: options.stopReason ?? 'end_turn' },
    requestId: `req_${id}`,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: options.timestamp,
    userType: 'external',
    entrypoint: 'cli',
    cwd: options.cwd,
    sessionId: options.sessionId,
    version: '2.1.284',
    gitBranch: 'HEAD',
  });
  const thinking = base([{ type: 'thinking', thinking: '', signature: 'x' }], options.parentUuid);
  return [thinking, base([{ type: 'text', text: options.text }], thinking['uuid'] as string)];
}

/**
 * D52: the lines the interactive CLI writes when a scheduled task fires (VERIFIED
 * D52-probe-fire, CLI 2.1.284): `system` `scheduled_task_fire`, then the prompt as an
 * `isMeta` user line with `promptSource: "system"`, `turnOrigin: "scheduled"`.
 */
export function scheduledFireLines(options: { sessionId: string; cwd: string; prompt: string; parentUuid: string | null; timestamp: string }): Line[] {
  const fire: Line = {
    parentUuid: options.parentUuid,
    isSidechain: false,
    type: 'system',
    subtype: 'scheduled_task_fire',
    content: 'Running scheduled task',
    isMeta: false,
    uuid: randomUUID(),
    timestamp: options.timestamp,
    cwd: options.cwd,
    sessionId: options.sessionId,
    version: '2.1.284',
  };
  const prompt: Line = {
    parentUuid: fire['uuid'] as string,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: options.prompt },
    isMeta: true,
    promptSource: 'system',
    turnOrigin: 'scheduled',
    uuid: randomUUID(),
    timestamp: options.timestamp,
    userType: 'external',
    entrypoint: 'cli',
    cwd: options.cwd,
    sessionId: options.sessionId,
    version: '2.1.284',
  };
  return [fire, prompt];
}

/**
 * D52: a terminal session that ran `/loop 5m check the build` (typed as the CLI
 * writes a slash command, followed by the skill's `isMeta` body), whose turn called
 * CronCreate (`*\/5 * * * *`) and ended; then `fires` turns the CLI ran on its own
 * (each a scheduled firing, as the D52 probe recorded them). Oldest first;
 * timestamps from `start`, a firing every 300 s.
 */
export function terminalLoopLines(options: { sessionId: string; cwd: string; start: Date; fires?: number }): Line[] {
  const at = (seconds: number): string => new Date(options.start.getTime() + seconds * 1000).toISOString();
  const { sessionId, cwd } = options;
  const lines: Line[] = [
    terminalUserLine({ sessionId, cwd, content: '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>5m check the build</command-args>', parentUuid: null, timestamp: at(0) }),
  ];
  lines.push({ ...terminalUserLine({ sessionId, cwd, content: '# /loop — schedule a recurring or self-paced prompt', parentUuid: lastUuid(lines), timestamp: at(0) }), isMeta: true });
  lines.push(assistantToolLine({ sessionId, cwd, toolUseId: 'toolu_cron1', name: 'CronCreate', input: { cron: '*/5 * * * *', prompt: 'check the build', recurring: true }, parentUuid: lastUuid(lines), timestamp: at(2) }));
  lines.push(toolResultLine({ sessionId, cwd, toolUseId: 'toolu_cron1', text: 'Scheduled recurring job a5207d74 (Every 5 minutes). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days.', parentUuid: lastUuid(lines), timestamp: at(3) }));
  lines.push(...assistantBlockLines({ sessionId, cwd, text: 'Build is green.', parentUuid: lastUuid(lines), timestamp: at(5) }));
  const texts = ['Still green.', 'Green again.', 'Green.'];
  for (let n = 1; n <= (options.fires ?? 1); n++) {
    lines.push(...scheduledFireLines({ sessionId, cwd, prompt: 'check the build', parentUuid: lastUuid(lines), timestamp: at(300 * n) }));
    lines.push(...assistantBlockLines({ sessionId, cwd, text: texts[(n - 1) % texts.length] as string, parentUuid: lastUuid(lines), timestamp: at(300 * n + 1) }));
  }
  return lines;
}

/** The last chain entry's `uuid` (to append a turn after it). */
export function lastUuid(lines: readonly Line[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const uuid = lines[i]?.['uuid'];
    if (typeof uuid === 'string') return uuid;
  }
  return null;
}

/** NDJSON text of `lines`. */
export function ndjson(lines: readonly Line[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

/**
 * Writes `lines` as `<configDir>/projects/<slug(cwd)>/<id>.jsonl` (the CLI's
 * layout) and, when given, sets its mtime. Returns the file path.
 */
export async function writeTranscript(configDir: string, cwd: string, id: string, lines: readonly Line[], mtime?: Date): Promise<string> {
  const file = path.join(configDir, 'projects', slugForCwd(cwd), `${id}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, ndjson(lines));
  if (mtime) await utimes(file, mtime, mtime);
  return file;
}
