import { describe, expect, it } from 'vitest';
import {
  STATUS_GLYPHS,
  STATUS_GLYPH_WORDS,
  STATUS_WORDS,
  lastStatusTable,
  newestStatusTable,
  parseStatusTable,
  plainCellText,
  reportedStatus,
  statusColumnIndex,
  statusTablesIn,
} from '../../src/core/derive/status-table.ts';

/**
 * D21: which printed tables are status tables (src/core/derive/status-table.ts,
 * docs/derivations.md → *Agent overview*): box-drawing tables in and outside code
 * fences, GFM pipe tables outside them, only with an Agent and a Status column;
 * kept as printed; the newest one wins. D27: the table parsed into its header and
 * rows, and the Status cells' colors.
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

/** D27: a box table as this very session's orchestrator printed it (4 columns, `├─┼─┤` between rows, emoji statuses). */
const SESSION_BOX = [
  '┌──────────────────┬──────────────────────────────────────────────────────┬───────────────────────────────────────┬────────────┐',
  '│ Agent            │ Description                                          │ Solution                              │ Status     │',
  '├──────────────────┼──────────────────────────────────────────────────────┼───────────────────────────────────────┼────────────┤',
  '│ 1. D24 Remote    │ Remote Control toggle, link + QR, reattach on resume │ switchboard/.worktrees/remote-control │ 🟢 running │',
  '├──────────────────┼──────────────────────────────────────────────────────┼───────────────────────────────────────┼────────────┤',
  '│ 2. D25 Teleport  │ "From a remote session" → local copy in a worktree   │ switchboard/.worktrees/teleport       │ ✅ merged  │',
  '└──────────────────┴──────────────────────────────────────────────────────┴───────────────────────────────────────┴────────────┘',
].join('\n');

const HEADER = ['Agent', 'Description', 'Solution', 'Status'];

function box(text: string) {
  return parseStatusTable({ text, format: 'box' });
}

function gfm(lines: readonly string[]) {
  return parseStatusTable({ text: lines.join('\n'), format: 'gfm' });
}

