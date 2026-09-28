import { describe, expect, it } from 'vitest';
import type { Agent } from '../../src/core/api.ts';
import {
  OVERVIEW_COLUMNS,
  OVERVIEW_LABEL,
  OVERVIEW_STATUS_WORDS,
  PRINTED_POPOVER_EDGE,
  PRINTED_POPOVER_GAP,
  PRINTED_POPOVER_LABEL,
  PRINTED_TOGGLE,
  REPORTED_COLUMN_SHARES,
  REPORTED_HEADING,
  overviewRows,
  printedPopoverPlace,
  reportedColumnWidths,
  reportedHeading,
  reportedTableView,
} from '../../src/web/views/session/agent-overview.ts';
import { agentCards } from '../../src/web/views/session/right-panel.ts';

/**
 * D21: the agent overview's derived table (src/web/views/session/agent-overview.ts,
 * docs/session-panel.md → *Agent overview*): one row per agent in start order,
 * Agent · Description · Solution · Status, and the printed table's heading.
 * D27: the printed table's columns, widths, cells and Status colors as drawn.
 */

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'main',
    kind: 'main',
    name: 'acme-app-front',
    description: null,
    solutionPath: null,
    branch: null,
    status: 'run',
    statusText: null,
    ...overrides,
  };
}

describe('derived table rows', () => {
  it('a session with only the main agent: one row, the task\'s first line as its description, no solution yet', () => {
    const rows = overviewRows([agent({ status: 'done' })], { status: 'done', task: 'Build the free-talk screen.\nMore detail.' });
    expect(rows).toEqual([
      {
        id: 'main',
        main: true,
        name: 'acme-app-front',
        description: 'Build the free-talk screen.',
        solution: '—',
        solutionPath: null,
        status: 'done',
        statusText: '✓ done',
      },
    ]);
  });

  it('the main agent first, then each subagent in start order; the solution is the folder name of solutionPath (the path is kept for the tooltip)', () => {
    const rows = overviewRows(
      [
        agent({ solutionPath: 'microfrontends/acme-app-front' }),
        agent({ id: 'a', kind: 'subagent', name: 'general-purpose', description: 'Read hello.txt', solutionPath: 'mobile/' }),
        agent({ id: 'b', kind: 'subagent', name: 'Explore', description: null }),
      ],
      { status: 'run', task: 'Task' },
    );
    expect(rows.map((row) => [row.name, row.main, row.description, row.solution, row.solutionPath])).toEqual([
      ['acme-app-front', true, 'Task', 'acme-app-front', 'microfrontends/acme-app-front'],
      ['general-purpose', false, 'Read hello.txt', 'mobile', 'mobile/'],
      ['Explore', false, '', '—', null],
    ]);
  });

  it('status: the agent\'s own status text when set, else ✓ done / ✕ failed / ⏸ waiting / ● running / idle / paused', () => {
    const rows = overviewRows(
      [
        agent({ status: 'need' }),
        agent({ id: 'a', kind: 'subagent', status: 'run', statusText: 'Reading hello.txt' }),
        agent({ id: 'b', kind: 'subagent', status: 'run' }),
        agent({ id: 'c', kind: 'subagent', status: 'done' }),
        agent({ id: 'd', kind: 'subagent', status: 'fail' }),
        agent({ id: 'e', kind: 'subagent', status: 'idle' }),
        agent({ id: 'f', kind: 'subagent', status: 'done', statusText: 'asked 1' }),
      ],
      { status: 'need', task: 'Task' },
    );
    expect(rows.map((row) => [row.statusText, row.status])).toEqual([
      ['⏸ waiting', 'need'],
      ['Reading hello.txt', 'run'],
      ['● running', 'run'],
      ['✓ done', 'done'],
      ['✕ failed', 'fail'],
      ['idle', 'idle'],
      ['asked 1', 'done'],
    ]);
    expect(OVERVIEW_STATUS_WORDS).toEqual({ need: '⏸ waiting', run: '● running', done: '✓ done', fail: '✕ failed', idle: 'idle', paused: 'paused' });
  });

  it('while the session is paused, an agent the pause cut off reads paused (as its card does)', () => {
    const agents = [agent({ status: 'idle', statusText: 'Tier A green' }), agent({ id: 'a', kind: 'subagent', status: 'done' })];
    const session = { status: 'paused' as const, task: 'Task' };
    expect(overviewRows(agents, session).map((row) => [row.statusText, row.status])).toEqual([
      ['paused', 'paused'],
      ['✓ done', 'done'],
    ]);
    // The same status and description as the agent cards.
    const cards = agentCards(agents, session);
    expect(overviewRows(agents, session).map((row) => [row.status, row.description])).toEqual(cards.map((card) => [card.status, card.description]));
  });

  it('the section label and columns', () => {
    expect(OVERVIEW_LABEL).toBe('Agents overview');
    expect(OVERVIEW_COLUMNS).toEqual(['Agent', 'Description', 'Solution', 'Status']);
  });
});

