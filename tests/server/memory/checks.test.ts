import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MEMORY_CHECK_JITTER_MS,
  MEMORY_REMOVED_KEEP_DAYS,
  extractJsonObject,
  memoryCheckActive,
  memoryCheckDueAt,
  memoryCheckJitterMs,
  memoryCheckLine,
  memoryCheckPrompt,
  memoryCheckSummary,
  memoryRemovalCap,
  readCheckAnswer,
  readConflictAnswer,
} from '../../../src/core/memory-check.ts';
import type { MemoryEntry } from '../../../src/core/memory.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { DEVICE_ALLOWED, DEVICE_REFUSED, isLocalOnly, matchesRule } from '../../../src/server/devices/local-only.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { MEMORY_CHECK_AUTHOR } from '../../../src/core/memory-check.ts';
import { MEMORY_CHECK_ALLOWED_TOOLS, type MemoryCheckHost, type MemoryCheckOutput, type MemoryCheckRun, claudeCheckRunner, memoryCheckArgs, memoryGitContext } from '../../../src/server/memory/check.ts';
import { runCommand, succeeded } from '../../../src/server/exec.ts';
import { appCheckHost } from '../../../src/server/memory/install.ts';
import { MemoryService } from '../../../src/server/memory/service.ts';
import { UsageService } from '../../../src/server/insights/usage.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { fakeClaudeCommand } from '../../../tools/fake-claude/command.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D136 · Project memory checks (`docs/memory.md` → *Checking notes*): the periodic check's schedule
 * (first sighting + jitter, the activity gate, the usage gate, last-run persistence across a
 * restart, one run per tick, the switches), the validation of the model's output, the removal cap,
 * the recoverable removal (never injected) with Restore and the 30-day purge, the check-filed D135
 * proposals, and the proposal check's plumbing through the real runner and fake-claude.
 */

const DAY = 24 * 60 * 60 * 1000;

interface FakeHost extends MemoryCheckHost {
  blocked: string | null;
  activity: Map<string, string>;
  cli: Map<string, 'claude' | 'codex' | 'opencode'>;
  usage: Array<{ folder: string; tokens: number }>;
  manualAsked: boolean[];
}

interface Rig {
  readonly root: string;
  readonly dataDir: string;
  readonly store: Store;
  memory: MemoryService;
  readonly workspace: string;
  readonly other: string;
  readonly clock: { now: Date };
  readonly host: FakeHost;
  readonly runs: MemoryCheckRun[];
  answer: (run: MemoryCheckRun) => MemoryCheckOutput | Promise<MemoryCheckOutput>;
}

const rigs: Rig[] = [];

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.memory.close();
    await r.store.close();
    await removeTempDir(r.root);
  }
});

function fakeHost(workDir: string): FakeHost {
  const host: FakeHost = {
    blocked: null,
    activity: new Map(),
    cli: new Map(),
    usage: [],
    manualAsked: [],
    workDir,
    command: async () => ['claude'],
    async account(manual) {
      host.manualAsked.push(manual);
      return host.blocked !== null && !(manual && host.blocked.startsWith('warn')) ? { blocked: host.blocked } : { profileId: 'default-claude', env: {} };
    },
    folderCli: async (folder) => host.cli.get(folder) ?? null,
    lastActivity: async (folder) => host.activity.get(folder) ?? null,
    recordUsage(row) {
      host.usage.push({ folder: row.folder, tokens: row.tokens.reduce((sum, t) => sum + t.input + t.output, 0) });
    },
  };
  return host;
}

function service(r: Pick<Rig, 'dataDir' | 'store' | 'clock' | 'host' | 'runs'> & { answer: Rig['answer'] }): MemoryService {
  return new MemoryService({
    dataDir: r.dataDir,
    store: r.store,
    bus: new HubBus(),
    supervisor: { instructionSettingChanged: async () => undefined },
    now: () => r.clock.now,
    onError: () => undefined,
    check: {
      host: r.host,
      tickMs: 10 * DAY,
      runner: async (run) => {
        r.runs.push(run);
        return await r.answer(run);
      },
    },
  });
}