describe('parseStatusTable (D27): box-drawing tables', () => {
  it('the table an agent printed: the header and one row per ├─┼─┤ block, cells trimmed, emoji kept', () => {
    expect(statusTablesIn(SESSION_BOX)).toHaveLength(1);
    expect(box(SESSION_BOX)).toEqual({
      header: HEADER,
      rows: [
        ['1. D24 Remote', 'Remote Control toggle, link + QR, reattach on resume', 'switchboard/.worktrees/remote-control', '🟢 running'],
        ['2. D25 Teleport', '"From a remote session" → local copy in a worktree', 'switchboard/.worktrees/teleport', '✅ merged'],
      ],
    });
  });

  it('without separator rows between the data rows: one row per line', () => {
    const text = [
      '┌──────────┬────────────────────┬────────────┐',
      '│ Agent    │ Description        │ Status     │',
      '├──────────┼────────────────────┼────────────┤',
      '│ 1. web   │ Free talk at 360   │ 🟢 running │',
      '│ 2. mobile│ Free talk at 360   │ ⏳ queued  │',
      '│ 3. qa    │ Coverage matrix    │ ❌ failed  │',
      '└──────────┴────────────────────┴────────────┘',
    ].join('\n');
    expect(box(text)).toEqual({
      header: ['Agent', 'Description', 'Status'],
      rows: [
        ['1. web', 'Free talk at 360', '🟢 running'],
        ['2. mobile', 'Free talk at 360', '⏳ queued'],
        ['3. qa', 'Coverage matrix', '❌ failed'],
      ],
    });
  });

  it('a cell wrapped over two lines: each column\'s lines joined with one space, blank continuation cells ignored', () => {
    const text = [
      '┌─────────────┬───────────────────────────┬─────────────┐',
      '│ Agent       │ Description               │ Status      │',
      '├─────────────┼───────────────────────────┼─────────────┤',
      '│ 1. D24      │ Remote Control toggle,    │ 🟢 running  │',
      '│    Remote   │ link + QR                 │             │',
      '├─────────────┼───────────────────────────┼─────────────┤',
      '│ 2. D25      │ Teleport                  │ ✅ done     │',
      '└─────────────┴───────────────────────────┴─────────────┘',
    ].join('\n');
    expect(box(text)?.rows).toEqual([
      ['1. D24 Remote', 'Remote Control toggle, link + QR', '🟢 running'],
      ['2. D25', 'Teleport', '✅ done'],
    ]);
    // A header printed over two lines is joined the same way.
    const header = ['┌──────┬──────────┐', '│ Agent│ Status   │', '│      │ (latest) │', '├──────┼──────────┤', '│ web  │ done     │', '└──────┴──────────┘'].join('\n');
    expect(box(header)?.header).toEqual(['Agent', 'Status (latest)']);
  });

  it('a wrapped cell in a table without separator rows: a line whose first or Status cell is blank continues the row', () => {
    const text = [
      '┌──────────┬───────────────────────┬──────────┐',
      '│ Agent    │ Description           │ Status   │',
      '├──────────┼───────────────────────┼──────────┤',
      '│ web      │ Free talk at 360,     │ running  │',
      '│          │ then 640              │          │',
      '│ mobile   │ Free talk             │ queued   │',
      '│ qa-web   │ Coverage              │ blocked  │',
      '│ runner   │ matrix                │          │',
      '└──────────┴───────────────────────┴──────────┘',
    ].join('\n');
    expect(box(text)?.rows).toEqual([
      ['web', 'Free talk at 360, then 640', 'running'],
      ['mobile', 'Free talk', 'queued'],
      ['qa-web runner', 'Coverage matrix', 'blocked'],
    ]);
  });

  it('wide characters in a middle column (emoji, CJK) never shift the columns: cells split on │, not on positions', () => {
    const text = [
      '┌────────┬────────────────────────┬──────────┐',
      '│ Agent  │ Status                 │ Branch   │',
      '├────────┼────────────────────────┼──────────┤',
      '│ web    │ ✅ done · merge blocked │ feat/a   │',
      '├────────┼────────────────────────┼──────────┤',
      '│ mobile │ 🟡 needs 設計 review    │ feat/b   │',
      '└────────┴────────────────────────┴──────────┘',
    ].join('\n');
    expect(box(text)).toEqual({
      header: ['Agent', 'Status', 'Branch'],
      rows: [
        ['web', '✅ done · merge blocked', 'feat/a'],
        ['mobile', '🟡 needs 設計 review', 'feat/b'],
      ],
    });
  });

  it('box cells are kept literally (no Markdown), and a table with no rule under its header has the first line as its header', () => {
    const text = ['┌───────┬──────────┐', '│ Agent │ Status   │', '│ **web** │ `done` │', '└───────┴──────────┘'].join('\n');
    expect(box(text)).toEqual({ header: ['Agent', 'Status'], rows: [['**web**', '`done`']] });
  });

  it('null: rows with another number of cells, a line cut short, no row, no header, a line that is not part of a table', () => {
    const lines = SESSION_BOX.split('\n');
    const extraCell = lines.map((line, i) => (i === 3 ? line.replace('🟢 running │', '🟢 running │ x │') : line)).join('\n');
    expect(box(extraCell)).toBeNull();
    // Cut by the 4000-character payload limit: the last line does not end with │.
    expect(box(lines.slice(0, 4).join('\n').slice(0, -8))).toBeNull();
    // Header only.
    expect(box(lines.slice(0, 3).join('\n'))).toBeNull();
    expect(box([lines[0], lines[2], lines[6]].join('\n'))).toBeNull();
    expect(box('')).toBeNull();
    expect(box([...lines.slice(0, 4), 'Some text', ...lines.slice(4)].join('\n'))).toBeNull();
  });
});