describe('printed table heading', () => {
  it('"As reported by the agent · <age>" with the sidebar\'s relative age', () => {
    const at = '2026-09-28T10:00:00.000Z';
    const t = Date.parse(at);
    expect(REPORTED_HEADING).toBe('As reported by the agent');
    expect(reportedHeading(at, t + 20_000)).toBe('As reported by the agent · now');
    expect(reportedHeading(at, t + 3 * 60_000)).toBe('As reported by the agent · 3m');
    expect(reportedHeading(at, t + 5 * 3_600_000)).toBe('As reported by the agent · 5h');
    expect(reportedHeading(at, t + 2 * 86_400_000)).toBe('As reported by the agent · 2d');
  });
});

describe('reported table view (D27)', () => {
  const at = '2026-09-28T10:00:00.000Z';
  const BOX = [
    '┌──────────────────┬──────────────────────────────────────────────────────┬───────────────────────────────────────┬────────────┐',
    '│ Agent            │ Description                                          │ Solution                              │ Status     │',
    '├──────────────────┼──────────────────────────────────────────────────────┼───────────────────────────────────────┼────────────┤',
    '│ 1. D24 Remote    │ Remote Control toggle, link + QR, reattach on resume │ switchboard/.worktrees/remote-control │ 🟢 running │',
    '├──────────────────┼──────────────────────────────────────────────────────┼───────────────────────────────────────┼────────────┤',
    '│ 2. D25 Teleport  │ "From a remote session" → local copy in a worktree   │ switchboard/.worktrees/teleport       │ ✅ merged  │',
    '└──────────────────┴──────────────────────────────────────────────────────┴───────────────────────────────────────┴────────────┘',
  ].join('\n');

  it('every printed column in order; Agent like the names, Status with its color, the rest muted; Description the widest', () => {
    const view = reportedTableView({ text: BOX, format: 'box', at });
    expect(view?.columns).toEqual([
      { name: 'Agent', kind: 'agent', width: '18.18%' },
      { name: 'Description', kind: 'text', width: '36.36%' },
      { name: 'Solution', kind: 'text', width: '18.18%' },
      { name: 'Status', kind: 'status', width: '27.27%' },
    ]);
    expect(view?.rows).toEqual([
      {
        status: 'run',
        cells: [
          { text: '1. D24 Remote', status: null },
          { text: 'Remote Control toggle, link + QR, reattach on resume', status: null },
          { text: 'switchboard/.worktrees/remote-control', status: null },
          { text: 'running', status: 'run' },
        ],
      },
      {
        status: 'done',
        cells: [
          { text: '2. D25 Teleport', status: null },
          { text: '"From a remote session" → local copy in a worktree', status: null },
          { text: 'switchboard/.worktrees/teleport', status: null },
          { text: 'merged', status: 'done' },
        ],
      },
    ]);
  });

  it('a GFM table: plain text cells, the Status column wherever it is printed, an unknown status idle', () => {
    const text = ['| Status | Agent | PR |', '|---|---|---|', '| **blocked** | web | [#12](https://x.y/12) |', '| ⏳ | mobile | — |', '| planning | qa | — |'].join('\n');
    const view = reportedTableView({ text, format: 'gfm', at });
    expect(view?.columns.map((column) => [column.name, column.kind, column.width])).toEqual([
      ['Status', 'status', '42.86%'],
      ['Agent', 'agent', '28.57%'],
      ['PR', 'text', '28.57%'],
    ]);
    expect(view?.rows.map((row) => [row.status, row.cells.map((cell) => cell.text)])).toEqual([
      ['need', ['blocked', 'web', '#12']],
      ['need', ['waiting', 'mobile', '—']],
      ['idle', ['planning', 'qa', '—']],
    ]);
  });

  it('null when the table cannot be parsed into consistent rows (the overview shows it as printed)', () => {
    expect(reportedTableView({ text: ['| Agent | Status |', '|---|---|', '| web |'].join('\n'), format: 'gfm', at })).toBeNull();
    expect(reportedTableView({ text: BOX.split('\n').slice(0, 4).join('\n').slice(0, -3), format: 'box', at })).toBeNull();
  });

  it('widths: Description two shares, Status one and a half, every other column one', () => {
    expect(REPORTED_COLUMN_SHARES).toEqual({ description: 2, status: 1.5 });
    expect(reportedColumnWidths(['Agent', 'Description', 'Solution', 'Status'])).toEqual(['18.18%', '36.36%', '18.18%', '27.27%']);
    expect(reportedColumnWidths(['Agent', ' description ', 'STATUS'])).toEqual(['22.22%', '44.44%', '33.33%']);
    expect(reportedColumnWidths(['Agent', 'Task', 'Branch', 'PR', 'Status'])).toEqual(['18.18%', '18.18%', '18.18%', '18.18%', '27.27%']);
    expect(reportedColumnWidths(['Agent', 'Status'])).toEqual(['40%', '60%']);
  });

  it('the toggle reads "as printed"; the popover is labelled', () => {
    expect(PRINTED_TOGGLE).toBe('as printed');
    expect(PRINTED_POPOVER_LABEL).toBe('As printed by the agent');
  });
});