async function setup(label = 'memory-checks'): Promise<Rig> {
  const root = await realpath(await makeTempDir(label));
  const dataDir = path.join(root, 'data');
  const store = await openTempStore(dataDir);
  const workspace = path.join(root, 'acme-workspace');
  const other = path.join(root, 'acme-other');
  await mkdir(workspace, { recursive: true });
  await mkdir(other, { recursive: true });
  const clock = { now: new Date('2026-10-26T10:00:00.000Z') };
  const host = fakeHost(dataDir);
  const runs: MemoryCheckRun[] = [];
  const partial: Pick<Rig, 'dataDir' | 'store' | 'clock' | 'host' | 'runs' | 'answer'> = { dataDir, store, clock, host, runs, answer: () => ({ ok: true, text: '{"notes":[]}', tokens: [], durationMs: 1 }) };
  const r: Rig = { ...partial, root, workspace, other, memory: service(partial) };
  r.memory = service(r);
  await r.memory.start();
  rigs.push(r);
  return r;
}

/** Restart: a new service on the same data folder. */
async function restart(r: Rig): Promise<void> {
  await r.memory.close();
  r.memory = service(r);
  await r.memory.start();
}

function answerWith(r: Rig, notes: unknown[]): void {
  r.answer = () => ({ ok: true, text: `Here you go:\n\`\`\`json\n${JSON.stringify({ notes })}\n\`\`\``, tokens: [{ model: 'claude-sonnet', input: 100, output: 20, cacheWrite: 0, cacheRead: 5 }], durationMs: 1200 });
}

async function note(r: Rig, title: string, text: string, folder: string = r.workspace): Promise<MemoryEntry> {
  return r.memory.add({ scope: folder, title, text });
}

async function tick(r: Rig): Promise<string | null> {
  const checks = r.memory.checks;
  if (!checks) throw new Error('no checks');
  const { started } = await checks.tick();
  await checks.idle();
  return started;
}

function at(r: Rig, iso: string): void {
  r.clock.now = new Date(iso);
}

describe('D136 · the schedule (pure parts)', () => {
  it('jitter is stable per folder, inside the window, and spreads folders', () => {
    const a = memoryCheckJitterMs('/work/acme-app');
    expect(memoryCheckJitterMs('/work/acme-app')).toBe(a);
    const values = ['/a', '/b', '/work/acme-app', '/work/acme-api', '/x/y/z'].map(memoryCheckJitterMs);
    for (const value of values) expect(value >= 0 && value < MEMORY_CHECK_JITTER_MS).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });

  it('due: first sighting + jitter, then last run + period + jitter, a failed run within a day', () => {
    const folder = '/work/acme-app';
    const j = memoryCheckJitterMs(folder);
    const seen = '2026-10-01T00:00:00.000Z';
    expect(memoryCheckDueAt({ folder, firstSeenAt: seen, lastRunAt: null, lastOutcome: null, frequencyDays: 7 })).toBe(Date.parse(seen) + j);
    expect(memoryCheckDueAt({ folder, firstSeenAt: seen, lastRunAt: '2026-10-10T00:00:00.000Z', lastOutcome: 'done', frequencyDays: 7 })).toBe(Date.parse('2026-10-17T00:00:00.000Z') + j);
    expect(memoryCheckDueAt({ folder, firstSeenAt: seen, lastRunAt: '2026-10-10T00:00:00.000Z', lastOutcome: 'failed', frequencyDays: 7 })).toBe(Date.parse('2026-10-11T00:00:00.000Z') + j);
  });

  it('activity gate: activity after the last run (never run: within the last period)', () => {
    const now = Date.parse('2026-10-26T00:00:00.000Z');
    expect(memoryCheckActive(null, null, now, 7)).toBe(false);
    expect(memoryCheckActive('2026-10-20T00:00:00.000Z', null, now, 7)).toBe(true);
    expect(memoryCheckActive('2026-10-01T00:00:00.000Z', null, now, 7)).toBe(false);
    expect(memoryCheckActive('2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z', now, 7)).toBe(false);
    expect(memoryCheckActive('2026-10-22T00:00:00.000Z', '2026-10-21T00:00:00.000Z', now, 7)).toBe(true);
  });

  it('the removal cap: at most 5, at most half (rounded down)', () => {
    expect([0, 1, 2, 3, 4, 9, 10, 11, 40].map(memoryRemovalCap)).toEqual([0, 0, 1, 1, 2, 4, 5, 5, 5]);
  });

  it('the summary and the line', () => {
    const done = { at: '2026-10-24T10:00:00.000Z', outcome: 'done' as const, trigger: 'periodic' as const, checked: 12, removed: 1, edits: 2, retracts: 0, reason: null };
    expect(memoryCheckSummary(done)).toBe('checked 12 notes, removed 1, proposed 2 edits');
    expect(memoryCheckSummary({ ...done, outcome: 'skipped', reason: 'no notes' })).toBe('skipped: no notes');
    const status = { enabled: true, settings: { enabled: true, frequencyDays: 7 }, lastResult: done, lastRunAt: done.at, running: false };
    expect(memoryCheckLine(status, Date.parse('2026-10-26T10:00:00.000Z'))).toBe('Checked 2 days ago: checked 12 notes, removed 1, proposed 2 edits.');
    expect(memoryCheckLine({ ...status, running: true }, 0)).toBe('Checking the notes now…');
    expect(memoryCheckLine({ ...status, lastResult: null, lastRunAt: null }, 0)).toBe('Not checked yet. Notes are checked weekly while agents work here.');
  });
});

