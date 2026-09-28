import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../../src/core/api.ts';
import type { FormFolder } from '../../src/web/modals/new-session.ts';
import { canStartResume, resumeEntryMeta, resumeNamePreview, resumeNameProblem, resumePickOf, resumeSummaryLines } from '../../src/web/modals/resume-conversation.ts';

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
const FOLDER: FormFolder = { id: 'f1', path: '/ws', name: 'ws', kind: 'workspace' };

describe('resume a terminal conversation (D16)', () => {
  it('picks a row; its entry reads title, then date · first prompt', () => {
    const pick = resumePickOf(ROW);
    expect(pick).toEqual({ claudeSessionId: 'c1', name: 'Code word check', startedAt: ROW.startedAt, firstPrompt: ROW.firstPrompt, cwd: ROW.cwd, folder: 'f1' });
    expect(resumeEntryMeta(ROW)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} · Remember the code word: marigold\.$/);
    expect(resumeEntryMeta({ ...ROW, firstPrompt: null })).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('names: the preview from the title (unique), a typed name must be kebab-case and free', () => {
    expect(resumeNamePreview(ROW, [])).toBe('code-word-check');
    expect(resumeNamePreview(ROW, ['code-word-check'])).toBe('code-word-check-2');
    expect(resumeNameProblem('', ['x'])).toBeNull();
    expect(resumeNameProblem('Bad Name', [])).toBe('⚠ the name must be kebab-case (a-z, 0-9, single dashes)');
    expect(resumeNameProblem('taken', ['taken'])).toBe('⚠ a session with this name exists');
    expect(canStartResume(resumePickOf(ROW), '', [])).toBe(true);
    expect(canStartResume(resumePickOf(ROW), 'taken', ['taken'])).toBe(false);
    expect(canStartResume(null, '', [])).toBe(false);
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
    const taken = resumeSummaryLines(resumePickOf(ROW), null, 'mine', ['mine']);
    expect(taken.map((line) => line.text)).toContain('⚠ a session with this name exists');
    expect(taken.map((line) => line.text)).toContain('name      mine');
  });
});
