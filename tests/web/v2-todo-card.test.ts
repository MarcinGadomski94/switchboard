import { describe, expect, it } from 'vitest';
import type { SessionTodo } from '../../src/core/api.ts';
import type { Plan } from '../../src/core/plans.ts';
import { TASK_STRIP_KEY, readStripOpen, stripOrder, todoCardModel, todoPlanLink, writeStripOpen } from '../../src/web/v2/shared/todo-card-model.ts';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const MIN = 60_000;

function todo(id: string, extra: Partial<SessionTodo> = {}): SessionTodo {
  return {
    id,
    sessionId: 's1',
    title: `Acme task ${id}`,
    text: `Acme task ${id}`,
    description: null,
    plan: 'No plan',
    priority: 'medium',
    estimateMinutes: null,
    state: 'open',
    addedBy: 'developer',
    position: 0,
    createdAt: '2026-10-26T10:00:00.000Z',
    updatedAt: '2026-10-26T10:00:00.000Z',
    doneAt: null,
    removeAt: null,
    ...extra,
  };
}

describe('v2 task card · priority and status', () => {
  it('shows the priority as icon + word + colour, medium for an unknown one', () => {
    expect(todoCardModel(todo('a', { priority: 'urgent' }), null, NOW).priority).toMatchObject({ key: 'urgent', label: 'Urgent', icon: 'alert', tone: 'red' });
    expect(todoCardModel(todo('a', { priority: 'high' }), null, NOW).priority).toMatchObject({ label: 'High', tone: 'amber' });
    expect(todoCardModel(todo('a', { priority: 'low' }), null, NOW).priority.label).toBe('Low');
    expect(todoCardModel(todo('a', { priority: 'odd' as never }), null, NOW).priority.label).toBe('Medium');
  });

  it('says the status in words with its icon and colour: Open, In progress, Review, Done', () => {
    expect(todoCardModel(todo('a'), 'run', NOW).status).toEqual({ key: 'open', label: 'Open', icon: 'circle', tone: null });
    expect(todoCardModel(todo('a', { state: 'in_progress' }), 'run', NOW).status).toEqual({ key: 'progress', label: 'In progress', icon: 'dot', tone: 'blue' });
    // Its agent stopped: Review (derived, D102).
    expect(todoCardModel(todo('a', { state: 'in_progress' }), 'idle', NOW).status).toEqual({ key: 'review', label: 'Review', icon: 'half', tone: 'violet' });
    expect(todoCardModel(todo('a', { state: 'done', doneAt: '2026-10-26T11:00:00.000Z' }), 'idle', NOW).status).toEqual({ key: 'done', label: 'Done', icon: 'check-circle', tone: 'green' });
  });
});

describe('v2 task card · estimate vs actual', () => {
  it('an open item shows its estimate only', () => {
    const model = todoCardModel(todo('a', { estimateMinutes: 45 }), null, NOW);
    expect(model.estimate).toBe('est 45m');
    expect(model.over).toBe(false);
    expect(model.tokens).toBeNull();
  });

  it('an in-progress item counts the time so far and turns amber past its estimate', () => {
    const started = new Date(NOW - 30 * MIN).toISOString();
    const model = todoCardModel(todo('a', { state: 'in_progress', estimateMinutes: 20, startedAt: started }), 'run', NOW);
    expect(model.estimate).toBe('est 20m · 30m so far');
    expect(model.over).toBe(true);
    expect(todoCardModel(todo('a', { state: 'in_progress', estimateMinutes: 60, startedAt: started }), 'run', NOW).over).toBe(false);
  });

  it('a done item shows est vs took and its tokens (D78)', () => {
    const model = todoCardModel(todo('a', { state: 'done', estimateMinutes: 60, actualMs: 48 * MIN, actualTokens: 41_200 }), null, NOW);
    expect(model.estimate).toBe('est 1h · took 48m');
    expect(model.tokens).toBe('41k tokens');
    expect(todoCardModel(todo('a', { state: 'done', actualMs: 5 * MIN, actualTokens: null }), null, NOW).tokens).toBeNull();
    expect(todoCardModel(todo('a', { state: 'open', actualTokens: 900 }), null, NOW).tokens).toBeNull();
  });

  it('marks the plan only when there is a real one; details when a description or plan exists', () => {
    expect(todoCardModel(todo('a'), null, NOW)).toMatchObject({ hasPlan: false, hasDetails: false });
    expect(todoCardModel(todo('a', { plan: 'No plan: trivial' }), null, NOW).hasPlan).toBe(false);
    expect(todoCardModel(todo('a', { plan: 'Steps: edit acme.ts' }), null, NOW)).toMatchObject({ hasPlan: true, hasDetails: true });
    expect(todoCardModel(todo('a', { description: 'Why it matters' }), null, NOW)).toMatchObject({ hasPlan: false, hasDetails: true });
  });
});

