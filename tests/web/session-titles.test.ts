import { describe, expect, it } from 'vitest';
import type { InboxItem, Loop, Session } from '../../src/core/api.ts';
import { TITLE_RULE } from '../../src/core/session-title.ts';
import { renameErrorText, titleDraft, titleEditOutcome, titleTooltip } from '../../src/web/components/title-edit.ts';
import {
  DEFAULT_FORM,
  type NewSessionForm,
  TITLE_TOO_LONG,
  canStart,
  startNames,
  summaryLines,
  titleTooLong,
  toStartBody,
} from '../../src/web/modals/new-session.ts';
import { filterPalette, paletteEntries } from '../../src/web/modals/palette.ts';
import { canSaveSchedule, cronPreview, scheduleSummaryLines, toScheduleInput } from '../../src/web/modals/schedule-form.ts';
import { movedState } from '../../src/web/views/history-move.ts';
import { loopCards } from '../../src/web/views/loops.ts';
import { questionNotice } from '../../src/web/toast/notify.ts';

/** D22 in the UI (`docs/derivations.md` → *Session titles*, `docs/new-session.md` → *Name and title*). */

function form(overrides: Partial<NewSessionForm> = {}): NewSessionForm {
  return { ...DEFAULT_FORM, ...overrides };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    origin: 'switchboard',
    id: 's1',
    name: 'jira-ticket-handling',
    claudeSessionId: 'c1',
    status: 'run',
    workType: null,
    mode: null,
    phase: null,
    coordination: null,
    qaStack: null,
    ultracode: false,
    worktrees: false,
    solutions: [],
    attached: true,
    createdAt: '2026-09-28T09:00:00.000Z',
    lastActivityAt: null,
    agents: [],
    openQuestionCount: 0,
    cwd: null,
    folder: null,
    folderPath: null,
    folderKind: null,
    live: false,
    resumeCommand: 'claude --resume c1',
    chips: [],
    loops: [],
    activity: null,
    title: 'JIRA Ticket handling',
    displayTitle: 'JIRA Ticket handling',
    ...overrides,
  };
}

const repoFolder = { id: 'f-repo', path: '/src/switchboard', name: 'switchboard', displayName: 'switchboard', kind: 'repo' as const };

