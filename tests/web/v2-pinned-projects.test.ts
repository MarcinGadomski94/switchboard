import { describe, expect, it } from 'vitest';
import type { Plan, PlanItem } from '../../src/core/plans.ts';
import { anyProjectWorking, isProjectPinned, pinnedEntries, pinnedProjectLabel, pinnedProjectOf, projectPinInput } from '../../src/web/v2/shared/pinned-model.ts';

/**
 * D161 (`docs/sidebar.md` → *Pinned projects (D161)*): a pinned project in the rail with its
 * status (the Projects list's rules), Pin / Unpin's place input, and the Projects item's pulse.
 */

type PlanLike = Pick<Plan, 'id' | 'title' | 'state' | 'items' | 'progress'>;

function plan(state: Plan['state'], items: Array<PlanItem['state']>, overrides: Partial<PlanLike> = {}): PlanLike {
  const list = items.map((itemState) => ({ state: itemState, reason: null }) as unknown as PlanItem);
  return { id: 'p1', title: 'Checkout redesign', state, items: list, progress: { done: items.filter((s) => s === 'done').length, total: items.length } as Plan['progress'], ...overrides };
}

describe('D161 pinned project rows', () => {
  it('running: working with done/total; waiting when no step runs', () => {
    expect(pinnedProjectOf(plan('running', ['done', 'running', 'waiting']))).toMatchObject({ planId: 'p1', status: 'working', label: 'Working', line: '1/3', needs: 0 });
    expect(pinnedProjectOf(plan('running', ['done', 'ready']))).toMatchObject({ status: 'queued', line: '1/2' });
  });

  it('a step that needs you (a question, needs you, stopped, ready for approval) turns it amber with the count', () => {
    const row = pinnedProjectOf(plan('running', ['question', 'stopped', 'ready-to-merge', 'running']));
    expect(row).toMatchObject({ status: 'needs', needs: 3, label: '3 need you', line: '0/4' });
    expect(pinnedProjectOf(plan('paused', ['needs-you']))).toMatchObject({ status: 'needs', needs: 1, line: 'Paused' });
  });

  it('paused, draft, done and cancelled', () => {
    expect(pinnedProjectOf(plan('paused', ['running']))).toMatchObject({ status: 'paused', line: 'Paused' });
    expect(pinnedProjectOf(plan('draft', ['waiting']))).toMatchObject({ status: 'idle', line: 'Draft' });
    expect(pinnedProjectOf(plan('done', ['done']))).toMatchObject({ status: 'done', line: '' });
    expect(pinnedProjectOf(plan('cancelled', ['waiting']))).toMatchObject({ status: 'userstop', line: 'Cancelled' });
    // A finished project never shows a needs count.
    expect(pinnedProjectOf(plan('done', ['stopped'])).needs).toBe(0);
    expect(pinnedProjectLabel(pinnedProjectOf(plan('running', ['running', 'done'])))).toBe('Checkout redesign, project, Working, 1/2');
  });

  it('the Pinned list keeps the layout order with agents, crews and projects; a deleted project is left out', () => {
    const projects = [plan('running', ['running']), plan('draft', [], { id: 'r~bbbbbbbbbbbb~p2', title: 'On the mac' })];
    const entries = pinnedEntries(['plan~p1', 'plan~gone', 'plan~r~bbbbbbbbbbbb~p2'], [], [], new Map(), projects);
    expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ['project', 'plan~p1'],
      ['project', 'plan~r~bbbbbbbbbbbb~p2'],
    ]);
  });

  it('Pin goes to the end (Undo at its place), Unpin leaves the layout', () => {
    expect(isProjectPinned(['plan~p1'], 'p1')).toBe(true);
    expect(isProjectPinned([], 'p1')).toBe(false);
    expect(projectPinInput('p1', true)).toEqual({ sessionId: 'plan~p1', place: 'pinned' });
    expect(projectPinInput('p1', true, 2)).toEqual({ sessionId: 'plan~p1', place: 'pinned', index: 2 });
    expect(projectPinInput('p1', false)).toEqual({ sessionId: 'plan~p1', place: 'loose' });
  });

  it('the Projects item pulses only while a project works (running with a step running)', () => {
    expect(anyProjectWorking([plan('running', ['done', 'running'])])).toBe(true);
    expect(anyProjectWorking([plan('running', ['ready']), plan('paused', ['running']), plan('draft', ['waiting'])])).toBe(false);
    expect(anyProjectWorking([])).toBe(false);
  });
});