describe('"as printed" popover place (D27: nothing in the right panel scrolls sideways)', () => {
  const viewport = { viewportWidth: 1440, viewportHeight: 900 };

  it('left of the panel (8 px gap), growing leftwards up to 16 px from the window, at the reported section\'s top', () => {
    expect(PRINTED_POPOVER_GAP).toBe(8);
    expect(PRINTED_POPOVER_EDGE).toBe(16);
    expect(printedPopoverPlace({ anchorTop: 230, panelLeft: 1060, ...viewport, height: 200 })).toEqual({ top: 230, right: 388, maxWidth: 1036, maxHeight: 868 });
  });

  it('moved up to stay inside the window; never above its top edge; at most the window\'s height', () => {
    expect(printedPopoverPlace({ anchorTop: 800, panelLeft: 1060, ...viewport, height: 300 }).top).toBe(584);
    expect(printedPopoverPlace({ anchorTop: 800, panelLeft: 1060, ...viewport, height: 2000 })).toMatchObject({ top: 16, maxHeight: 868 });
    expect(printedPopoverPlace({ anchorTop: 4, panelLeft: 1060, ...viewport, height: 100 }).top).toBe(16);
  });

  it('a narrow window leaves no negative width', () => {
    expect(printedPopoverPlace({ anchorTop: 0, panelLeft: 10, viewportWidth: 390, viewportHeight: 20, height: 0 })).toEqual({ top: 16, right: 388, maxWidth: 0, maxHeight: 0 });
  });
});
