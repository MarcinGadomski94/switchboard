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