describe('parseStatusTable (D27): GFM pipe tables', () => {
  it('the header and rows under the delimiter row; inline Markdown reduced to text, a link to its text', () => {
    expect(
      gfm([
        '| Agent | Description | Status |',
        '|:--|---|--:|',
        '| **web** | Free talk at 360, see [PR #12](https://github.com/o/r/pull/12) | ✅ *merged* |',
        '| `mobile` | Free talk ~~at 360~~ | 🟢 running |',
      ]),
    ).toEqual({
      header: ['Agent', 'Description', 'Status'],
      rows: [
        ['web', 'Free talk at 360, see PR #12', '✅ merged'],
        ['mobile', 'Free talk at 360', '🟢 running'],
      ],
    });
  });

  it('escaped pipes are cell text, not separators; outer pipes are optional; blank lines are skipped', () => {
    expect(gfm(['Agent | Status | Note', '--- | --- | ---', 'web | done | a \\| b', '', 'mobile | queued | `x \\| y`'])).toEqual({
      header: ['Agent', 'Status', 'Note'],
      rows: [
        ['web', 'done', 'a | b'],
        ['mobile', 'queued', 'x | y'],
      ],
    });
  });

  it('null: a row with fewer or more cells than the header, no row, no delimiter row', () => {
    expect(gfm(['| Agent | Status |', '|---|---|', '| web |'])).toBeNull();
    expect(gfm(['| Agent | Status |', '|---|---|', '| web | done | extra |'])).toBeNull();
    expect(gfm(['| Agent | Status |', '|---|---|'])).toBeNull();
    expect(gfm(['| Agent | Status |', '| web | done |'])).toBeNull();
    expect(gfm([])).toBeNull();
  });
});

