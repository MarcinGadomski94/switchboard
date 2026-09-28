import { describe, expect, it } from 'vitest';
import type { Agent } from '../../src/core/api.ts';
import {
  OVERVIEW_COLUMNS,
  OVERVIEW_LABEL,
  OVERVIEW_STATUS_WORDS,
  REPORTED_HEADING,
  overviewRows,
  reportedHeading,
} from '../../src/web/views/session/agent-overview.ts';
import { agentCards } from '../../src/web/views/session/right-panel.ts';

/**
 * D21: the agent overview's derived table (src/web/views/session/agent-overview.ts,
 * docs/session-panel.md → *Agent overview*): one row per agent in start order,
 * Agent · Description · Solution · Status, and the printed table's heading.
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
