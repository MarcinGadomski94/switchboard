/**
 * Performance harness · the synthetic world (`docs/performance.md`): a temp data
 * folder whose database looks like an install that has been used for weeks. Nothing
 * here reads a real install; every row is generated from a fixed seed, so two runs
 * build the same world.
 *
 * - one **big** session (≈13,000 events, ≈32 MB of payload): turns of a user
 *   message, Markdown answers with code blocks and tables, tool calls with long
 *   inputs and results (cut at {@link PAYLOAD_TEXT_LIMIT}, as the recorder cuts them),
 *   subagents (an Agent call, its prompt and its own tool calls), Workflow launches,
 *   one live `CronCreate` near the end (so the loop tracker follows the session);
 * - several **medium** sessions (≈4,700 events each);
 * - 2,000 usage readings, 280 turn checkpoints.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PAYLOAD_TEXT_LIMIT } from '../../src/core/event-payload.ts';
import type { EventKind } from '../../src/core/model.ts';
import { transaction } from '../../src/server/db/database.ts';
import { type Store, openStore, storeFile } from '../../src/server/db/store.ts';

/** How big the world is. */
export interface WorldShape {
  /** Events of the big session (≈). */
  readonly bigEvents: number;
  /** Medium sessions and their events (≈). */
  readonly mediumSessions: number;
  readonly mediumEvents: number;
  readonly usageReadings: number;
  readonly checkpoints: number;
}

/** The developer's report: 13,249 events / 32 MB, the next ones ≈4,700 / ≈10 MB. */
export const DEFAULT_SHAPE: WorldShape = { bigEvents: 13_000, mediumSessions: 4, mediumEvents: 4_700, usageReadings: 2_000, checkpoints: 280 };

