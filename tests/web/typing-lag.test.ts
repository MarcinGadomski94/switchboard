import { describe, expect, it } from 'vitest';
import { keepIdentity, samePlain } from '../../src/web/views/session/keep-identity.ts';
import { type ComposerMeasure, composerMayShrink, lineBreaks } from '../../src/web/v2/agent/composer-model.ts';
import { chatRows, defaultClock, defaultGapText } from '../../src/web/v2/agent/chat-model.ts';
import type { ChatItem } from '../../src/web/views/session/chat.ts';

/** Typing lag fix (2026-10-29, `docs/performance.md` → *Typing in a long chat*): the pure parts. */

describe('samePlain', () => {
  it('compares plain values field by field', () => {
    expect(samePlain(1, 1)).toBe(true);
    expect(samePlain('a', 'a')).toBe(true);
    expect(samePlain(null, null)).toBe(true);
    expect(samePlain(Number.NaN, Number.NaN)).toBe(true);
    expect(samePlain({ a: 1, b: [1, { c: 'x' }] }, { a: 1, b: [1, { c: 'x' }] })).toBe(true);
    expect(samePlain({ a: 1, b: [1, { c: 'x' }] }, { a: 1, b: [1, { c: 'y' }] })).toBe(false);
    expect(samePlain({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(samePlain({ a: undefined }, { b: undefined })).toBe(false);
    expect(samePlain([1, 2], [1, 2, 3])).toBe(false);
    expect(samePlain([], {})).toBe(false);
    expect(samePlain(null, {})).toBe(false);
    expect(samePlain(1, '1')).toBe(false);
  });

  it('counts other objects equal only when they are the same object', () => {
    const map = new Map([[1, 2]]);
    expect(samePlain(map, map)).toBe(true);
    expect(samePlain(new Map([[1, 2]]), new Map([[1, 2]]))).toBe(false);
    expect(samePlain(new Date(5), new Date(5))).toBe(false);
    const fn = (): number => 1;
    expect(samePlain({ fn }, { fn })).toBe(true);
    expect(samePlain({ fn }, { fn: (): number => 1 })).toBe(false);
  });
});

describe('keepIdentity', () => {
  const row = (key: string, text: string) => ({ key, text, parts: [text] });

  it('answers the previous array when nothing changed', () => {
    const previous = [row('a', '1'), row('b', '2')];
    expect(keepIdentity(previous, [row('a', '1'), row('b', '2')])).toBe(previous);
  });

  it('keeps the unchanged items and takes the changed and new ones', () => {
    const previous = [row('a', '1'), row('b', '2')];
    const next = keepIdentity(previous, [row('a', '1'), row('b', '2!'), row('c', '3')]);
    expect(next).not.toBe(previous);
    expect(next[0]).toBe(previous[0]);
    expect(next[1]).not.toBe(previous[1]);
    expect(next[1]).toEqual(row('b', '2!'));
    expect(next[2]).toEqual(row('c', '3'));
  });

  it('follows the order and length of the new build', () => {
    const previous = [row('a', '1'), row('b', '2'), row('c', '3')];
    const reordered = keepIdentity(previous, [row('b', '2'), row('a', '1')]);
    expect(reordered).toEqual([row('b', '2'), row('a', '1')]);
    expect(reordered[0]).toBe(previous[1]);
    expect(reordered[1]).toBe(previous[0]);
    // An item removed from the end: a new array.
    expect(keepIdentity(previous, previous.slice(0, 2))).not.toBe(previous);
  });

  it('starts from the new build without a previous one', () => {
    const next = [row('a', '1')];
    expect(keepIdentity(null, next)).toBe(next);
    expect(keepIdentity([], next)).toBe(next);
  });

  it('keeps the chat rows of an unchanged history when an event is appended', () => {
    const items = (n: number): ChatItem[] =>
      Array.from({ length: n }, (_, i) => ({ kind: 'user', key: `u${i}`, id: i + 1, text: `message ${i}`, origin: 'user', delivered: true, queued: null, attachments: [], cut: null }) as ChatItem);
    const times = new Map(Array.from({ length: 11 }, (_, i) => [i + 1, { ts: new Date(Date.UTC(2026, 9, 29, 9, i)).toISOString(), endTs: null }]));
    const build = (n: number) => chatRows({ items: items(n), times, agents: [], now: Date.UTC(2026, 9, 29, 10), clock: (iso) => iso.slice(11, 16) });
    const before = build(10);
    const after = keepIdentity(before, build(11));
    expect(after).toHaveLength(11);
    for (let i = 0; i < 10; i += 1) expect(after[i]).toBe(before[i]);
  });
});

describe('composer autosize (v2)', () => {
  const at = (length: number, breaks = 0, max = 200, viewHeight = 900): ComposerMeasure => ({ length, breaks, viewHeight, share: 0.22, max });

  it('collapses the field only when it may have shrunk', () => {
    expect(composerMayShrink(null, at(0))).toBe(true);
    // Typing adds text: no collapse.
    expect(composerMayShrink(at(3), at(4))).toBe(false);
    expect(composerMayShrink(at(3, 0), at(4, 1))).toBe(false);
    // Deleting, losing a line break, emptying, or a new cap: collapse.
    expect(composerMayShrink(at(4), at(3))).toBe(true);
    expect(composerMayShrink(at(10, 2), at(10, 1))).toBe(true);
    expect(composerMayShrink(at(10), at(0))).toBe(true);
    expect(composerMayShrink(at(10, 0, 200), at(11, 0, 180))).toBe(true);
  });

  it('counts line breaks', () => {
    expect(lineBreaks('')).toBe(0);
    expect(lineBreaks('one line')).toBe(0);
    expect(lineBreaks('a\nb\n\nc')).toBe(3);
  });
});

describe('the chat clock (made once)', () => {
  it('formats as toLocaleTimeString / toLocaleDateString did', () => {
    const iso = '2026-10-23T09:10:00.000Z';
    expect(defaultClock(iso)).toBe(new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    expect(defaultClock('not a date')).toBe('');
    const from = Date.parse('2026-10-22T18:00:00.000Z');
    const to = Date.parse('2026-10-23T09:10:00.000Z');
    const time = new Date(to).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const sameDay = new Date(from).toDateString() === new Date(to).toDateString();
    expect(defaultGapText(from, to)).toBe(sameDay ? `${Math.round((to - from) / 3_600_000)} hours later · ${time}` : `${new Date(to).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })} · ${time}`);
  });
});