describe('D136 · output validation', () => {
  const ids = new Set(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']);

  it('reads the JSON inside fences and words; refuses an answer that is not one', () => {
    expect(extractJsonObject('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(readCheckAnswer('no json here', ids)).toEqual({ ok: false, decisions: [], problems: ['the answer was not a JSON object with a notes list'] });
  });

  it('keeps valid decisions, drops unknown ids, duplicates, missing reasons and over-long fields', () => {
    const answer = readCheckAnswer(
      JSON.stringify({
        notes: [
          { id: 'aaaaaaaaaa', action: 'keep' },
          { id: 'aaaaaaaaaa', action: 'remove', reason: 'twice' },
          { id: 'bbbbbbbbbb', action: 'remove' },
          { id: 'bbbbbbbbbb', action: 'remove', reason: 'The script was deleted in 4f2e1.' },
          { id: 'cccccccccc', action: 'edit', reason: 'renamed' },
          { id: 'cccccccccc', action: 'edit', title: 'x'.repeat(81), reason: 'renamed' },
          { id: 'cccccccccc', action: 'edit', text: 'npm run test:unit', reason: 'renamed' },
          { id: 'zzzzzzzzzz', action: 'remove', reason: 'not ours' },
          { id: 'bbbbbbbbbb', action: 'shout', reason: 'x' },
          { id: 'aaaaaaaaaa', action: 'remove', reason: 'y'.repeat(501) },
          'nonsense',
        ],
      }),
      ids,
    );
    expect(answer.ok).toBe(true);
    expect(answer.decisions).toEqual([
      { id: 'aaaaaaaaaa', action: 'keep' },
      { id: 'bbbbbbbbbb', action: 'remove', reason: 'The script was deleted in 4f2e1.' },
      { id: 'cccccccccc', action: 'edit', title: null, text: 'npm run test:unit', reason: 'renamed' },
    ]);
    expect(answer.problems).toHaveLength(8);
    expect(answer.problems.join('\n')).toContain('unknown note id zzzzzzzzzz');
    expect(answer.problems.join('\n')).toContain('remove without a reason');
  });

  it('the proposal check: none, a verdict about an approved id with a reason, else invalid', () => {
    expect(readConflictAnswer('{"verdict":"none"}', ids)).toEqual({ verdict: 'none' });
    expect(readConflictAnswer('{"verdict":"conflict","id":"aaaaaaaaaa","reason":"Ports differ."}', ids)).toEqual({ verdict: 'conflict', id: 'aaaaaaaaaa', reason: 'Ports differ.' });
    expect(readConflictAnswer('{"verdict":"duplicate","id":"zzzzzzzzzz","reason":"x"}', ids).verdict).toBe('invalid');
    expect(readConflictAnswer('{"verdict":"duplicate","id":"aaaaaaaaaa"}', ids).verdict).toBe('invalid');
    expect(readConflictAnswer('{"verdict":"maybe"}', ids).verdict).toBe('invalid');
    expect(readConflictAnswer('nothing', ids).verdict).toBe('invalid');
  });
});

describe('D136 · the periodic check', () => {
  it('first sighting waits for its jitter; the activity gate; the usage gate; one run per tick', async () => {
    const r = await setup();
    await note(r, 'Acme tests', 'Run npm test.');
    await note(r, 'Acme other', 'Other folder.', r.other);
    // Seen now: neither is due before its jitter.
    expect(await tick(r)).toBeNull();
    expect(r.runs).toHaveLength(0);
    at(r, new Date(r.clock.now.getTime() + MEMORY_CHECK_JITTER_MS).toISOString());
    // Due, but no agent worked there: nothing runs.
    expect(await tick(r)).toBeNull();
    r.host.activity.set(r.workspace, '2026-10-26T09:00:00.000Z');
    r.host.activity.set(r.other, '2026-10-26T09:00:00.000Z');
    // At the warning level: nothing runs (and nothing is recorded as run).
    r.host.blocked = 'warn: the account Default is at 92% of its limit';
    expect(await tick(r)).toBeNull();
    expect(r.memory.checkStatus(r.workspace).lastRunAt).toBeNull();
    r.host.blocked = null;
    // One folder per tick.
    const first = await tick(r);
    expect([r.workspace, r.other]).toContain(first);
    expect(r.runs).toHaveLength(1);
    const second = await tick(r);
    expect(second).not.toBe(first);
    expect(r.runs).toHaveLength(2);
    expect(await tick(r)).toBeNull();
    expect(r.runs.map((run) => run.purpose)).toEqual(['periodic', 'periodic']);
    expect(r.runs.every((run) => run.model === 'sonnet' && (run.cwd === r.workspace || run.cwd === r.other))).toBe(true);
  });

  it('last run persists across a restart; the next run waits a period and new activity', async () => {
    const r = await setup();
    await note(r, 'Acme tests', 'Run npm test.');
    await tick(r);
    r.host.activity.set(r.workspace, '2026-10-26T12:00:00.000Z');
    at(r, '2026-10-26T18:00:00.000Z');
    expect(await tick(r)).toBe(r.workspace);
    const ranAt = r.memory.checkStatus(r.workspace).lastRunAt;
    expect(ranAt).toBe('2026-10-26T18:00:00.000Z');
    await restart(r);
    at(r, '2026-10-27T18:00:00.000Z');
    r.host.activity.set(r.workspace, '2026-10-27T17:00:00.000Z');
    expect(await tick(r)).toBeNull();
    expect(r.memory.checkStatus(r.workspace).lastRunAt).toBe(ranAt);
    at(r, new Date(Date.parse('2026-10-26T18:00:00.000Z') + 7 * DAY + memoryCheckJitterMs(r.workspace) + 1).toISOString());
    expect(await tick(r)).toBe(r.workspace);
    expect(r.runs).toHaveLength(2);
  });

  it('the switches: off globally or for a folder, nothing runs; the frequency moves the due time', async () => {
    const r = await setup();
    await note(r, 'Acme tests', 'Run npm test.');
    r.host.activity.set(r.workspace, '2026-10-26T09:30:00.000Z');
    await tick(r);
    at(r, '2026-10-27T10:00:00.000Z');
    r.memory.setCheckSettings({ enabled: false });
    expect(await tick(r)).toBeNull();
    r.memory.setCheckSettings({ enabled: true });
    r.memory.setCheckFolder({ scope: r.workspace, enabled: false });
    expect(await tick(r)).toBeNull();
    expect(r.memory.checkStatus(r.workspace).enabled).toBe(false);
    r.memory.setCheckFolder({ scope: r.workspace, enabled: true });
    expect(await tick(r)).toBe(r.workspace);
    expect(() => r.memory.setCheckSettings({ frequencyDays: 5 })).toThrow(/frequencyDays/);
    expect(r.memory.setCheckSettings({ frequencyDays: 1 }).frequencyDays).toBe(1);
    expect(Date.parse(r.memory.checkStatus(r.workspace).nextDueAt ?? '')).toBe(Date.parse('2026-10-28T10:00:00.000Z') + memoryCheckJitterMs(r.workspace));
  });

  it('a folder whose agents use another CLI is skipped with the reason; Check now runs at once and skips the warning level, not a pause', async () => {
    const r = await setup();
    await note(r, 'Acme tests', 'Run npm test.');
    r.host.cli.set(r.workspace, 'codex');
    r.memory.checkNow({ scope: r.workspace });
    await r.memory.checks?.idle();
    expect(r.runs).toHaveLength(0);
    expect(r.memory.checkStatus(r.workspace).lastResult).toMatchObject({ outcome: 'skipped', trigger: 'manual', reason: expect.stringContaining('Codex') });
    r.host.cli.set(r.workspace, 'claude');
    r.host.blocked = 'warn: at 95%';
    r.memory.checkNow({ scope: r.workspace });
    await r.memory.checks?.idle();
    expect(r.runs).toHaveLength(1);
    r.host.blocked = 'usage is paused: every account is out of allowance';
    r.memory.checkNow({ scope: r.workspace });
    await r.memory.checks?.idle();
    expect(r.runs).toHaveLength(1);
    expect(r.memory.checkStatus(r.workspace).lastResult?.reason).toBe('usage is paused: every account is out of allowance');
  });

  it('applies removals (recoverable, never injected), files edits and over-cap removals as proposals, records the tokens', async () => {
    const r = await setup();
    const notes: MemoryEntry[] = [];
    for (let i = 1; i <= 6; i++) notes.push(await note(r, `Acme fact ${i}`, `Fact number ${i}.`));
    const sessionId = (await r.store.sessions.create({ name: 'agent', claudeSessionId: 'c-agent', attached: true, title: 'Acme agent', root: r.workspace, rootKind: 'workspace', cwd: r.workspace })).id;
    answerWith(r, [
      { id: notes[0]?.id, action: 'remove', reason: 'scripts/old.sh is gone.' },
      { id: notes[1]?.id, action: 'remove', reason: 'The branch release/1 was deleted.' },
      { id: notes[2]?.id, action: 'remove', reason: 'Replaced by the new build.' },
      { id: notes[3]?.id, action: 'remove', reason: 'No longer used.' },
      { id: notes[4]?.id, action: 'edit', text: 'Fact number five, updated.', reason: 'The value changed.' },
      { id: notes[5]?.id, action: 'keep' },
    ]);
    r.memory.checkNow({ scope: r.workspace });
    await r.memory.checks?.idle();
    const result = r.memory.checkStatus(r.workspace).lastResult;
    // Cap: half of 6 = 3 removed, the 4th becomes a retract proposal.
    expect(result).toMatchObject({ outcome: 'done', checked: 6, removed: 3, edits: 1, retracts: 1 });
    const approved = r.memory.entries({ scope: r.workspace, status: 'approved' }).map((e) => e.title);
    expect(approved.sort()).toEqual(['Acme fact 4', 'Acme fact 5', 'Acme fact 6']);
    const removed = r.memory.removed(r.workspace);
    expect(removed.map((row) => row.entry.title).sort()).toEqual(['Acme fact 1', 'Acme fact 2', 'Acme fact 3']);
    expect(removed[0]?.removedBy).toBe('check');
    expect(Date.parse(removed[0]?.purgeAt ?? '') - Date.parse(removed[0]?.removedAt ?? '')).toBe(MEMORY_REMOVED_KEEP_DAYS * DAY);
    // Never injected, never listed to agents.
    const block = (await r.memory.blockFor({ id: sessionId, kind: 'session', root: r.workspace })) ?? '';
    expect(block).not.toContain('Acme fact 1');
    expect(block).toContain('Acme fact 6');
    expect((await r.memory.agentList(sessionId)).entries.map((e) => e.title)).not.toContain('Acme fact 2');
    // The edit and the over-cap removal wait for review, authored by the check.
    const proposals = r.memory.entries({ scope: r.workspace, status: 'proposed' });
    expect(proposals.map((p) => [p.changeKind, p.targetId, p.authorLabel, p.authorSessionId])).toEqual(
      expect.arrayContaining([
        ['retract', notes[3]?.id, MEMORY_CHECK_AUTHOR, null],
        ['edit', notes[4]?.id, MEMORY_CHECK_AUTHOR, null],
      ]),
    );
    expect(r.host.usage).toEqual([{ folder: r.workspace, tokens: 120 }]);
    // A second run files nothing twice.
    answerWith(r, [{ id: notes[4]?.id, action: 'edit', text: 'Fact number five, updated.', reason: 'The value changed.' }]);
    r.memory.checkNow({ scope: r.workspace });
    await r.memory.checks?.idle();
    expect(r.memory.entries({ scope: r.workspace, status: 'proposed' })).toHaveLength(2);
  });

  it('Restore puts the note back (same id, injected again); the purge drops it after 30 days', async () => {
    const r = await setup();
    const keep = await note(r, 'Acme keep', 'Stays.');
    const gone = await note(r, 'Acme gone', 'Goes.');
    const purged = await note(r, 'Acme purged', 'Goes for good.');
    await note(r, 'Acme fourth', 'Stays too.');
    answerWith(r, [
      { id: gone.id, action: 'remove', reason: 'Outdated.' },
      { id: purged.id, action: 'remove', reason: 'Outdated too.' },
      { id: keep.id, action: 'keep' },
    ]);
    r.memory.checkNow({ scope: r.workspace });
    await r.memory.checks?.idle();
    expect(r.memory.removed(r.workspace).map((row) => row.id).sort()).toEqual([gone.id, purged.id].sort());
    const restored = await r.memory.restore(gone.id);
    expect(restored).toMatchObject({ id: gone.id, title: 'Acme gone', status: 'approved', changeKind: 'add' });
    expect(r.memory.removed(r.workspace).map((row) => row.id)).toEqual([purged.id]);
    await expect(r.memory.restore(gone.id)).rejects.toMatchObject({ status: 404 });
    // 29 days: still there; 31 days: purged by the tick.
    at(r, new Date(r.clock.now.getTime() + 29 * DAY).toISOString());
    await tick(r);
    expect(r.memory.removed(r.workspace)).toHaveLength(1);
    at(r, new Date(r.clock.now.getTime() + 2 * DAY).toISOString());
    await tick(r);
    expect(r.memory.removed(r.workspace)).toHaveLength(0);
  });

  it('a note changed while the check ran is left alone (the developer wins)', async () => {
    const r = await setup();
    const a = await note(r, 'Acme a', 'A.');
    await note(r, 'Acme b', 'B.');
    r.answer = async () => {
      // The developer edits the note while the run is in progress.
      r.clock.now = new Date(r.clock.now.getTime() + 1000);
      await r.memory.update(a.id, { text: 'A, edited.' });
      return { ok: true, text: JSON.stringify({ notes: [{ id: a.id, action: 'remove', reason: 'Outdated.' }] }), tokens: [], durationMs: 1 };
    };
    r.memory.checkNow({ scope: r.workspace });
    await r.memory.checks?.idle();
    expect(r.memory.entries({ scope: r.workspace, status: 'approved' }).find((e) => e.id === a.id)?.text).toBe('A, edited.');
    expect(r.memory.removed(r.workspace)).toEqual([]);
    expect(r.memory.checkStatus(r.workspace).lastResult).toMatchObject({ outcome: 'done', removed: 0 });
  });

  it('a failed run is recorded and tried again within a day', async () => {
    const r = await setup();
    await note(r, 'Acme a', 'A.');
    r.answer = () => ({ ok: false, error: 'the CLI exited (code 1) without an answer', tokens: [], durationMs: 5 });
    r.memory.checkNow({ scope: r.workspace });
    await r.memory.checks?.idle();
    const status = r.memory.checkStatus(r.workspace);
    expect(status.lastResult).toMatchObject({ outcome: 'failed', reason: 'the CLI exited (code 1) without an answer' });
    expect(Date.parse(status.nextDueAt ?? '') - Date.parse(status.lastRunAt ?? '')).toBe(DAY + memoryCheckJitterMs(r.workspace));
  });
});

describe('D136 · approve and remove the old note', () => {
  it('approving with removeConflicting moves the flagged note to the removed list; a plain approve keeps it', async () => {
    const r = await setup();
    const old = await note(r, 'Acme test ports', 'Use ports 4600-4699.');
    const other = await note(r, 'Acme deploy', 'Deploy on Fridays.');
    const sessionId = (await r.store.sessions.create({ name: 'agent', claudeSessionId: 'c-agent', attached: true, title: 'Acme agent', root: r.workspace, rootKind: 'workspace', cwd: r.workspace })).id;
    r.answer = (run) => ({ ok: true, text: run.prompt.includes('Never on Fridays') ? JSON.stringify({ verdict: 'conflict', id: other.id, reason: 'Fridays.' }) : JSON.stringify({ verdict: 'duplicate', id: old.id, reason: 'Same ports.' }), tokens: [], durationMs: 1 });
    const proposal = await r.memory.propose(sessionId, { title: 'Acme ports for tests', text: 'Tests use ports 4600-4699.' });
    const second = await r.memory.propose(sessionId, { title: 'Acme release day', text: 'Never on Fridays.' });
    await r.memory.checks?.idle();
    expect(r.runs.map((run) => [run.purpose, run.model, run.cwd])).toEqual([
      ['proposal', 'sonnet', r.dataDir],
      ['proposal', 'sonnet', r.dataDir],
    ]);
    const listed = r.memory.entries({ scope: r.workspace, status: 'proposed' });
    expect(listed.find((e) => e.id === proposal.id)?.check).toMatchObject({ verdict: 'duplicate', targetId: old.id, targetTitle: 'Acme test ports', reason: 'Same ports.' });
    expect(listed.find((e) => e.id === second.id)?.check).toMatchObject({ verdict: 'conflict', targetId: other.id });
    await r.memory.approve(proposal.id, { removeConflicting: true });
    expect(r.memory.entries({ scope: r.workspace, status: 'approved' }).map((e) => e.title).sort()).toEqual(['Acme deploy', 'Acme ports for tests']);
    expect(r.memory.removed(r.workspace)).toMatchObject([{ id: old.id, removedBy: 'approval', reason: expect.stringContaining('Replaced by “Acme ports for tests”') }]);
    await r.memory.approve(second.id, {});
    expect(r.memory.entries({ scope: r.workspace, status: 'approved' }).map((e) => e.title).sort()).toEqual(['Acme deploy', 'Acme ports for tests', 'Acme release day']);
  });

  it('nothing is checked while the checks are off or nothing is approved yet', async () => {
    const r = await setup();
    const sessionId = (await r.store.sessions.create({ name: 'agent', claudeSessionId: 'c-agent', attached: true, title: 'Acme agent', root: r.workspace, rootKind: 'workspace', cwd: r.workspace })).id;
    await r.memory.propose(sessionId, { title: 'Acme first', text: 'First.' });
    await note(r, 'Acme approved', 'Approved.');
    r.memory.setCheckSettings({ enabled: false });
    await r.memory.propose(sessionId, { title: 'Acme second', text: 'Second.' });
    await r.memory.checks?.idle();
    expect(r.runs).toHaveLength(0);
  });
});

describe('D136 · the plumbing with the real runner and fake-claude', () => {
  it('argv: print mode, --restricted, dontAsk, reading tools only (no shell), no MCP, no transcript', () => {
    expect(MEMORY_CHECK_ALLOWED_TOOLS).toEqual(['Read', 'Grep', 'Glob', 'LS']);
    const periodic = memoryCheckArgs('periodic', 'sonnet');
    expect(periodic).toEqual(expect.arrayContaining(['-p', '--restricted', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--no-session-persistence', '--model', 'sonnet']));
    expect(periodic[periodic.indexOf('--allowedTools') + 1]).toBe('Read,Grep,Glob,LS');
    expect(periodic.join(' ')).not.toMatch(/Bash\(/);
    expect(periodic[periodic.indexOf('--disallowedTools') + 1]?.split(',')).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch']));
    const proposal = memoryCheckArgs('proposal', 'haiku');
    expect(proposal).toContain('--restricted');
    expect(proposal).not.toContain('--allowedTools');
    expect(proposal[proposal.indexOf('--disallowedTools') + 1]?.split(',')).toEqual(expect.arrayContaining(['Bash', 'Read', 'Grep', 'Glob']));
  });

  it('Switchboard reads the git context itself (read-only, fixed argv); the periodic prompt carries it', async () => {
    const root = await realpath(await makeTempDir('memory-checks-git'));
    try {
      const repo = path.join(root, 'acme-repo');
      await mkdir(repo, { recursive: true });
      const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'Acme', GIT_COMMITTER_EMAIL: 'a@example.invalid' };
      const git = async (...args: string[]) => {
        const result = await runCommand(['git'], args, { cwd: repo, env });
        if (!succeeded(result)) throw new Error(`git ${args.join(' ')}`);
      };
      await writeFile(path.join(root, 'gitconfig'), '');
      await git('init', '-q', '-b', 'main');
      await writeFile(path.join(repo, 'build.sh'), 'echo hi\n');
      await git('add', '-A');
      await git('commit', '-q', '-m', 'Add the build script');
      await git('branch', 'release/1');
      const context = await memoryGitContext(repo, '2000-01-01T00:00:00.000Z');
      expect(context).toContain('Current branch: main');
      expect(context).toContain('release/1');
      expect(context).toMatch(/commit [0-9a-f]+ \d{4}-\d{2}-\d{2} Add the build script/);
      expect(context).toContain('A\tbuild.sh');
      expect(await memoryGitContext(root, '2000-01-01T00:00:00.000Z')).toContain('not a git working tree');
      const prompt = memoryCheckPrompt(repo, 'acme-repo', [{ id: 'aaaaaaaaaa', title: 'Build', text: 'Run build.sh' }], '2026-10-26', context);
      expect(prompt).toContain('You have no shell');
      expect(prompt).toContain('Git history (read by Switchboard):');
      expect(prompt).toContain('Add the build script');
    } finally {
      await removeTempDir(root);
    }
  });

  it('a conflicting proposal is flagged through fake-claude; the tokens reach Insights → Usage as a memory check', async () => {
    const root = await realpath(await makeTempDir('memory-checks-fake'));
    const dataDir = path.join(root, 'data');
    const store = await openTempStore(dataDir);
    const workspace = path.join(root, 'acme-workspace');
    await mkdir(workspace, { recursive: true });
    const memory = new MemoryService({
      dataDir,
      store,
      bus: new HubBus(),
      supervisor: { instructionSettingChanged: async () => undefined },
      onError: () => undefined,
      check: { runner: claudeCheckRunner(), host: appCheckHost({ store, accounts: null, command: async () => fakeClaudeCommand(), dataDir, baseEnv: { PATH: process.env['PATH'] ?? '' } }), tickMs: 10 * DAY },
    });
    try {
      await memory.start();
      const old = await memory.add({ scope: workspace, title: 'Acme staging', text: 'Deploy to staging first.' });
      const sessionId = (await store.sessions.create({ name: 'agent', claudeSessionId: 'c-agent', attached: true, title: 'Acme agent', root: workspace, rootKind: 'workspace', cwd: workspace })).id;
      const reply = JSON.stringify({ verdict: 'conflict', id: old.id, reason: 'Staging was retired.' });
      const proposal = await memory.propose(sessionId, { title: 'Acme deploys', text: `Deploy straight to production. [fake:say ${JSON.stringify(reply)}]` });
      await memory.checks?.idle();
      const flagged = memory.entries({ scope: workspace, status: 'proposed' }).find((e) => e.id === proposal.id);
      expect(flagged?.check).toMatchObject({ verdict: 'conflict', targetId: old.id, targetTitle: 'Acme staging', reason: 'Staging was retired.' });
      const turns = store.insights.usageTurns('2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z');
      expect(turns.length).toBeGreaterThan(0);
      expect(turns.every((turn) => turn.eventId < 0 && turn.folder === workspace && turn.sessionId === `memory-check~${workspace}`)).toBe(true);
      // No session was created for the check.
      expect((await store.sessions.list({})).map((s) => s.id)).toEqual([sessionId]);
      // Insights → Usage: one "Memory check" row for the folder, nothing to open.
      const usage = new UsageService({ store, backfill: { progress: () => ({ done: true, percent: 100 }) }, accounts: { usageOf: async () => null, identityOf: async () => null } });
      const answer = await usage.answer({ period: '7d', account: null, groupBy: 'session', from: null, group: null, page: 0, pageSize: 50 });
      const row = answer.rows.find((candidate) => candidate.kind === 'memory');
      expect(row).toMatchObject({ kind: 'memory', sessionId: null, label: 'Memory check · acme-workspace' });
      expect(answer.log.rows.some((line) => line.kind === 'memory' && line.title === 'Memory check · acme-workspace')).toBe(true);
      const byKind = await usage.answer({ period: '7d', account: null, groupBy: 'kind', from: null, group: null, page: 0, pageSize: 50 });
      expect(byKind.rows.map((candidate) => candidate.label)).toContain('Memory check');
    } finally {
      await memory.close();
      await store.close();
      await removeTempDir(root);
    }
  });
});

describe('D136 · phones and paired machines', () => {
  it('phones read the removed notes and the check state and Restore; the switches and Check now stay on the desktop; paired machines reach all', () => {
    for (const [method, url] of [
      ['GET', '/api/memory/removed'],
      ['POST', '/api/memory/removed/abc/restore'],
      ['GET', '/api/memory/check'],
      ['GET', '/api/memory/check/settings'],
    ] as const) {
      expect([method, url, isLocalOnly(method, url)]).toEqual([method, url, false]);
      expect(matchesRule(DEVICE_ALLOWED, method, url)).toBe(true);
      expect(peerApiAllowed(method, url)).toBe(true);
    }
    for (const [method, url] of [
      ['PUT', '/api/memory/check'],
      ['PUT', '/api/memory/check/settings'],
      ['POST', '/api/memory/check/run'],
    ] as const) {
      expect(matchesRule(DEVICE_REFUSED, method, url)).toBe(true);
      expect(peerApiAllowed(method, url)).toBe(true);
    }
  });
});
