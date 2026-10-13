/** D99-Jira · the pure rules (`src/core/plans-jira.ts`) and the lane's route classification (D73 devices, D48 peers). */
import { describe, expect, it } from 'vitest';
import { adfToText, findTransition, jiraDrift, jiraItemTodo, normalizeJiraBaseUrl, parseEpicKey, splitAcceptanceCriteria } from '../../src/core/plans-jira.ts';
import { peerAnswerKind } from '../../src/core/peer-wire.ts';
import { TODO_DESCRIPTION_MAX } from '../../src/core/todos.ts';
import { DEVICE_ALLOWED, DEVICE_REFUSED, matchesRule } from '../../src/server/devices/local-only.ts';
import { PEER_API_ALLOW } from '../../src/server/peers/service.ts';
import { PLAN_JIRA_ROUTES } from '../../src/server/plans/jira/routes.ts';

describe('D99-Jira · parsing', () => {
  it('finds the epic key in a key or a link', () => {
    expect(parseEpicKey('PROJ-10')).toBe('PROJ-10');
    expect(parseEpicKey(' proj-10 ')).toBe('PROJ-10');
    expect(parseEpicKey('https://acme.atlassian.net/browse/PROJ-10')).toBe('PROJ-10');
    expect(parseEpicKey('https://acme.atlassian.net/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-12')).toBe('PROJ-12');
    expect(parseEpicKey('no key')).toBeNull();
    expect(parseEpicKey(42)).toBeNull();
  });

  it('accepts an https site, or http on loopback only', () => {
    expect(normalizeJiraBaseUrl('https://acme.atlassian.net/jira/your-work')).toBe('https://acme.atlassian.net');
    expect(normalizeJiraBaseUrl('http://127.0.0.1:4911')).toBe('http://127.0.0.1:4911');
    expect(normalizeJiraBaseUrl('http://acme.atlassian.net')).toBeNull();
    expect(normalizeJiraBaseUrl('https://user:pw@acme.atlassian.net')).toBeNull();
    expect(normalizeJiraBaseUrl('acme')).toBeNull();
  });

  it('reads ADF and a plain-text acceptance-criteria section', () => {
    expect(adfToText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] }, { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] }] })).toBe('a\nb\n\n1. one');
    expect(splitAcceptanceCriteria('Do it.\nAcceptance criteria:\n- works')).toEqual({ text: 'Do it.', acceptance: '- works' });
    expect(splitAcceptanceCriteria('Just text')).toEqual({ text: 'Just text', acceptance: null });
  });

  it('builds the todo within its limits, acceptance criteria kept', () => {
    const todo = jiraItemTodo({ key: 'PROJ-1', summary: 'S'.repeat(200), description: 'x'.repeat(10_000), acceptanceCriteria: '- AC', acceptanceSource: 'field', components: ['acme-front'], status: 'To Do', assignee: null, estimateMinutes: null, url: 'https://acme.atlassian.net/browse/PROJ-1', unlinked: true });
    expect(todo.title.length).toBeLessThanOrEqual(120);
    expect(todo.description.length).toBeLessThanOrEqual(TODO_DESCRIPTION_MAX);
    expect(todo.description).toContain('Acceptance criteria:\n- AC');
    expect(todo.description).toContain('Jira: https://acme.atlassian.net/browse/PROJ-1 · components acme-front');
  });
});

describe('D99-Jira · sync rules', () => {
  it('resolves a transition by its name or its target status', () => {
    const list = [{ id: '1', name: 'Start progress', to: 'In Progress' }, { id: '2', name: 'Review', to: 'In Review' }];
    expect(findTransition(list, 'in progress')?.id).toBe('1');
    expect(findTransition(list, 'Review')?.id).toBe('2');
    expect(findTransition(list, 'Done')).toBeNull();
  });

  it('notes a drift', () => {
    expect(jiraDrift({ itemState: 'running', status: 'Done', statusCategory: 'done', statusAtImport: 'To Do' })).toBe('Jira says Done; the plan item is running');
    expect(jiraDrift({ itemState: 'running', status: 'To Do', statusCategory: 'new', statusAtImport: 'To Do' })).toBe("Jira still says To Do while the item's run works");
    expect(jiraDrift({ itemState: 'waiting', status: 'To Do', statusCategory: 'new', statusAtImport: 'To Do' })).toBeNull();
    expect(jiraDrift({ itemState: 'done', status: 'Done', statusCategory: 'done', statusAtImport: 'In Review' })).toBe('Jira status changed: In Review → Done');
  });
});

describe('D99-Jira · route classification', () => {
  const sample = (url: string) => url.replace(/:[^/]+/g, 'x1');
  it('phones may preview, import and follow a plan; the credentials stay on this computer', () => {
    for (const [method, url] of PLAN_JIRA_ROUTES) {
      const local = url.startsWith('/api/integrations/');
      expect([method, url, matchesRule(DEVICE_ALLOWED, method, sample(url)), matchesRule(DEVICE_REFUSED, method, sample(url))]).toEqual([method, url, !local, local]);
    }
  });

  it('a paired machine may call the import and sync routes, never the credentials', () => {
    for (const [method, url] of PLAN_JIRA_ROUTES) {
      const allowed = PEER_API_ALLOW.some(([verb, pattern]) => verb === method && pattern.test(sample(url)));
      expect([method, url, allowed]).toEqual([method, url, !url.startsWith('/api/integrations/')]);
    }
  });

  it("maps a forwarded import's plan; leaves a plan's Jira state raw", () => {
    expect(peerAnswerKind('POST', '/api/sessions/s1/plans/jira/import')).toBe('plan-item');
    expect(peerAnswerKind('GET', '/api/plans/p1/jira')).toBe('none');
    expect(peerAnswerKind('POST', '/api/plans/p1/jira/refresh')).toBe('none');
  });
});
