import { describe, expect, it } from 'vitest';
import type { Session, SessionEvent } from '../../src/core/api.ts';
import type { RepoResolution, TakeoverPreview, TakeoverRun } from '../../src/core/takeover.ts';
import { TAKEOVER_STEPS, TAKEOVER_STEP_LABELS } from '../../src/core/takeover.ts';
import { canStart, clonePathsOf, dialogTitle, directionOf, moveLabel, offersTakeover, runHeadline, stepMark, workLine } from '../../src/web/takeover/takeover.ts';
import { chatItems } from '../../src/web/views/session/chat.ts';

/** D65 (web): who offers a take-over, the dialog's labels and Start rule, how a run reads, and the chat's two dividers. */

const online = { id: 'abcdefghijkl', name: 'office-pc', state: 'online' as const };

function session(extra: Partial<Session> = {}): Pick<Session, 'machine' | 'closedAt' | 'movedTo' | 'remote' | 'hooked'> {
  return { machine: null, closedAt: null, movedTo: null, remote: { available: true, enabled: false, url: null }, hooked: false, ...extra };
}

function resolution(extra: Partial<RepoResolution> = {}): RepoResolution {
  return { key: 'app', name: 'app', branch: 'feature/x', action: 'use', matchedPath: '/code/app', folderId: 'f', worktreePath: null, cloneTo: null, cloneUrl: null, reason: null, summary: 'Use /code/app', uncommitted: 3, ahead: 2, ...extra };
}

function preview(extra: Partial<TakeoverPreview> = {}, repos: RepoResolution[] = [resolution()]): TakeoverPreview {
  return {
    source: { hooked: false } as TakeoverPreview['source'],
    target: { repos, blockers: [] } as unknown as TakeoverPreview['target'],
    stopsTerminal: false,
    ok: true,
    blockers: [],
    ...extra,
  };
}

function run(extra: Partial<TakeoverRun> = {}): TakeoverRun {
  return {
    id: 'r',
    state: 'running',
    steps: TAKEOVER_STEPS.map((id) => ({ id, label: TAKEOVER_STEP_LABELS[id], status: 'pending' as const, detail: null })),
    error: null,
    rolledBack: null,
    rollbackNotes: [],
    result: null,
    leftovers: [],
    log: [],
    ...extra,
  };
}

describe('D65: which sessions offer a take-over', () => {
  it('a peer\'s session is taken over here, this machine\'s own is moved', () => {
    expect(directionOf({ machine: online })).toBe('take-over');
    expect(directionOf({ machine: null })).toBe('move');
    expect(dialogTitle('take-over', 'office-pc')).toBe('Take over from office-pc');
    expect(dialogTitle('move', 'office-pc')).toBe('Move to office-pc');
    expect(moveLabel('office-pc')).toBe('Move to office-pc ▸');
  });

  it('not for a closed or an already moved session, an unreachable peer, or a session nothing runs; a hooked terminal session is fine', () => {
    expect(offersTakeover(session())).toBe(true);
    expect(offersTakeover(session({ machine: online }))).toBe(true);
    expect(offersTakeover(session({ closedAt: '2026-10-04T00:00:00.000Z' }))).toBe(false);
    expect(offersTakeover(session({ movedTo: { machineId: 'm', machineName: 'x', sessionId: 's', at: 'now' } }))).toBe(false);
    expect(offersTakeover(session({ machine: { ...online, state: 'offline' } }))).toBe(false);
    expect(offersTakeover(session({ remote: null }))).toBe(false);
    expect(offersTakeover(session({ remote: null, hooked: true }))).toBe(true);
  });
});

