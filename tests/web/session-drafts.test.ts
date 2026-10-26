import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDraft } from '../../src/core/drafts.ts';

/** What the fake server holds, and the reads it is answering (each resolved by the test). */
const server = { drafts: [] as SessionDraft[], reads: [] as Array<() => void> };

vi.mock('../../src/web/api/client.ts', () => ({
  api: {
    sessionDrafts: () =>
      new Promise<SessionDraft[]>((resolve) => {
        // The answer is what the server holds when the read reaches it (now).
        const answer = server.drafts.map((draft) => ({ ...draft }));
        server.reads.push(() => resolve(answer));
      }),
    machineDrafts: async () => [],
  },
}));

const { knownDraft, readDrafts, resetDraftCache, trackDraftWrite } = await import('../../src/web/drafts/session-drafts.ts');
const { DraftField } = await import('../../src/web/drafts/draft-field.ts');

function composer(text: string): SessionDraft {
  return { field: 'composer', value: { text, attachments: [] }, updatedAt: '2026-10-26T10:00:00.000Z' } as SessionDraft;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/**
 * Fix after 2.0 · v2 drafts: the page's draft cache never lets a read answer the
 * server's value from before this page's own save (coming back to an agent while the
 * save made on the way out still travels showed the older, often empty, draft).
 */
describe('session drafts: reads wait for this page\'s saves (fix after 2.0)', () => {
  beforeEach(() => {
    resetDraftCache();
    server.drafts = [];
    server.reads = [];
  });

  it('remembers a save at once, and a read waits until the save is over', async () => {
    let finish: () => void = () => undefined;
    const save = new Promise<void>((resolve) => (finish = resolve));
    trackDraftWrite('s1', 'composer', { text: 'on its way', attachments: [] }, save);
    expect(knownDraft('s1', 'composer')).toEqual({ text: 'on its way', attachments: [] });

    const read = readDrafts('s1');
    await settle();
    expect(server.reads).toHaveLength(0); // not sent before the save lands
    server.drafts = [composer('on its way')];
    finish();
    await settle();
    expect(server.reads).toHaveLength(1);
    server.reads[0]?.();
    expect((await read).get('composer')).toEqual({ text: 'on its way', attachments: [] });
  });

  it('a read that ran while a save started is read again (its answer may predate the save)', async () => {
    const read = readDrafts('s1');
    await settle();
    expect(server.reads).toHaveLength(1);
    let finish: () => void = () => undefined;
    trackDraftWrite('s1', 'composer', { text: 'typed', attachments: [] }, new Promise<void>((resolve) => (finish = resolve)));
    server.reads[0]?.(); // the old answer: no draft
    await settle();
    expect(knownDraft('s1', 'composer')).toEqual({ text: 'typed', attachments: [] });
    server.drafts = [composer('typed')];
    finish();
    await settle();
    expect(server.reads).toHaveLength(2);
    server.reads[1]?.();
    expect((await read).get('composer')).toEqual({ text: 'typed', attachments: [] });
  });

  it('a failed save does not hold reads', async () => {
    trackDraftWrite('s1', 'composer', null, Promise.reject(new Error('offline')));
    const read = readDrafts('s1');
    await settle();
    expect(server.reads).toHaveLength(1);
    server.reads[0]?.();
    expect((await read).has('composer')).toBe(false);
  });

  it('DraftField reports each save at once, before the write (which waits for the one before it)', async () => {
    const saving: Array<unknown> = [];
    const writes: Array<unknown> = [];
    let value: unknown = { text: '', attachments: [] };
    const field = new DraftField({
      field: 'composer',
      value: () => value,
      apply: () => undefined,
      focused: () => false,
      write: async (next) => {
        writes.push(next);
      },
      read: async () => null,
      saving: (next) => saving.push(next),
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    value = { text: 'leaving', attachments: [] };
    field.dispose(); // unmount: flushed with keepalive
    expect(saving).toEqual([{ text: 'leaving', attachments: [] }]);
    expect(writes).toEqual([]);
    await settle();
    expect(writes).toEqual([{ text: 'leaving', attachments: [] }]);
  });
});
