import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionContext } from '../../src/core/api.ts';
import { EMPTY_CONTEXT, reduceContext, resolveContext } from '../../src/core/context-meter.ts';
import { formatClockTime } from '../../src/web/activity/activity.ts';
import { CONTEXT_UNKNOWN_TEXT, contextBarView } from '../../src/web/views/session/context-bar.ts';

/** D49: the context bar's copy, colors and tooltip (`docs/chat.md` → *Context bar*). */

/** The component module, imported at run time (the server tsconfig has no JSX; Vitest transforms it). */
const CHAT_TAB = '../../src/web/views/session/ChatTab.tsx';

const AT = '2026-09-29T12:05:00.000Z';
const at = formatClockTime(AT);

function context(tokens: number | null, window = 200_000, extra: Partial<SessionContext> = {}): SessionContext {
  const percent = tokens === null ? null : Math.round((tokens / window) * 100);
  const band = percent === null ? 'unknown' : percent >= 80 ? 'high' : percent >= 60 ? 'warn' : 'ok';
  return { tokens, window, windowSource: 'reported', model: 'claude-opus-4-7', percent, band, updatedAt: AT, compaction: null, compactedRecently: false, ...extra };
}

describe('contextBarView', () => {
  it('the ruling\'s text: Context 62% · 124k / 200k; 1M windows read 1M', () => {
    expect(contextBarView(context(124_000))).toMatchObject({ text: 'Context 62% · 124k / 200k', band: 'warn', fill: 62, compacted: null });
    expect(contextBarView(context(820_000, 1_000_000))).toMatchObject({ text: 'Context 82% · 820k / 1M', band: 'high' });
    expect(contextBarView(context(47_780))).toMatchObject({ text: 'Context 24% · 47k / 200k', band: 'ok' });
  });

  it('unknown: an empty neutral bar, "Context —"', () => {
    expect(contextBarView(context(null))).toMatchObject({ text: CONTEXT_UNKNOWN_TEXT, band: 'unknown', fill: 0 });
    expect(CONTEXT_UNKNOWN_TEXT).toBe('Context —');
  });

  it('bands at the thresholds: 59 green, 60 yellow, 79 yellow, 80 red', () => {
    expect([118_000, 120_000, 158_000, 160_000].map((t) => contextBarView(context(t)).band)).toEqual(['ok', 'warn', 'warn', 'high']);
  });

  it('after a compaction: "compacted HH:MM" beside the text until the next turn; the tooltip keeps it', () => {
    const compaction = { at: AT, trigger: 'auto', preTokens: 167_000, postTokens: 18_000 };
    const recent = contextBarView(context(18_000, 200_000, { compaction, compactedRecently: true }));
    expect(recent.compacted).toBe(`compacted ${at}`);
    expect(recent.tooltip).toBe(`Context window: 200,000 tokens · claude-opus-4-7\nLast compacted: ${at} (auto)`);
    const later = contextBarView(context(30_000, 200_000, { compaction, compactedRecently: false }));
    expect(later.compacted).toBeNull();
    expect(later.tooltip).toContain(`Last compacted: ${at} (auto)`);
  });

  it('the tooltip without a compaction or a model', () => {
    expect(contextBarView(context(null, 1_000_000, { model: null })).tooltip).toBe('Context window: 1,000,000 tokens\nNot compacted yet');
  });

  it('from the core: a compaction resets the bar to its post-compaction size', () => {
    const state = [
      { kind: 'usage', model: 'claude-opus-4-7', usage: { input_tokens: 3, cache_read_input_tokens: 170_000, cache_creation_input_tokens: 0 }, at: AT },
      { kind: 'compact', trigger: 'manual', preTokens: 170_003, postTokens: 20_000, at: AT },
    ].reduce((s, input) => reduceContext(s, input as Parameters<typeof reduceContext>[1]), EMPTY_CONTEXT);
    expect(contextBarView(resolveContext(state, null))).toMatchObject({ text: 'Context 10% · 20k / 200k', band: 'ok', compacted: `compacted ${at}` });
  });
});

describe('ContextBar (markup)', () => {
  it('a meter with its value, the band as data, the fill width and the tooltip', async () => {
    const { ContextBar } = (await import(/* @vite-ignore */ CHAT_TAB)) as { ContextBar: (props: { context: SessionContext }) => null };
    const html = renderToStaticMarkup(createElement(ContextBar, { context: context(124_000) }));
    expect(html).toContain('data-testid="chat-context"');
    expect(html).toContain('data-band="warn"');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="62"');
    expect(html).toContain('width:62%');
    expect(html).toContain('Context 62% · 124k / 200k');
    expect(html).toContain('title="Context window: 200,000 tokens · claude-opus-4-7\nNot compacted yet"');
    expect(html).not.toContain('chat-context-compacted');
  });
});