describe('D65: the repo rows and the Start rule', () => {
  it('says what the work is: uncommitted files and unpushed commits', () => {
    expect(workLine({ uncommitted: 3, ahead: 2 })).toBe('3 uncommitted files · 2 unpushed commits');
    expect(workLine({ uncommitted: 1, ahead: 1 })).toBe('1 uncommitted file · 1 unpushed commit');
    expect(workLine({ uncommitted: 0, ahead: null })).toBe('0 uncommitted files');
  });

  it('Start needs a preview with no blocker, every clone path set, and a hooked terminal\'s stop confirmed', () => {
    expect(canStart(null, false, {})).toBe(false);
    expect(canStart(preview(), false, {})).toBe(true);
    expect(canStart(preview({ ok: false, blockers: ['x'] }), true, {})).toBe(false);
    expect(canStart(preview({ stopsTerminal: true }), false, {})).toBe(false);
    expect(canStart(preview({ stopsTerminal: true }), true, {})).toBe(true);
    const clone = preview({}, [resolution({ action: 'clone', matchedPath: null, cloneTo: '/code/app', cloneUrl: 'u' })]);
    expect(canStart(clone, false, { app: '  ' })).toBe(false);
    expect(canStart(clone, false, { app: '/elsewhere/app' })).toBe(true);
    expect(canStart(clone, false, {})).toBe(true);
  });

  it('sends the clone path of every row that clones (the suggestion too, so it goes where the dialog said)', () => {
    const clone = preview({}, [resolution({ action: 'clone', matchedPath: null, cloneTo: '/code/app', cloneUrl: 'u' })]);
    expect(clonePathsOf(clone, { app: '/code/app' })).toEqual({ app: '/code/app' });
    expect(clonePathsOf(clone, { app: '  ' })).toEqual({});
    expect(clonePathsOf(clone, { app: ' /elsewhere/app ' })).toEqual({ app: '/elsewhere/app' });
    expect(clonePathsOf(preview(), { app: '/x' })).toEqual({});
  });
});

describe('D65: how a run reads', () => {
  it('marks, headlines and the running step', () => {
    expect(['done', 'running', 'failed', 'skipped', 'pending'].map((status) => stepMark(status as never))).toEqual(['✓', '●', '✗', '–', '○']);
    expect(runHeadline(run(), 'office-pc')).toBe('Taking over to office-pc…');
    expect(runHeadline(run({ state: 'done' }), 'office-pc')).toBe('Taken over');
    expect(runHeadline(run({ state: 'done', leftovers: [{ id: 'l', repoPath: '/r', remoteName: 'origin', remoteUrl: 'u', branch: 'b', at: 'now', reason: null, machineId: null }] }), 'x')).toContain('left to clean up');
    expect(runHeadline(run({ state: 'running', error: { step: 'apply', message: 'boom' } }), 'x')).toBe('Undoing the changes…');
    expect(runHeadline(run({ state: 'failed', error: { step: 'apply', message: 'boom' }, rolledBack: true }), 'x')).toBe('The take-over failed — everything was undone');
    expect(runHeadline(run({ state: 'failed', error: { step: 'apply', message: 'boom' }, rolledBack: false }), 'x')).toContain('could not be fully undone');
    expect(runHeadline(run({ state: 'failed', error: { step: 'checks', message: 'boom' } }), 'x')).toBe('The take-over did not start');
  });
});

describe('D65: the chat\'s dividers', () => {
  it('"Taken over from <machine>" opens the new session, "Moved to <machine>" ends the old one', () => {
    const event = (id: number, label: string, payload: unknown): SessionEvent => ({ id, sessionId: 's', agentId: null, ts: `2026-10-04T00:00:0${id}.000Z`, endTs: null, kind: 'text', label, payload });
    const items = chatItems(
      [
        event(1, 'Taken over from office-pc', { type: 'lifecycle', action: 'taken-over', machine: 'office-pc' }),
        event(2, 'hello', { type: 'user', text: 'hello', origin: 'user', delivered: true }),
        event(3, 'Moved to laptop', { type: 'lifecycle', action: 'moved-away', machine: 'laptop' }),
      ],
      [],
      null,
    );
    expect(items.map((item) => item.kind)).toEqual(['divider', 'user', 'divider']);
    expect(items[0]).toMatchObject({ text: 'Taken over from office-pc', from: 'office-pc', to: null });
    expect(items[2]).toMatchObject({ text: 'Moved to laptop', from: null, to: 'laptop' });
  });
});