/** What {@link seedWorld} made. */
export interface SeededWorld {
  readonly dataDir: string;
  /** The cwd every session has (a plain temp folder). */
  readonly cwd: string;
  readonly bigSessionId: string;
  readonly mediumSessionIds: readonly string[];
  /** Events and payload bytes per session id. */
  readonly sizes: ReadonlyMap<string, { readonly events: number; readonly payloadBytes: number }>;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = 'the upload flow handler retries when the token expires so we keep the session alive and write a test for the edge case where the queue drains before the worker starts which used to drop messages silently'.split(' ');

function sentence(r: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i += 1) out.push(WORDS[Math.floor(r() * WORDS.length)] ?? 'x');
  const text = out.join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function codeBlock(r: () => number, lines: number, n: number): string {
  const body: string[] = [];
  for (let i = 0; i < lines; i += 1) body.push(`  const value${i} = items.filter((item) => item.size > ${Math.floor(r() * 100)}).map((item) => item.name); // ${n}`);
  return ['```ts', `export function step${n}(items: Item[]): string[] {`, ...body, '  return value0;', '}', '```'].join('\n');
}

/** A Markdown answer: paragraphs, a code block, sometimes a table and a list (≈1–6 KB). */
function markdownAnswer(r: () => number, n: number): string {
  const parts: string[] = [`Turn ${n}: ${sentence(r, 25)} See \`src/upload/file-${n}.ts\`.`];
  const paragraphs = 1 + Math.floor(r() * 4);
  for (let i = 0; i < paragraphs; i += 1) parts.push(sentence(r, 30 + Math.floor(r() * 60)));
  if (r() < 0.7) parts.push(codeBlock(r, 4 + Math.floor(r() * 30), n));
  if (r() < 0.4) parts.push(['| File | Lines | Status |', '|---|---|---|', `| upload-${n}.ts | ${n * 3} | changed |`, `| upload-${n}.test.ts | ${n * 2} | added |`].join('\n'));
  if (r() < 0.5) parts.push([`- first point ${n}`, `- second point with a [link](https://example.com/${n})`, `- third: ${sentence(r, 12)}`].join('\n'));
  return parts.join('\n\n');
}

function cut(text: string): { text: string; truncated: boolean } {
  return text.length > PAYLOAD_TEXT_LIMIT ? { text: text.slice(0, PAYLOAD_TEXT_LIMIT), truncated: true } : { text, truncated: false };
}

function fileBody(r: () => number, chars: number): string {
  const lines: string[] = [];
  let size = 0;
  let i = 1;
  while (size < chars) {
    const line = `${String(i).padStart(5)}\t${sentence(r, 6 + Math.floor(r() * 10))}`;
    lines.push(line);
    size += line.length + 1;
    i += 1;
  }
  return lines.join('\n');
}

interface Pending {
  readonly agentId: string | null;
  readonly ts: string;
  readonly endTs: string | null;
  readonly kind: EventKind;
  readonly label: string;
  readonly payload: unknown;
  readonly uuid: string | null;
  readonly messageId: string | null;
  readonly toolUseId: string | null;
}

/** Builds one session's events (≈`target`) through `push`. */
function buildSession(
  r: () => number,
  target: number,
  startMs: number,
  endMs: number,
  mainAgentId: string,
  newSubagent: (toolUseId: string, n: number) => string,
  push: (event: Pending) => void,
  options: { readonly liveCron: boolean },
): number {
  // ≈15 events per turn on average.
  const turns = Math.max(1, Math.round(target / 15));
  const step = (endMs - startMs) / turns;
  let count = 0;
  let uuid = 0;
  const add = (event: Omit<Pending, 'uuid' | 'messageId' | 'toolUseId'> & Partial<Pick<Pending, 'messageId' | 'toolUseId'>>): void => {
    push({ messageId: null, toolUseId: null, ...event, uuid: `u-${startMs}-${(uuid += 1)}` });
    count += 1;
  };
  for (let t = 0; t < turns && count < target; t += 1) {
    let ms = startMs + t * step;
    const at = (): string => new Date((ms += 900 + Math.floor(r() * 4000))).toISOString();
    add({ agentId: null, ts: at(), endTs: null, kind: 'text', label: `Please look at item ${t}`, payload: { type: 'user', text: `Please look at item ${t} and ${sentence(r, 20)}`, origin: 'user', delivered: true } });
    add({ agentId: mainAgentId, ts: at(), endTs: null, kind: 'text', label: `Turn ${t}`, payload: { type: 'assistant', text: `I'll start by reading the relevant files. ${sentence(r, 15)}`, messageId: `msg_${t}_a` }, messageId: `msg_${t}_a` });
    const tools = 6 + Math.floor(r() * 12);
    for (let k = 0; k < tools; k += 1) {
      const id = `toolu_${startMs}_${t}_${k}`;
      const roll = r();
      const ts = at();
      const endTs = at();
      if (roll < 0.35) {
        const body = cut(fileBody(r, 800 + Math.floor(r() * 6000)));
        add({ agentId: mainAgentId, ts, endTs, kind: 'plan', label: `Read · src/upload/file-${k}.ts`, toolUseId: id, payload: { type: 'tool', name: 'Read', toolUseId: id, input: { file_path: `/work/app/src/upload/file-${k}.ts` }, result: body.text, ...(body.truncated ? { resultTruncated: true } : {}) } });
      } else if (roll < 0.55) {
        const before = cut(fileBody(r, 200 + Math.floor(r() * 2500)));
        const after = cut(fileBody(r, 200 + Math.floor(r() * 2500)));
        add({ agentId: mainAgentId, ts, endTs, kind: 'impl', label: `Edit · src/upload/file-${k}.ts`, toolUseId: id, payload: { type: 'tool', name: 'Edit', toolUseId: id, input: { file_path: `/work/app/src/upload/file-${k}.ts`, old_string: before.text, new_string: after.text }, result: `The file /work/app/src/upload/file-${k}.ts has been updated.` } });
      } else if (roll < 0.8) {
        const out = cut(fileBody(r, 300 + Math.floor(r() * 7000)));
        add({ agentId: mainAgentId, ts, endTs, kind: 'impl', label: 'Bash · npm test', toolUseId: id, payload: { type: 'tool', name: 'Bash', toolUseId: id, input: { command: 'npm test -- upload', description: 'Run the upload tests' }, result: out.text, ...(out.truncated ? { resultTruncated: true } : {}) } });
      } else if (roll < 0.93) {
        const out = cut(fileBody(r, 200 + Math.floor(r() * 2000)));
        add({ agentId: mainAgentId, ts, endTs, kind: 'plan', label: 'Grep · retry', toolUseId: id, payload: { type: 'tool', name: 'Grep', toolUseId: id, input: { pattern: 'retry', path: '/work/app/src' }, result: out.text } });
      } else if (roll < 0.985) {
        // A subagent: the Agent call, its prompt and a few tool calls of its own.
        const subagent = newSubagent(id, t);
        const result = cut(markdownAnswer(r, t));
        add({ agentId: mainAgentId, ts, endTs, kind: 'impl', label: 'Agent · review the upload flow', toolUseId: id, payload: { type: 'tool', name: 'Agent', toolUseId: id, input: { description: 'review the upload flow', prompt: sentence(r, 80), subagent_type: 'general-purpose' }, result: result.text } });
        add({ agentId: subagent, ts: at(), endTs: null, kind: 'text', label: 'prompt', payload: { type: 'agent-prompt', text: sentence(r, 80) } });
        for (let s = 0; s < 3; s += 1) {
          const sid = `${id}_s${s}`;
          const body = cut(fileBody(r, 500 + Math.floor(r() * 3000)));
          add({ agentId: subagent, ts: at(), endTs: at(), kind: 'plan', label: `Read · src/sub-${s}.ts`, toolUseId: sid, payload: { type: 'tool', name: 'Read', toolUseId: sid, input: { file_path: `/work/app/src/sub-${s}.ts` }, result: body.text } });
        }
        add({ agentId: subagent, ts: at(), endTs: null, kind: 'text', label: 'subagent answer', payload: { type: 'assistant', text: markdownAnswer(r, t), messageId: `msg_${t}_${k}_sub` }, messageId: `msg_${t}_${k}_sub` });
      } else {
        add({ agentId: mainAgentId, ts, endTs, kind: 'loop', label: 'Workflow · fake-audit', toolUseId: id, payload: { type: 'tool', name: 'Workflow', toolUseId: id, input: { script: fileBody(r, 600) }, result: `Workflow launched in background. Task ID: w${t}${k}\nRun ID: wf_${startMs}${t}${k}` } });
      }
    }
    add({ agentId: mainAgentId, ts: at(), endTs: null, kind: 'text', label: `Turn ${t} answer`, payload: { type: 'assistant', text: markdownAnswer(r, t), messageId: `msg_${t}_b` }, messageId: `msg_${t}_b` });
    add({ agentId: mainAgentId, ts: at(), endTs: null, kind: 'ok', label: 'Turn done', payload: { type: 'result', subtype: 'success', isError: false, text: cut(markdownAnswer(r, t)).text, terminalReason: null, errors: [], taskNotification: false, numTurns: tools, durationMs: 60_000, costUsd: 0.1, tokens: 30_000 } });
  }
  if (options.liveCron) {
    const ts = new Date(endMs - 20 * 60_000).toISOString();
    const id = `toolu_cron_${startMs}`;
    add({ agentId: mainAgentId, ts, endTs: ts, kind: 'loop', label: 'CronCreate', toolUseId: id, payload: { type: 'tool', name: 'CronCreate', toolUseId: id, input: { cron: '*/30 * * * *', prompt: 'check the CI run', recurring: true }, result: 'Scheduled recurring job a1b2c3d4 (*/30 * * * *)' } });
  }
  return count;
}

/**
 * Appends ≈`target` events of history to session `sessionId` (main agent
 * `mainAgentId`) between `startMs` and `endMs`, in one transaction, through raw
 * prepared statements (the repositories' one-row-per-call path would take minutes
 * for 30k events). Works on a store another process has open too (SQLite WAL): the
 * streaming scenario grows a live session this way. Returns the events and bytes.
 */
export function appendHistory(
  store: Store,
  sessionId: string,
  mainAgentId: string,
  target: number,
  options: { readonly seed: number | (() => number); readonly startMs: number; readonly endMs: number; readonly liveCron: boolean },
): { events: number; payloadBytes: number } {
  const r = typeof options.seed === 'number' ? rng(options.seed) : options.seed;
  const insertEvent = store.db.prepare(
    'INSERT INTO events (session_id, agent_id, ts, end_ts, kind, label, payload, uuid, message_id, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertAgent = store.db.prepare(
    "INSERT INTO agents (id, session_id, kind, name, description, status, tool_use_id, created_at, updated_at) VALUES (?, ?, 'subagent', ?, ?, 'idle', ?, ?, ?)",
  );
  const created = new Date(options.startMs).toISOString();
  let bytes = 0;
  let count = 0;
  transaction(store.db, () => {
    count = buildSession(
      r,
      target,
      options.startMs,
      options.endMs,
      mainAgentId,
      (toolUseId, n) => {
        const id = crypto.randomUUID();
        insertAgent.run(id, sessionId, `reviewer-${n}`, 'review the upload flow', toolUseId, created, created);
        return id;
      },
      (event) => {
        const json = JSON.stringify(event.payload);
        bytes += json.length;
        insertEvent.run(sessionId, event.agentId, event.ts, event.endTs, event.kind, event.label, json, event.uuid, event.messageId, event.toolUseId);
      },
      { liveCron: options.liveCron },
    );
  });
  return { events: count, payloadBytes: bytes };
}

/**
 * Seeds `dataDir` (created when missing) with the world. Returns the ids and sizes.
 */
export async function seedWorld(dataDir: string, shape: WorldShape = DEFAULT_SHAPE, seed = 42): Promise<SeededWorld> {
  const cwd = path.join(dataDir, 'work');
  await mkdir(cwd, { recursive: true });
  const store = await openStore(storeFile(dataDir));
  try {
    const r = rng(seed);
    const now = Date.now();
    const sizes = new Map<string, { events: number; payloadBytes: number }>();
    const makeSession = async (name: string, events: number, days: number, liveCron: boolean): Promise<string> => {
      const created = new Date(now - days * 86_400_000).toISOString();
      const session = await store.sessions.create({ name, claudeSessionId: crypto.randomUUID(), task: `Work on ${name}`, status: 'idle', cwd, createdAt: created, lastActivityAt: new Date(now - 60_000).toISOString(), remoteAvailable: false } as Parameters<Store['sessions']['create']>[0]);
      const main = await store.agents.create({ sessionId: session.id, name: 'main', kind: 'main', status: 'idle' });
      sizes.set(session.id, appendHistory(store, session.id, main.id, events, { seed: r, startMs: now - days * 86_400_000, endMs: now - 5 * 60_000, liveCron }));
      return session.id;
    };
    const bigSessionId = await makeSession('big-session', shape.bigEvents, 14, true);
    const mediumSessionIds: string[] = [];
    for (let i = 0; i < shape.mediumSessions; i += 1) mediumSessionIds.push(await makeSession(`medium-session-${i + 1}`, shape.mediumEvents, 5 + i, false));
    const insertUsage = store.db.prepare(
      "INSERT INTO usage_readings (received_at, source, session_id, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, raw, profile_id) VALUES (?, 'rate_limit_event', ?, ?, ?, ?, ?, ?, 'default-claude')",
    );
    transaction(store.db, () => {
      for (let i = 0; i < shape.usageReadings; i += 1) {
        const at = new Date(now - (shape.usageReadings - i) * 5 * 60_000).toISOString();
        insertUsage.run(at, bigSessionId, Math.floor(r() * 100), at, Math.floor(r() * 100), at, JSON.stringify({ i }));
      }
    });
    const insertCheckpoint = store.db.prepare(
      "INSERT INTO turn_checkpoints (session_id, kind, turn_seq, event_id, group_id, repo_path, ref, commit_sha, tree, index_tree, head, branch, created_at) VALUES (?, 'turn', ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, 'main', ?)",
    );
    transaction(store.db, () => {
      for (let i = 0; i < shape.checkpoints; i += 1) {
        const sha = i.toString(16).padStart(40, '0');
        insertCheckpoint.run(bigSessionId, i + 1, `g-${i}`, cwd, `refs/switchboard/checkpoints/${i}`, sha, sha, new Date(now - (shape.checkpoints - i) * 60_000).toISOString());
      }
    });
    return { dataDir, cwd, bigSessionId, mediumSessionIds, sizes };
  } finally {
    await store.close();
  }
}