describe('plainCellText (D27)', () => {
  it('reduces **x**, __x__, *x*, _x_, ~~x~~, `x`, [text](url), ![alt](url) and <url> to their text', () => {
    expect(plainCellText('  **bold** and __strong__  ')).toBe('bold and strong');
    expect(plainCellText('*it* and _em_ and ~~gone~~')).toBe('it and em and gone');
    expect(plainCellText('[PR #12](https://x.y/12) · ![shot](a.png) · <https://x.y>')).toBe('PR #12 · shot · https://x.y');
    expect(plainCellText('`npm test`')).toBe('npm test');
  });

  it('keeps what is not Markdown: code span contents, snake_case, lone stars, escaped characters', () => {
    expect(plainCellText('`**not bold**`')).toBe('**not bold**');
    expect(plainCellText('`` a`b ``')).toBe('a`b');
    expect(plainCellText('acme_app_front')).toBe('acme_app_front');
    expect(plainCellText('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(plainCellText('\\*literal\\* \\_x\\_')).toBe('*literal* _x_');
    expect(plainCellText('a \\| b')).toBe('a | b');
  });
});

describe('reportedStatus (D27): the Status cell\'s color and text', () => {
  it('status glyphs first; the leading glyph is removed from the text', () => {
    expect(reportedStatus('🟢 running')).toEqual({ status: 'run', text: 'running' });
    expect(reportedStatus('✅ merged')).toEqual({ status: 'done', text: 'merged' });
    expect(reportedStatus('✓ done')).toEqual({ status: 'done', text: 'done' });
    expect(reportedStatus('🟡 review')).toEqual({ status: 'need', text: 'review' });
    expect(reportedStatus('⏳ CI')).toEqual({ status: 'need', text: 'CI' });
    expect(reportedStatus('⏸️ paused')).toEqual({ status: 'need', text: 'paused' });
    expect(reportedStatus('❌ build')).toEqual({ status: 'fail', text: 'build' });
    expect(reportedStatus('✕ lint')).toEqual({ status: 'fail', text: 'lint' });
    expect(reportedStatus('🔴 red')).toEqual({ status: 'fail', text: 'red' });
  });

  it('a glyph decides before any word: ✅ done · merge blocked is done, 🟢 failed-once is run', () => {
    expect(reportedStatus('✅ done · merge blocked')).toEqual({ status: 'done', text: 'done · merge blocked' });
    expect(reportedStatus('🟢 retrying after failed')).toEqual({ status: 'run', text: 'retrying after failed' });
    // The first glyph in the cell decides; a glyph that is not leading stays in the text.
    expect(reportedStatus('merged ✅')).toEqual({ status: 'done', text: 'merged ✅' });
    expect(reportedStatus('🟡 then ❌')).toEqual({ status: 'need', text: 'then ❌' });
  });

  it('then words, whole and case-insensitive; the first word in the cell decides', () => {
    expect(reportedStatus('running')).toEqual({ status: 'run', text: 'running' });
    expect(reportedStatus('Testing 640')).toEqual({ status: 'run', text: 'Testing 640' });
    expect(reportedStatus('In Progress')).toEqual({ status: 'run', text: 'In Progress' });
    expect(reportedStatus('in-progress')).toEqual({ status: 'run', text: 'in-progress' });
    expect(reportedStatus('DONE')).toEqual({ status: 'done', text: 'DONE' });
    expect(reportedStatus('merged to dev')).toEqual({ status: 'done', text: 'merged to dev' });
    expect(reportedStatus('green (Tier A)')).toEqual({ status: 'done', text: 'green (Tier A)' });
    expect(reportedStatus('queued')).toEqual({ status: 'need', text: 'queued' });
    expect(reportedStatus('waiting for review')).toEqual({ status: 'need', text: 'waiting for review' });
    expect(reportedStatus('blocked on the contract')).toEqual({ status: 'need', text: 'blocked on the contract' });
    expect(reportedStatus('needs you')).toEqual({ status: 'need', text: 'needs you' });
    expect(reportedStatus('Tests FAILED')).toEqual({ status: 'fail', text: 'Tests FAILED' });
    expect(reportedStatus('done · merge blocked')).toEqual({ status: 'done', text: 'done · merge blocked' });
    expect(reportedStatus('blocked, then done')).toEqual({ status: 'need', text: 'blocked, then done' });
  });

  it('anything else is idle, shown as printed (other emoji kept; words inside words do not count)', () => {
    expect(reportedStatus('not started')).toEqual({ status: 'idle', text: 'not started' });
    expect(reportedStatus('undone')).toEqual({ status: 'idle', text: 'undone' });
    expect(reportedStatus('🟣 planning')).toEqual({ status: 'idle', text: '🟣 planning' });
    expect(reportedStatus('  ')).toEqual({ status: 'idle', text: '' });
    expect(reportedStatus('—')).toEqual({ status: 'idle', text: '—' });
  });

  it('a cell that is only a status glyph keeps a readable word', () => {
    expect(reportedStatus('🟢')).toEqual({ status: 'run', text: 'running' });
    expect(reportedStatus('✅')).toEqual({ status: 'done', text: 'done' });
    expect(reportedStatus('✓')).toEqual({ status: 'done', text: 'done' });
    expect(reportedStatus('⏸️')).toEqual({ status: 'need', text: 'waiting' });
    expect(reportedStatus('⏳')).toEqual({ status: 'need', text: 'waiting' });
    expect(reportedStatus('❌')).toEqual({ status: 'fail', text: 'failed' });
    expect(STATUS_GLYPH_WORDS).toEqual({ run: 'running', done: 'done', need: 'waiting', fail: 'failed' });
  });

  it('the glyph and word lists are D27\'s', () => {
    // Developer ruling 2026-09-28 added ✔ (done), ✖ ✗ (failed), 🔵 (running) and 🟠 (waiting).
    expect(STATUS_GLYPHS).toEqual({
      '🟢': 'run',
      '🔵': 'run',
      '✅': 'done',
      '✓': 'done',
      '✔': 'done',
      '🟡': 'need',
      '🟠': 'need',
      '⏳': 'need',
      '⏸': 'need',
      '❌': 'fail',
      '✕': 'fail',
      '✖': 'fail',
      '✗': 'fail',
      '🔴': 'fail',
    });
    expect(reportedStatus('🔵 planning')).toEqual({ status: 'run', text: 'planning' });
    expect(reportedStatus('✔️ merged')).toEqual({ status: 'done', text: 'merged' });
    expect(reportedStatus('✖ build broke')).toEqual({ status: 'fail', text: 'build broke' });
    expect(reportedStatus('✗')).toEqual({ status: 'fail', text: 'failed' });
    expect(reportedStatus('🟠 review')).toEqual({ status: 'need', text: 'review' });
    expect(STATUS_WORDS).toEqual({
      running: 'run',
      testing: 'run',
      'in progress': 'run',
      done: 'done',
      merged: 'done',
      green: 'done',
      queued: 'need',
      waiting: 'need',
      blocked: 'need',
      needs: 'need',
      failed: 'fail',
    });
  });

  it('statusColumnIndex: the header\'s Status cell, trimmed and case-insensitive', () => {
    expect(statusColumnIndex(HEADER)).toBe(3);
    expect(statusColumnIndex(['Agent', ' STATUS '])).toBe(1);
    expect(statusColumnIndex(['Agent', 'Status code'])).toBe(-1);
  });
});
