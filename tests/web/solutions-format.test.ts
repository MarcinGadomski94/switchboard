import { describe, expect, it } from 'vitest';
import type { Solution, SolutionGroup } from '../../src/core/api.ts';
import { createDemoProviders } from '../../src/server/demo/providers.ts';
import { loadDemoData } from '../../src/server/demo/data.ts';
import {
  artifactRows,
  branchOwnerLabel,
  codebaseMemoryToolId,
  filterGroups,
  freshnessLine,
  headerCounts,
  headerMeta,
  ledgerRows,
  parentPath,
  workspaceRootOf,
  worktreeLabel,
  worktreeLine,
} from '../../src/web/views/solutions-format.ts';

function solution(overrides: Partial<Solution>): Solution {
  return {
    name: 'x',
    path: '/ws/x',
    relativePath: 'x',
    type: 'Web',
    status: 'idle',
    rule: 'editable',
    phase: '—',
    changes: '—',
    flag: '',
    conflict: false,
    conflictSessions: [],
    branches: [],
    ledger: null,
    artifacts: [],
    codebaseMemory: 'fresh',
    ...overrides,
  };
}

const GROUPS: SolutionGroup[] = [
  {
    folder: 'microfrontends/',
    note: '',
    rule: 'editable',
    solutions: [solution({ name: 'web-front', path: '/ws/microfrontends/web-front', relativePath: 'microfrontends/web-front', status: 'run' })],
  },
  { folder: 'mobile/', note: '', rule: 'editable', solutions: [solution({ name: 'mobile', path: '/ws/mobile', relativePath: 'mobile', type: 'Mobile' })] },
  {
    folder: 'other/',
    note: 'on request only',
    rule: 'on-request',
    solutions: [solution({ name: 'tool', path: '/ws/other/tool', relativePath: 'other/tool', type: 'Other', rule: 'on-request', status: 'need' })],
  },
  {
    folder: 'read-only',
    note: 'deprecated/ · never edited',
    rule: 'read-only',
    solutions: [solution({ name: 'old', path: '/ws/deprecated/microfrontends/old', relativePath: 'deprecated/microfrontends/old', type: 'Read-only', rule: 'read-only' })],
  },
];

