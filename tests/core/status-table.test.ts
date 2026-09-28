import { describe, expect, it } from 'vitest';
import { lastStatusTable, newestStatusTable, statusTablesIn } from '../../src/core/derive/status-table.ts';

/**
 * D21: which printed tables are status tables (src/core/derive/status-table.ts,
 * docs/derivations.md → *Agent overview*): box-drawing tables in and outside code
 * fences, GFM pipe tables outside them, only with an Agent and a Status column;
 * kept as printed; the newest one wins.
 */

const BOX = [
  '┌─────────────────┬──────────────────────┬──────────────────┬────────────┐',
  '│ Agent           │ Description          │ Solution         │ Status     │',
  '├─────────────────┼──────────────────────┼──────────────────┼────────────┤',
  '│ 1. web          │ Free talk at 360     │ acme-app-front/  │ 🟢 running │',
  '├─────────────────┼──────────────────────┼──────────────────┼────────────┤',
  '│ 2. mobile       │ Free talk at 360     │ mobile/          │ ✅ done    │',
  '└─────────────────┴──────────────────────┴──────────────────┴────────────┘',
];

const PIPE = ['| Agent | Description | Status |', '|:--|---|--:|', '| web | Free talk | running |', '| mobile | Free talk | done |'];

describe('statusTablesIn', () => {
  it('a box-drawing table inside a code fence: its lines without the fence', () => {
    const text = ['Status:', '', '```', ...BOX, '```', '', 'Next I wait.'].join('\n');
    expect(statusTablesIn(text)).toEqual([{ text: BOX.join('\n'), format: 'box' }]);
  });

  it('a bare box-drawing table (no fence), and one in a fence with a language or tildes', () => {
    expect(statusTablesIn(['Here:', ...BOX, 'Done.'].join('\n'))).toEqual([{ text: BOX.join('\n'), format: 'box' }]);
    expect(statusTablesIn(['```text', ...BOX, '```'].join('\n'))).toEqual([{ text: BOX.join('\n'), format: 'box' }]);
    expect(statusTablesIn(['~~~~', ...BOX, '~~~~'].join('\n'))).toEqual([{ text: BOX.join('\n'), format: 'box' }]);
  });

  it('keeps the table as printed, only the common indentation removed (a fence inside a list item)', () => {
    const indented = BOX.map((line) => `   ${line}`);
    expect(statusTablesIn(['- status:', '   ```', ...indented, '   ```'].join('\n'))).toEqual([{ text: BOX.join('\n'), format: 'box' }]);
    expect(statusTablesIn([...BOX].join('\r\n'))).toEqual([{ text: BOX.join('\n'), format: 'box' }]);
  });

  it('a GFM pipe table outside fences, with or without outer pipes', () => {
    expect(statusTablesIn(['Agents:', '', ...PIPE, '', 'More text.'].join('\n'))).toEqual([{ text: PIPE.join('\n'), format: 'gfm' }]);
    const bare = ['Agent | Status', '--- | ---', 'web | done'];
    expect(statusTablesIn(bare.join('\n'))).toEqual([{ text: bare.join('\n'), format: 'gfm' }]);
    // The table ends at the first blank line or line without a pipe.
    expect(statusTablesIn([...PIPE, 'Plain text after it.'].join('\n'))).toEqual([{ text: PIPE.join('\n'), format: 'gfm' }]);
  });

  it('the header names are matched trimmed and case-insensitively, anywhere in the header', () => {
    const box = ['┌────────┬───────┬────────┐', '│  STATUS │ Notes │  agent │', '└────────┴───────┴────────┘'];
    expect(statusTablesIn(box.join('\n'))).toHaveLength(1);
    expect(statusTablesIn(['| status | AGENT |', '|---|---|', '| done | web |'].join('\n'))).toHaveLength(1);
  });

  it('ignores tables without an Agent and a Status column', () => {
    const noStatus = ['┌───────┬────────┐', '│ Agent │ Branch │', '├───────┼────────┤', '│ web   │ main   │', '└───────┴────────┘'];
    const noAgent = ['| Solution | Status |', '|---|---|', '| web | done |'];
    const lookalike = ['| Agent name | Status code |', '|---|---|', '| web | 200 |'];
    expect(statusTablesIn([...noStatus, '', ...noAgent, '', ...lookalike].join('\n'))).toEqual([]);
  });

  it('a pipe table inside a code fence is code, not a table; a pipe header without its delimiter row is text', () => {
    expect(statusTablesIn(['```', ...PIPE, '```'].join('\n'))).toEqual([]);
    expect(statusTablesIn(['| Agent | Status |', '| web | done |'].join('\n'))).toEqual([]);
    // The delimiter row must have as many cells as the header.
    expect(statusTablesIn(['| Agent | Status |', '|---|', '| web | done |'].join('\n'))).toEqual([]);
  });

  it('several tables in one message, in the order printed; a box table cut short still counts', () => {
    const cut = BOX.slice(0, 4);
    const text = [...PIPE, '', '```', ...BOX, '```', '', ...cut].join('\n');
    expect(statusTablesIn(text).map((t) => [t.format, t.text.split('\n').length])).toEqual([
      ['gfm', 4],
      ['box', 7],
      ['box', 4],
    ]);
  });

  it('text with no table (plain text, box characters that are not a table, a lone pipe)', () => {
    expect(statusTablesIn('All done. Nothing to report.')).toEqual([]);
    expect(statusTablesIn('│ Agent │ Status │ without any border lines')).toEqual([]);
    expect(statusTablesIn('Use a | b for the pipe.\nAgent status: fine.')).toEqual([]);
    expect(statusTablesIn('')).toEqual([]);
  });
});

describe('lastStatusTable / newestStatusTable', () => {
  const older = ['| Agent | Status |', '|---|---|', '| web | running |'].join('\n');
  const newer = ['┌───────┬────────┐', '│ Agent │ Status │', '├───────┼────────┤', '│ web   │ done   │', '└───────┴────────┘'].join('\n');

  it('the last table of a message is its newest', () => {
    expect(lastStatusTable(`${older}\n\nLater:\n\n${newer}`)).toEqual({ text: newer, format: 'box' });
    expect(lastStatusTable('No table here.')).toBeNull();
  });

  it('the newest message with a table wins (by time, then id), whatever the input order; messages without one are skipped', () => {
    const messages = [
      { text: older, at: '2026-09-28T10:00:00.000Z', id: 1 },
      { text: 'Just words about the agent status.', at: '2026-09-28T10:05:00.000Z', id: 3 },
      { text: `Update:\n\n\`\`\`\n${newer}\n\`\`\``, at: '2026-09-28T10:02:00.000Z', id: 2 },
    ];
    expect(newestStatusTable(messages)).toEqual({ text: newer, format: 'box', at: '2026-09-28T10:02:00.000Z' });
    expect(newestStatusTable([...messages].reverse())).toEqual({ text: newer, format: 'box', at: '2026-09-28T10:02:00.000Z' });
    // Same time: the greater id is newer.
    const tie = [
      { text: newer, at: '2026-09-28T10:00:00.000Z', id: 7 },
      { text: older, at: '2026-09-28T10:00:00.000Z', id: 8 },
    ];
    expect(newestStatusTable(tie)?.format).toBe('gfm');
  });

  it('no message with a table → null', () => {
    expect(newestStatusTable([])).toBeNull();
    expect(newestStatusTable([{ text: 'OK', at: '2026-09-28T10:00:00.000Z', id: 1 }])).toBeNull();
  });
});
