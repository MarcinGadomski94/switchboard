import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../../src/core/api.ts';
import type { FormFolder } from '../../src/web/modals/new-session.ts';
import { TITLE_TOO_LONG } from '../../src/web/modals/new-session.ts';
import { canStartResume, resumeEntryMeta, resumeNamePreview, resumeNameProblem, resumeNames, resumePickOf, resumeSummaryLines } from '../../src/web/modals/resume-conversation.ts';

/** D16: "Resume a terminal conversation" in the New-session form (`src/web/modals/resume-conversation.ts`). */

const ROW: HistoryItem = {
  claudeSessionId: 'c1',
  sessionId: null,
  startedAt: '2026-09-27T21:41:00.000Z',
  name: 'Code word check',
  mode: 'terminal',
  summary: 'marigold',
  branches: [],
  solutions: [],
  outcome: 'ended',
  status: 'idle',
  folder: 'f1',
  folderPath: '/ws',
  terminal: true,
  firstPrompt: 'Remember the code word: marigold.',
  cwd: '/ws/other/handoff-mid',
};
const FOLDER: FormFolder = { id: 'f1', path: '/ws', name: 'ws', displayName: 'ws', kind: 'workspace' };

describe('resume a terminal conversation (D16)', () => {
  it('picks a row; its entry reads title, then date · first prompt', () => {
    const pick = resumePickOf(ROW);
    expect(pick).toEqual({ claudeSessionId: 'c1', name: 'Code word check', startedAt: ROW.startedAt, firstPrompt: ROW.firstPrompt, cwd: ROW.cwd, folder: 'f1' });
    expect(resumeEntryMeta(ROW)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} · Remember the code word: marigold\.$/);
    expect(resumeEntryMeta({ ...ROW, firstPrompt: null })).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('names: the preview from the title (unique); D22: typed free text is the title, its short name derived (-2 when taken)', () => {
    expect(resumeNamePreview(ROW, [])).toBe('code-word-check');
    expect(resumeNamePreview(ROW, ['code-word-check'])).toBe('code-word-check-2');
    // An empty field: the D16 name, no title of its own (the service keeps the conversation's title).
    expect(resumeNames(ROW, ' ', [])).toEqual({ name: 'code-word-check', title: null });
    expect(resumeNames(ROW, 'Lantern follow-up', [])).toEqual({ name: 'lantern-follow-up', title: 'Lantern follow-up' });
    expect(resumeNames(ROW, 'Lantern follow-up', ['lantern-follow-up'])).toEqual({ name: 'lantern-follow-up-2', title: 'Lantern follow-up' });
    expect(resumeNames(ROW, 'taken', ['taken'])).toEqual({ name: 'taken-2', title: 'taken' });
    // Free text is fine (no kebab-case rule, a taken name gets -2); only a title over 80 characters is refused.
    expect(resumeNameProblem('')).toBeNull();
    expect(resumeNameProblem('Bad Name')).toBeNull();
    expect(resumeNameProblem('x'.repeat(80))).toBeNull();
    expect(resumeNameProblem('x'.repeat(81))).toBe(TITLE_TOO_LONG);
    expect(canStartResume(resumePickOf(ROW), '')).toBe(true);
    expect(canStartResume(resumePickOf(ROW), 'Bad Name')).toBe(true);
    expect(canStartResume(resumePickOf(ROW), 'x'.repeat(81))).toBe(false);
    expect(canStartResume(null, '')).toBe(false);
  });

  it('the summary: folder, cwd, resume command, name, what happens', () => {
    expect(resumeSummaryLines(resumePickOf(ROW), FOLDER, '', []).map((line) => [line.tone, line.text])).toEqual([
      ['comment', '# claude code · background · Max'],
      ['value', 'folder    ws · workspace'],
      ['value', 'cwd       /ws/other/handoff-mid'],
      ['value', 'resume    claude --resume c1'],
      ['value', 'name      code-word-check'],
      ['value', ' '],
      ['comment', '# moves the terminal conversation · no first message'],
      ['value', ' '],
      ['ok', '✓ same conversation · history imported · idle'],
    ]);
    // D22: typed text names the session by its derived short name; no kebab-case or taken-name warning.
    const typed = resumeSummaryLines(resumePickOf(ROW), null, 'Mine, please', ['mine-please']).map((line) => line.text);
    expect(typed).toContain('name      mine-please-2');
    expect(typed.filter((text) => text.startsWith('⚠'))).toEqual([]);
    expect(resumeSummaryLines(resumePickOf(ROW), null, 'x'.repeat(81), []).map((line) => line.text)).toContain(TITLE_TOO_LONG);
  });
});
