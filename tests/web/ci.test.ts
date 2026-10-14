import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../src/core/api.ts';
import { canPreview, emptyImportForm, importLabel, importQuery, importable, importedText } from '../../src/web/ci/import-issues.ts';
import { openRoute, openUrl } from '../../src/web/views/inbox.ts';

/** D109: the Import issues dialog's rules and the Inbox's links of the PR watcher's items. */
describe('D109 · web', () => {
  it('the import form makes the query: GitHub filters, a Jira project key or JQL', () => {
    const form = emptyImportForm(['acme/web-front', 'acme/api']);
    expect(form).toEqual({ source: 'github', repo: 'acme/web-front', label: '', mine: false, jira: '' });
    expect(importQuery({ ...form, label: ' bug ', mine: true })).toEqual({ source: 'github', repo: 'acme/web-front', label: 'bug', mine: true });
    expect(importQuery({ ...form, source: 'jira', jira: 'proj' })).toEqual({ source: 'jira', jql: null, project: 'PROJ' });
    expect(importQuery({ ...form, source: 'jira', jira: 'assignee = currentUser()' })).toEqual({ source: 'jira', jql: 'assignee = currentUser()', project: null });
    expect(canPreview({ ...form, repo: 'not a repo' })).toBe(false);
    expect(canPreview({ ...form, source: 'jira', jira: '  ' })).toBe(false);
    const issues = [{ key: 'a#1', title: 'one', url: null, body: null, labels: [], imported: true }, { key: 'a#2', title: 'two', url: null, body: null, labels: [], imported: false }];
    expect(importable(issues).map((issue) => issue.key)).toEqual(['a#2']);
    expect(importLabel(1)).toBe('Import 1 issue');
    expect(importLabel(3)).toBe('Import 3 issues');
    expect(importedText(2, 'checkout')).toBe('2 issues added to the todos of checkout');
  });

  it('Open session and Open PR are links (the item stays open); other actions go to the server', () => {
    const item = { id: 'i', kind: 'system', sessionId: 'r~abc~s1', source: 'ci', status: 'need', title: 'PR #7 ready to merge', label: 'Ready to merge', detail: '', createdAt: '', branches: [], url: 'https://github.com/acme/web-front/pull/7' } as unknown as InboxItem;
    expect(openRoute(item, 'open-session')).toBe('/sessions/r~abc~s1');
    expect(openUrl(item, 'open-pr')).toBe('https://github.com/acme/web-front/pull/7');
    expect(openUrl({ ...item, url: 'javascript:alert(1)' } as InboxItem, 'open-pr')).toBeNull();
    expect(openRoute(item, 'merge-pr')).toBeNull();
    expect(openUrl(item, 'merge-pr')).toBeNull();
  });
});