describe('New-session form: the name field is the title (D22)', () => {
  it('derives the short name from the title; a taken one gets -2; kebab-case text is a title too (developer ruling)', () => {
    expect(startNames(form({ name: ' JIRA Ticket handling ' }), [])).toEqual({ name: 'jira-ticket-handling', title: 'JIRA Ticket handling' });
    expect(startNames(form({ name: 'JIRA Ticket handling' }), ['jira-ticket-handling'])).toEqual({ name: 'jira-ticket-handling-2', title: 'JIRA Ticket handling' });
    expect(startNames(form({ name: 'free-talk-640' }), [])).toEqual({ name: 'free-talk-640', title: 'free-talk-640' });
    expect(startNames(form({ name: 'free-talk-640' }), ['free-talk-640'])).toEqual({ name: 'free-talk-640-2', title: 'free-talk-640' });
    expect(startNames(form({ name: '' }), [])).toEqual({ name: 'session', title: null });
    expect(startNames(form({ name: '!!!' }), [])).toEqual({ name: 'session', title: '!!!' });
  });

  it('Start posts the derived name and the title (workspace and repo folder); kebab-case text as both; an empty field no title', () => {
    const body = toStartBody(form({ name: 'JIRA Ticket handling', solutions: ['acme-app-front'] }), null, ['jira-ticket-handling']);
    expect(body).toMatchObject({ name: 'jira-ticket-handling-2', title: 'JIRA Ticket handling', solutions: ['acme-app-front'] });
    expect(toStartBody(form({ name: 'Fix the build', worktrees: true }), repoFolder, [])).toEqual({
      name: 'fix-the-build',
      title: 'Fix the build',
      task: '',
      folder: 'f-repo',
      solutions: ['switchboard'],
      worktrees: true,
      ultracode: false,
    });
    expect(toStartBody(form({ name: 'free-talk-640', solutions: ['mobile'] }), null, [])).toMatchObject({ name: 'free-talk-640', title: 'free-talk-640' });
    expect('title' in toStartBody(form({ name: '  ', solutions: ['mobile'] }), null, [])).toBe(false);
    expect(toStartBody(form({ name: '', solutions: ['mobile'] }), null, [])).toMatchObject({ name: 'session' });
  });

  it('the summary shows the short name in the branch and worktree lines; nothing changes for a kebab-case name', () => {
    const titled = summaryLines(form({ name: 'JIRA Ticket handling', solutions: ['acme-app-front'] }), '/ws', []).map((l) => [l.text, l.tone]);
    const at = titled.findIndex(([text]) => text === '# worktrees');
    expect(titled.slice(at, at + 3)).toEqual([
      ['# worktrees', 'comment'],
      ['branch    session/jira-ticket-handling', 'value'],
      ['../acme-app-front-wt-jira-ticket-handling', 'path'],
    ]);
    const inPlace = summaryLines(form({ name: 'JIRA Ticket handling', solutions: ['mobile'], worktrees: false }), '/ws', []).map((l) => l.text);
    expect(inPlace).toContain('name      jira-ticket-handling');
    const repo = summaryLines(form({ name: 'Fix the build' }), null, [], repoFolder).map((l) => l.text);
    expect(repo).toContain('cwd       /src/switchboard-wt-fix-the-build');
    expect(repo).toContain('branch    session/fix-the-build');
    expect(repo).toContain('../switchboard-wt-fix-the-build');

    // A kebab-case name (a title equal to its short name): exactly the pre-D22 summary (no branch line).
    const kebab = summaryLines(form({ name: 'free-talk-640', mode: 'orchestrator', solutions: ['acme-app-front', 'mobile'] }), 'D:\\acme', []).map((l) => l.text);
    expect(kebab).toEqual([
      '# claude code · background · Max',
      'cwd       D:\\acme',
      'work      feature-building',
      'mode      workspace orchestrator',
      'phase     UI-first',
      'ultracode off',
      ' ',
      '# worktrees',
      '../acme-app-front-wt-free-talk-640',
      '../mobile-wt-free-talk-640',
      ' ',
      '✓ answers pre-filled → agent confirms, no re-ask',
    ]);
  });

  it('refuses a title over 80 characters (warning, Start disabled)', () => {
    const long = form({ name: 'A'.repeat(81), solutions: ['mobile'] });
    expect(titleTooLong(long)).toBe(true);
    expect(canStart(long, [])).toBe(false);
    expect(summaryLines(long, '/ws', []).map((l) => l.text)).toContain(TITLE_TOO_LONG);
    expect(titleTooLong(form({ name: ` ${'A'.repeat(80)} ` }))).toBe(false);
  });

  it('a scheduled run keeps the schedule name rules: as typed, no title, a taken schedule name blocks Save', () => {
    const preview = cronPreview('0 2 * * *', new Date(2026, 8, 28, 1, 0));
    const scheduled = form({ name: 'nightly-check', task: 'Check.', solutions: ['mobile'] });
    expect(toScheduleInput(scheduled, '0 2 * * *', undefined).template).not.toHaveProperty('title');
    expect(canSaveSchedule(scheduled, preview, ['nightly-check'])).toBe(false);
    expect(canSaveSchedule(scheduled, preview, [])).toBe(true);
    const lines = scheduleSummaryLines(scheduled, '/ws', preview, []).map((l) => l.text);
    expect(lines.some((t) => t.startsWith('branch'))).toBe(false);
    expect(lines).toContain('../mobile-wt-nightly-check-0928-0200');
  });
});