describe('v2 task card · actions', () => {
  it('an open item: Start, Run, mark done, edit, mark in progress, delete', () => {
    expect(todoCardModel(todo('a'), null, NOW).actions).toEqual({ start: true, run: true, runWhy: null, check: 'done', edit: true, progress: 'in_progress', delete: true });
  });

  it('an in-progress item: Start again, Run, mark not started', () => {
    const actions = todoCardModel(todo('a', { state: 'in_progress' }), 'run', NOW).actions;
    expect(actions).toMatchObject({ start: true, run: true, check: 'done', progress: 'open' });
  });

  it('an item its own agent already works on: no second Run, with the reason', () => {
    const model = todoCardModel(todo('a', { state: 'in_progress', runSessionId: 's9', runState: 'active' }), 'run', NOW);
    expect(model.runActive).toBe(true);
    expect(model.actions.run).toBe(false);
    expect(model.actions.runWhy).toBe('An agent of its own already works on it');
  });

  it('a done item: reopen and delete only', () => {
    expect(todoCardModel(todo('a', { state: 'done' }), null, NOW).actions).toEqual({ start: false, run: false, runWhy: null, check: 'reopen', edit: false, progress: null, delete: true });
  });

  it('a captured item waits for its agent to fill it in until done', () => {
    expect(todoCardModel(todo('a', { needsEnrichment: true }), null, NOW).waitingFill).toBe(true);
    expect(todoCardModel(todo('a', { needsEnrichment: true, state: 'done' }), null, NOW).waitingFill).toBe(false);
  });
});

describe('v2 task strip', () => {
  it('orders in progress first, open by priority then position, done last (newest first)', () => {
    const list = [
      todo('done-old', { state: 'done', doneAt: '2026-10-26T09:00:00.000Z', position: 0 }),
      todo('low', { priority: 'low', position: 1 }),
      todo('urgent', { priority: 'urgent', position: 5 }),
      todo('med-2', { position: 3 }),
      todo('med-1', { position: 2 }),
      todo('doing', { state: 'in_progress', position: 9 }),
      todo('done-new', { state: 'done', doneAt: '2026-10-26T11:00:00.000Z', position: 4 }),
    ];
    expect(stripOrder(list).map((t) => t.id)).toEqual(['doing', 'urgent', 'med-1', 'med-2', 'low', 'done-new', 'done-old']);
  });

  it('is closed by default and remembers the choice per browser', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readStripOpen(storage)).toBe(false);
    writeStripOpen(storage, true);
    expect(store.get(TASK_STRIP_KEY)).toBe('1');
    expect(readStripOpen(storage)).toBe(true);
    writeStripOpen(storage, false);
    expect(readStripOpen(storage)).toBe(false);
    expect(readStripOpen(null)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error('private mode');
      },
    };
    expect(readStripOpen(broken)).toBe(false);
  });
});

describe('v2 task card · plan-item link (D99)', () => {
  function plan(extra: Partial<Plan>): Plan {
    return { id: 'p1', title: 'Acme checkout', sourceSessionId: 's1', machine: null, items: [], ...extra } as unknown as Plan;
  }

  it('links the item to the project step that works on it', () => {
    const plans = [plan({ items: [{ id: 'i1', todoId: 'a', key: 'PROJ-12', title: 'Empty cart' } as never] })];
    expect(todoPlanLink(plans, { id: 'a', sessionId: 's1' })).toEqual({ planId: 'p1', title: 'Acme checkout', step: 'PROJ-12 Empty cart', href: '/projects/p1' });
    expect(todoPlanLink(plans, { id: 'b', sessionId: 's1' })).toBeNull();
    // Item ids are per session: another agent's item "a" is not this plan's.
    expect(todoPlanLink(plans, { id: 'a', sessionId: 's2' })).toBeNull();
  });

  it('matches a paired computer’s plan by its own session ids', () => {
    const plans = [plan({ sourceSessionId: 'abc', machine: { id: 'acmepcabcdef', name: 'Acme-PC', state: 'online' }, items: [{ id: 'i1', todoId: 'a', key: null, title: 'Docs' } as never] })];
    expect(todoPlanLink(plans, { id: 'a', sessionId: 'r~acmepcabcdef~abc' })?.step).toBe('Docs');
    expect(todoPlanLink(plans, { id: 'a', sessionId: 'r~otherpcabcde~abc' })).toBeNull();
  });
});
