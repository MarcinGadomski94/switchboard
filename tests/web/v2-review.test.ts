import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../src/core/api.ts';
import { NEEDS_FILTER_OF, NEEDS_KIND_LOOK, STATUS } from '../../src/web/v2/glossary.ts';
import { agentLine, agentStatusOf } from '../../src/web/v2/shared/agent-line.ts';
import { cardButtons, isLinkAction, openTargetOf } from '../../src/web/v2/shared/answer-model.ts';
import { fromInbox, inboxKindOf } from '../../src/web/v2/shared/needs-you-model.ts';

/**
 * D166 (`docs/inbox.md` → *To review*): the green "To review" card (its kind, Mark reviewed first,
 * Open changes a link to the Changes tab), and the agent's own status: To review (green) once its
 * turn is over, never while it works.
 */

const ITEM: InboxItem = {
  id: 'item-r',
  kind: 'system',
  systemKind: 'review',
  sessionId: 's1',
  source: 'Checkout fix',
  status: 'need',
  title: 'Review: Checkout fix · 3 files changed',
  label: 'To review',
  detail: 'Its last turn changed 3 files: a.ts, b.ts, c.ts. Review the changes, then Mark reviewed (or reply to the agent).',
  createdAt: '2026-11-16T10:00:00.000Z',
  branches: [],
  actions: [
    { id: 'open-changes', label: 'Open changes' },
    { id: 'mark-reviewed', label: 'Mark reviewed' },
  ],
} as InboxItem;

const REVIEW = { since: '2026-11-16T10:00:00.000Z', turns: 1, fileCount: 3, files: ['/w/a.ts', '/w/b.ts', '/w/c.ts'] };

describe('D166 · the To review card', () => {
  it('is its own green kind, in its own filter group', () => {
    expect(inboxKindOf(ITEM)).toBe('review');
    expect(NEEDS_KIND_LOOK.review).toMatchObject({ label: 'To review', status: 'review' });
    expect(STATUS.review).toMatchObject({ label: 'To review', tone: 'green' });
    expect(NEEDS_FILTER_OF.review).toBe('review');
    // An older server without systemKind: the action says it.
    expect(inboxKindOf({ ...ITEM, systemKind: undefined } as InboxItem)).toBe('review');
  });

  it('Mark reviewed is the main action; Open changes opens the agent’s Changes (the card stays)', () => {
    const item = fromInbox(ITEM);
    expect(isLinkAction('open-changes')).toBe(true);
    expect(openTargetOf(item, 'open-changes')).toEqual({ type: 'agent', sessionId: 's1', tab: 'changes' });
    expect(cardButtons(item).map((button) => [button.id, button.variant, button.intent.type])).toEqual([
      ['mark-reviewed', 'primary', 'answer'],
      ['open-changes', 'default', 'open'],
    ]);
  });
});

describe('D166 · the agent’s status', () => {
  it('a finished agent with changes not reviewed reads To review; while it works, Working; reviewed, Done', () => {
    expect(agentStatusOf({ status: 'done', turnWait: null, review: REVIEW })).toBe('review');
    expect(agentStatusOf({ status: 'idle', turnWait: null, review: REVIEW })).toBe('review');
    expect(agentStatusOf({ status: 'run', turnWait: null, review: REVIEW })).toBe('working');
    expect(agentStatusOf({ status: 'done', turnWait: null })).toBe('done');
    // A question still wins: it needs you first.
    expect(agentStatusOf({ status: 'done', turnWait: null, review: REVIEW }, { ask: 'Which one?' })).toBe('needs');
  });

  it('its one-line activity says so, green', () => {
    expect(agentLine({ status: 'done', turnWait: null, review: REVIEW, lastActivityAt: null } as never, null).text).toMatch(/^To review/);
    expect(agentLine({ status: 'done', turnWait: null, review: REVIEW, lastActivityAt: null } as never, null).tone).toBe('green');
  });
});