describe('Solutions view logic (M6.2)', () => {
  it('filter pills keep the groups with matching rows; other/ shows under All only (gap #15)', () => {
    expect(filterGroups(GROUPS, 'All').map((g) => g.folder)).toEqual(['microfrontends/', 'mobile/', 'other/', 'read-only']);
    expect(filterGroups(GROUPS, 'Web').map((g) => g.solutions.map((s) => s.name))).toEqual([['web-front']]);
    expect(filterGroups(GROUPS, 'Read-only').map((g) => g.folder)).toEqual(['read-only']);
    expect(filterGroups(GROUPS, 'Backend')).toEqual([]);
  });

  it('header meta: root · n solutions · n active', () => {
    expect(headerMeta(GROUPS)).toBe('/ws · 4 solutions · 2 active');
    expect(headerMeta([])).toBe('');
    // D14: the counts after the folder switcher.
    expect(headerCounts(GROUPS)).toBe('4 solutions · 2 active');
    expect(headerMeta([{ ...GROUPS[1]!, solutions: [solution({ path: 'D:\\acme\\mobile', relativePath: 'mobile' })] }])).toBe(
      'D:\\acme · 1 solution · 0 active',
    );
  });

  it('workspace root from a solution path in either OS form', () => {
    expect(workspaceRootOf({ path: '/a b/ws/microfrontends/web-front', relativePath: 'microfrontends/web-front' })).toBe('/a b/ws');
    expect(workspaceRootOf({ path: 'D:\\acme\\deprecated\\microfrontends\\old', relativePath: 'deprecated/microfrontends/old' })).toBe('D:\\acme');
    expect(parentPath('/ws')).toBe('/');
    expect(parentPath('ws')).toBe('');
  });

  it('worktree labels: folder name on the chip, ../folder next to the repo, the full path elsewhere', () => {
    expect(worktreeLabel('/ws/microfrontends/web-front-wt-s1')).toBe('web-front-wt-s1');
    expect(worktreeLabel('../mobile-wt-s1')).toBe('mobile-wt-s1');
    expect(worktreeLabel(null)).toBe('');
    expect(worktreeLine(null, '/ws/mobile')).toBe('in place');
    expect(worktreeLine('/ws/microfrontends/web-front-wt-s1', '/ws/microfrontends/web-front')).toBe('../web-front-wt-s1');
    expect(worktreeLine('D:\\ws\\mobile-wt-s1', 'D:\\ws\\mobile')).toBe('../mobile-wt-s1');
    expect(worktreeLine('../mobile-wt-s1', 'D:\\ws\\mobile')).toBe('../mobile-wt-s1');
    expect(worktreeLine('/elsewhere/web-front-wt-s1', '/ws/microfrontends/web-front')).toBe('/elsewhere/web-front-wt-s1');
  });

  it('D22: a branch owner is named by its title with the short name as the tooltip; else by owner, without one', () => {
    expect(branchOwnerLabel({ owner: 'jira-ticket-handling', ownerTitle: 'JIRA Ticket handling' })).toEqual({ text: 'JIRA Ticket handling', tooltip: 'jira-ticket-handling' });
    // An untitled session (its display title is its name), a title equal to the name, a note without a session.
    expect(branchOwnerLabel({ owner: 'button-rollout', ownerTitle: 'button-rollout' })).toEqual({ text: 'button-rollout', tooltip: undefined });
    expect(branchOwnerLabel({ owner: 'idle', ownerTitle: null })).toEqual({ text: 'idle', tooltip: undefined });
    expect(branchOwnerLabel({ owner: 'read by notifications-integration' })).toEqual({ text: 'read by notifications-integration', tooltip: undefined });
  });

  it('D22: the demo branches (no titles) read exactly as before: every owner by `owner`, no tooltip', async () => {
    const { solutions } = createDemoProviders(await loadDemoData());
    const branches = (await solutions.solutions({ id: 'demo', path: 'D:\\acme', root: 'D:\\acme', kind: 'workspace' }))
      .flatMap((g) => g.solutions)
      .flatMap((s) => s.branches);
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      expect(branch.ownerTitle).toBe(branch.sessionId === null ? null : branch.owner);
      expect(branchOwnerLabel(branch)).toEqual({ text: branch.owner, tooltip: undefined });
    }
  });

  it('phase ledger rows colored by phase, with the gap #12 fallback rows', () => {
    expect(
      ledgerRows({
        phase: 'mixed',
        ledger: [
          { interface: 'A', phase: 'UI-first', seam: 's' },
          { interface: 'B', phase: 'integration', seam: '' },
        ],
      }),
    ).toEqual([
      { interface: 'A', phase: 'UI-first', color: 'var(--status-need)', seam: 's' },
      { interface: 'B', phase: 'integration', color: 'var(--status-run)', seam: '' },
    ]);
    expect(ledgerRows({ phase: 'integration', ledger: null })).toEqual([
      { interface: '—', phase: 'integration', color: 'var(--muted-2)', seam: 'no phase-ledger.md' },
    ]);
    expect(ledgerRows({ phase: '—', ledger: [] })[0]?.seam).toBe('phase-ledger.md has no entries');
  });

  it('artifact rows with the INFO fallback; freshness line; the Codebase Memory tool by name', () => {
    expect(artifactRows([])).toEqual([{ type: 'INFO', name: 'No artifacts', meta: '', sessionId: null }]);
    const rows = [{ type: 'QA', name: 'coverage-matrix.md', meta: '12/18', sessionId: 's' }];
    expect(artifactRows(rows)).toEqual(rows);
    expect(freshnessLine('dirty')).toEqual({ text: 'codebase-memory · edited by agents since last index', color: 'var(--status-need)' });
    expect(freshnessLine('fresh')).toEqual({ text: 'codebase-memory · indexed · fresh', color: 'var(--status-done)' });
    expect(freshnessLine('unknown').text).toBe('codebase-memory · freshness unknown');
    expect(codebaseMemoryToolId([{ id: 'sw', name: 'Acme Tool' }, { id: 'cm', name: 'Codebase Memory' }])).toBe('cm');
    expect(codebaseMemoryToolId(null)).toBeNull();
  });
});