describe('rename in place (D22)', () => {
  const titled = { id: 's1', name: 'jira-ticket-handling', title: 'JIRA Ticket handling', displayTitle: 'JIRA Ticket handling' };
  const plain = { id: 's2', name: 'free-talk-640', title: null, displayTitle: 'free-talk-640' };

  it('opens with what the session shows', () => {
    expect(titleDraft(titled)).toBe('JIRA Ticket handling');
    expect(titleDraft(plain)).toBe('free-talk-640');
  });

  it('saves the trimmed text; nothing for the same text; an emptied field clears a title', () => {
    expect(titleEditOutcome('  Billing: fix invoices ', titled)).toEqual({ kind: 'save', title: 'Billing: fix invoices' });
    expect(titleEditOutcome(' JIRA Ticket handling ', titled)).toEqual({ kind: 'unchanged' });
    expect(titleEditOutcome('free-talk-640', plain)).toEqual({ kind: 'unchanged' });
    expect(titleEditOutcome('   ', titled)).toEqual({ kind: 'save', title: null });
    expect(titleEditOutcome('', plain)).toEqual({ kind: 'unchanged' });
    // The length rule is the server's: an 81-character title is sent and refused there.
    expect(titleEditOutcome('x'.repeat(81), plain)).toEqual({ kind: 'save', title: 'x'.repeat(81) });
  });

  it("shows the server's refusal", () => {
    expect(renameErrorText(422, { error: 'invalid', errors: [{ field: 'title', message: TITLE_RULE }] })).toBe(`Not renamed: ${TITLE_RULE}`);
    expect(renameErrorText(404, { error: 'not-found', message: 'no session s9' })).toBe('Not renamed: no session s9');
    expect(renameErrorText(500, null)).toBe('Not renamed: HTTP 500');
    expect(renameErrorText(0, null)).toBe('Not renamed: Switchboard is not reachable.');
  });

  it('the tooltip shows the whole title, the short name behind it, and how to rename', () => {
    expect(titleTooltip(titled, 'click')).toBe('JIRA Ticket handling (jira-ticket-handling) · click to rename');
    expect(titleTooltip(titled, 'double-click')).toBe('JIRA Ticket handling (jira-ticket-handling) · double-click to rename');
    expect(titleTooltip(plain, 'double-click')).toBe('free-talk-640 · double-click to rename');
  });
});

describe('display titles where a session is named (D22)', () => {
  it('the palette lists the title and finds the session by its title or its name', () => {
    const sessions = [session(), session({ id: 's2', name: 'free-talk-640', title: null, displayTitle: 'free-talk-640' })];
    const entries = paletteEntries({ sessions, tools: null, solutions: null }).filter((e) => e.kind === 'session');
    expect(entries.map((e) => e.label)).toEqual(['JIRA Ticket handling', 'free-talk-640']);
    expect(filterPalette(entries, 'ticket hand').map((e) => e.key)).toEqual(['session:s1']);
    expect(filterPalette(entries, 'jira-ticket').map((e) => e.key)).toEqual(['session:s1']);
    expect(filterPalette(entries, 'free-talk').map((e) => e.key)).toEqual(['session:s2']);
    // An older payload without the fields still shows the name.
    const { title: _t, displayTitle: _d, ...old } = session({ id: 's3', name: 'old-one' });
    expect(paletteEntries({ sessions: [old as Session], tools: null, solutions: null }).find((e) => e.kind === 'session')?.label).toBe('old-one');
  });

  it('loop cards, the move dialog and the question toast use the title', () => {
    const loop: Loop = {
      id: 'l1',
      sessionId: 's1',
      kind: '/loop',
      label: null,
      iteration: null,
      cap: null,
      breakerCount: null,
      breakerState: null,
      nextFireAt: null,
      expiresAt: null,
      iterations: [],
      progressPath: null,
      note: null,
      createdAt: '2026-09-28T09:00:00.000Z',
      updatedAt: '2026-09-28T09:00:00.000Z',
    };
    expect(loopCards([session({ loops: [loop] })], new Date('2026-09-28T10:00:00.000Z'))[0]?.sessionName).toBe('JIRA Ticket handling');
    expect(movedState(session())).toEqual({ kind: 'moved', sessionId: 's1', name: 'JIRA Ticket handling' });
    expect(movedState({ id: 's2', name: 'sb-handoff' })).toEqual({ kind: 'moved', sessionId: 's2', name: 'sb-handoff' });

    const event = { sessionId: 's1', batchId: 'b1', questions: [] };
    const item: InboxItem = {
      id: 'b1',
      kind: 'questions',
      sessionId: 's1',
      source: 'jira-ticket-handling',
      sourceTitle: 'JIRA Ticket handling',
      status: 'need',
      title: 'Which one?',
      label: 'Question',
      detail: '',
      createdAt: '2026-09-28T09:00:00.000Z',
      branches: [],
    };
    expect(questionNotice(event, item, null).toast.title).toBe('JIRA Ticket handling');
    expect(questionNotice(event, item, null).os.title).toBe('JIRA Ticket handling needs you');
    expect(questionNotice(event, null, 'JIRA Ticket handling').toast.title).toBe('JIRA Ticket handling');
  });
});
