import { describe, expect, it } from 'vitest';
import { draftField, draftIsEmpty, isDraftField, parseDraftValue, rawDraftId } from '../../src/core/drafts.ts';
import { DraftField, type DraftFieldHost } from '../../src/web/drafts/draft-field.ts';

/**
 * D88 · the draft sync of one field (`src/web/drafts/draft-field.ts`) with fake
 * timers, focus and server: the debounce, saves on blur / hide / unmount, clear on
 * send, restore on load, and the conflict rule (last write wins; a field with focus
 * is never overwritten, the remote change waits for blur).
 */

interface Fake {
  readonly host: DraftFieldHost;
  value: { text: string; attachments: [] };
  focus: boolean;
  server: unknown | null;
  readonly applied: Array<unknown | null>;
  readonly writes: Array<{ value: unknown | null; keepalive: boolean }>;
  /** Runs the pending debounce timer. */
  tick(): void;
  pendingTimer(): boolean;
}

function fake(field = 'composer'): Fake {
  let timer: (() => void) | null = null;
  const state: Fake = {
    value: { text: '', attachments: [] },
    focus: false,
    server: null,
    applied: [],
    writes: [],
    host: undefined as unknown as DraftFieldHost,
    tick: () => {
      const run = timer;
      timer = null;
      run?.();
    },
    pendingTimer: () => timer !== null,
  };
  (state as { host: DraftFieldHost }).host = {
    field,
    value: () => state.value,
    apply: (value) => {
      state.applied.push(value);
      state.value = value === null ? { text: '', attachments: [] } : (value as Fake['value']);
    },
    focused: () => state.focus,
    write: async (value, keepalive) => {
      state.writes.push({ value, keepalive });
      state.server = value;
    },
    read: async () => state.server,
    setTimer: (run) => {
      timer = run;
      return 1;
    },
    clearTimer: () => {
      timer = null;
    },
  };
  return state;
}

const text = (t: string) => ({ text: t, attachments: [] as [] });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('field keys and values (src/core/drafts.ts)', () => {
  it('names fields with the session machine\'s own ids; validates and normalizes values; knows empty', () => {
    expect(draftField.question('r~abcdefghijkl~b1')).toBe('question:b1');
    expect(draftField.review('rev-1')).toBe('review:rev-1');
    expect(draftField.todoEdit('r~abcdefghijkl~t9')).toBe('todo-edit:t9');
    expect(rawDraftId('plain')).toBe('plain');
    expect(['composer', 'todo-add', 'question:b1', 'review:x.y_z-1', 'todo-edit:t'].every(isDraftField)).toBe(true);
    expect(['', 'composer:1', 'question:', 'question:r~m~b', 'other', 'todo-edit:a/b'].some(isDraftField)).toBe(false);

    expect(parseDraftValue('composer', { text: 'hi', extra: 1 })).toEqual({ text: 'hi', attachments: [] });
    expect(parseDraftValue('todo-add', { title: 't', priority: 'nonsense' })).toEqual({ title: 't', description: '', plan: '', priority: 'medium', estimate: '' });
    expect(parseDraftValue('question:b', { picks: { q: { text: 'x' } } })).toEqual({ picks: { q: { text: 'x', editing: false } } });
    expect(parseDraftValue('review:r', { comment: 5 })).toBeNull();

    expect(draftIsEmpty('composer', text('  \n'))).toBe(true);
    expect(draftIsEmpty('composer', { text: '', attachments: [{ id: 'a', name: 'n', size: 1, kind: 'file' }] })).toBe(false);
    expect(draftIsEmpty('question:b', { picks: {} })).toBe(true);
    expect(draftIsEmpty('todo-add', { title: '', description: '', plan: 'No plan', priority: 'medium', estimate: '' })).toBe(true);
    expect(draftIsEmpty('todo-add', { title: '', description: '', plan: 'No plan', priority: 'high', estimate: '' })).toBe(false);
    expect(draftIsEmpty('todo-edit:t', { title: '', description: '', plan: '', priority: 'medium', estimate: '' })).toBe(false);
  });
});

describe('DraftField (D88)', () => {
  it('saves 400 ms after the last change, once; an emptied field clears the draft', async () => {
    const f = fake();
    const sync = new DraftField(f.host);
    f.value = text('h');
    sync.changed();
    f.value = text('hello');
    sync.changed();
    expect(f.writes).toEqual([]);
    f.tick();
    await flush();
    expect(f.writes).toEqual([{ value: text('hello'), keepalive: false }]);
    // Nothing new: no second save.
    sync.changed();
    expect(f.pendingTimer()).toBe(false);
    f.value = text('');
    sync.changed();
    f.tick();
    await flush();
    expect(f.writes.at(-1)).toEqual({ value: null, keepalive: false });
  });

  it('saves at once on blur and on leaving (keepalive), not twice', async () => {
    const f = fake();
    const sync = new DraftField(f.host);
    f.value = text('typed');
    sync.changed();
    await sync.blurred();
    expect(f.writes).toEqual([{ value: text('typed'), keepalive: false }]);
    expect(f.pendingTimer()).toBe(false);
    f.value = text('typed more');
    sync.changed();
    sync.dispose();
    await flush();
    expect(f.writes.at(-1)).toEqual({ value: text('typed more'), keepalive: true });
    // Disposed: nothing more.
    f.value = text('late');
    sync.changed();
    expect(f.pendingTimer()).toBe(false);
  });

  it('restores the server value when the field still shows what it started with; typing first wins', async () => {
    const restored = fake();
    new DraftField(restored.host).loaded(text('from the server'));
    expect(restored.applied).toEqual([text('from the server')]);

    const typed = fake();
    const sync = new DraftField(typed.host);
    typed.value = text('typed before the read');
    sync.loaded(text('from the server'));
    expect(typed.applied).toEqual([]);
    sync.changed();
    typed.tick();
    await flush();
    expect(typed.writes).toEqual([{ value: text('typed before the read'), keepalive: false }]);
  });

  it('clear (sent): the draft goes and the sent text is never saved again, even on leaving', async () => {
    const f = fake();
    const sync = new DraftField(f.host, text('draft'));
    f.value = text('draft to send');
    sync.changed();
    await sync.clear();
    expect(f.writes).toEqual([{ value: null, keepalive: false }]);
    expect(f.pendingTimer()).toBe(false);
    sync.dispose();
    await flush();
    expect(f.writes).toHaveLength(1);
    // Typing after the send is a new draft.
    const next = fake();
    const again = new DraftField(next.host);
    next.value = text('sent');
    await again.clear();
    next.value = text('sent and more');
    again.changed();
    next.tick();
    await flush();
    expect(next.writes.at(-1)).toEqual({ value: text('sent and more'), keepalive: false });
  });

  it('a remote change shows at once when the field has no focus (and a remote clear empties it)', () => {
    const f = fake();
    const sync = new DraftField(f.host);
    sync.remote(text('from my phone'));
    expect(f.value).toEqual(text('from my phone'));
    sync.remote(null);
    expect(f.value).toEqual(text(''));
    expect(f.applied).toEqual([text('from my phone'), null]);
  });

  it('the focus rule: a remote change never overwrites the field being typed in; it waits for blur', async () => {
    // Typing on A while B saves: A keeps its text and, on blur, saves it (last write wins).
    const a = fake();
    const syncA = new DraftField(a.host);
    a.focus = true;
    a.value = text('A is typing');
    syncA.changed();
    a.server = text('B wrote this');
    syncA.remote(text('B wrote this'));
    expect(a.applied).toEqual([]);
    a.focus = false;
    await syncA.blurred();
    expect(a.value).toEqual(text('A is typing'));
    expect(a.writes.at(-1)).toEqual({ value: text('A is typing'), keepalive: false });

    // Focused but nothing new typed: B's change is applied once the field loses focus (read again then).
    const c = fake();
    const syncC = new DraftField(c.host, text('same'));
    c.value = text('same');
    c.focus = true;
    syncC.remote(text('B 1'));
    c.server = text('B 2');
    expect(c.applied).toEqual([]);
    c.focus = false;
    await syncC.blurred();
    expect(c.applied).toEqual([text('B 2')]);
    expect(c.writes).toEqual([]);
  });
});
