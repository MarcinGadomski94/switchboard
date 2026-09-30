import { describe, expect, it } from 'vitest';
import { MESSAGE_TITLE_MAX, simpleBranchFromTitle, simpleBranchOfName, simpleShortName, simpleTitle, titleFromMessage } from '../../src/core/simple-session.ts';
import { readKnownSettings } from '../../src/core/settings.ts';
import type { FolderCheck } from '../../src/core/api.ts';
import { FOLDER_KIND_LABEL, PLAIN_CHECK_LINE, folderCheckLine } from '../../src/web/folders/folders.ts';
import {
  DEFAULT_FORM,
  type FormFolder,
  type NewSessionForm,
  PLAIN_FOLDER_FULL_NOTE,
  PLAIN_FOLDER_SCHEDULE_NOTE,
  canStart,
  formComplete,
  isPlainFolder,
  toStartBody,
} from '../../src/web/modals/new-session.ts';
import { canSaveSchedule, cronPreview } from '../../src/web/modals/schedule-form.ts';
import { needsFolderText } from '../../src/web/views/history-move.ts';
import { FOLDER_ROOT, rootPath } from '../../src/web/views/session/right-panel.ts';
import { placeLabel } from '../../src/web/views/session/session-header.ts';
import {
  PLAIN_NOTE,
  WORKSPACE_NOTE,
  branchProblem,
  canStartSimple,
  isStartShortcut,
  offersModeToggle,
  offersWorktree,
  openingMode,
  simpleBlockers,
  simpleBranch,
  simpleNames,
  startShortcutLabel,
  titlePlaceholder,
  toSimpleBody,
  usesWorktree,
  whereLine,
} from '../../src/web/modals/simple-session.ts';

/**
 * D56 · the simple New-session form (pure parts; the real path is
 * tests/e2e/simple-session.spec.ts): the mode it opens in (Simple on a fresh
 * install, the remembered one, Full for a schedule or a prefill), the fields and
 * what they send, the title and short name from the message, the worktree
 * branch slug, the Start rule, the shortcut, and the carry-over between modes
 * (one form state: what the simple form typed is what the Full form shows).
 */

const WORKSPACE: FormFolder = { id: 'ws', path: '/work/acme', name: 'acme', displayName: 'acme', kind: 'workspace' };
const REPO: FormFolder = { id: 'rp', path: '/work/solo', name: 'solo', displayName: 'solo', kind: 'repo' };

function form(patch: Partial<NewSessionForm> = {}): NewSessionForm {
  return { ...DEFAULT_FORM, folder: 'ws', ...patch };
}

describe('D56 · the mode the dialog opens in', () => {
  it('Simple on a fresh install (nothing stored, or the settings cannot be read), else the remembered mode', () => {
    expect(readKnownSettings({})['newSession.mode']).toBe('simple');
    expect(openingMode({ scheduling: false, prefill: null }, null)).toBe('simple');
    expect(openingMode({ scheduling: false, prefill: null }, {})).toBe('simple');
    expect(openingMode({ scheduling: false, prefill: null }, { 'newSession.mode': 'full' })).toBe('full');
    expect(openingMode({ scheduling: false, prefill: null }, { 'newSession.mode': 'simple' })).toBe('simple');
    expect(openingMode({ scheduling: false, prefill: null }, { 'newSession.mode': 'wizard' })).toBe('simple');
  });

  it('a schedule and a prefill ("Open fix session", a schedule\'s Edit) open Full; a schedule has no switch', () => {
    expect(openingMode({ scheduling: true, prefill: null }, { 'newSession.mode': 'simple' })).toBe('full');
    expect(openingMode({ scheduling: false, prefill: { task: 'Fix it.', workType: 'feature' } }, { 'newSession.mode': 'simple' })).toBe('full');
    expect(offersModeToggle(true)).toBe(false);
    expect(offersModeToggle(false)).toBe(true);
  });
});

describe('D56 · title and short name from the message', () => {
  it('the title field wins; empty, the message\'s first line with text (whitespace collapsed) is the title', () => {
    expect(titleFromMessage('  Fix the login redirect.\nMore details here.')).toBe('Fix the login redirect.');
    expect(titleFromMessage('\n\n   \n  Tidy   the\tREADME  \n')).toBe('Tidy the README');
    expect(titleFromMessage('   ')).toBe('');
    expect(simpleTitle('  My title ', 'Something else')).toBe('My title');
    expect(simpleTitle('', 'Something else')).toBe('Something else');
    expect(simpleNames(form({ name: '', task: 'Fix the login redirect.' }), [])).toEqual({ name: 'fix-the-login-redirect', title: 'Fix the login redirect.' });
    expect(simpleNames(form({ name: 'JIRA Ticket handling', task: 'x' }), [])).toEqual({ name: 'jira-ticket-handling', title: 'JIRA Ticket handling' });
  });

  it('a long first line is cut to whole words (at most 60 characters, with …); a taken short name gets -2; nothing typed = session, no title', () => {
    const long = 'Refactor the payment reconciliation job so that it retries failed transfers with backoff';
    const title = titleFromMessage(long);
    expect(title).toBe('Refactor the payment reconciliation job so that it retries…');
    expect(title.length).toBeLessThanOrEqual(MESSAGE_TITLE_MAX);
    expect(titleFromMessage('x'.repeat(100))).toBe(`${'x'.repeat(MESSAGE_TITLE_MAX - 1)}…`);
    expect(simpleShortName('', 'Fix login', ['fix-login'])).toBe('fix-login-2');
    expect(simpleNames(form({ name: '', task: '' }), [])).toEqual({ name: 'session', title: null });
  });

  it('the title field\'s placeholder is the title the message gives', () => {
    expect(titlePlaceholder(form({ task: 'Fix login\nand more' }))).toBe('Fix login');
    expect(titlePlaceholder(form({ task: '' }))).toBe('Title (optional): taken from the message');
  });
});

describe('D56 · own worktree and its branch', () => {
  it('offered only for a git repo folder; a workspace folder works in place', () => {
    expect(offersWorktree(REPO)).toBe(true);
    expect(offersWorktree(WORKSPACE)).toBe(false);
    expect(offersWorktree(null)).toBe(false);
    expect(usesWorktree(form({ worktrees: true }), REPO)).toBe(true);
    expect(usesWorktree(form({ worktrees: false }), REPO)).toBe(false);
    expect(usesWorktree(form({ worktrees: true }), WORKSPACE)).toBe(false);
  });

  it('the branch is a plain slug of the title (sb/<short name>), a ticket title keeps D32\'s pre-fill, an edit wins', () => {
    expect(simpleBranchOfName('fix-login')).toBe('sb/fix-login');
    expect(simpleBranch(form({ name: 'Fix login' }), null, [])).toBe('sb/fix-login');
    expect(simpleBranch(form({ name: '', task: 'Fix login\nsteps' }), null, ['fix-login'])).toBe('sb/fix-login-2');
    expect(simpleBranch(form({ name: 'PROJ-1984 Purchase complete' }), null, [])).toBe('PROJ-1984-purchase-complete');
    expect(simpleBranchFromTitle('proj-7 tidy', 'proj-7-tidy')).toBe('PROJ-7-tidy');
    expect(simpleBranch(form({ name: 'Fix login' }), 'my/branch', [])).toBe('my/branch');
  });

  it('any valid git branch name is fine (no ticket rule); an invalid one is a problem', () => {
    expect(branchProblem('sb/fix-login')).toBeNull();
    expect(branchProblem('feature/anything_goes.1')).toBeNull();
    expect(branchProblem('')).toBe('name the branch, e.g. sb/short-description');
    expect(branchProblem('bad..name')).toBe('the branch must be a valid git branch name, e.g. sb/short-description');
    expect(branchProblem('has space')).not.toBeNull();
  });
});

describe('D56 · Start and the body', () => {
  it('Start waits for a folder and a message; a title over 80 characters and a bad branch (with a worktree) block it', () => {
    const start = (patch: Partial<NewSessionForm>, folder: FormFolder | null = WORKSPACE, branch: string | null = null) => ({ form: form(patch), folder, branch, takenNames: [] });
    expect(simpleBlockers(start({ task: '' }))).toEqual(['type the message']);
    expect(canStartSimple(start({ task: '  ' }))).toBe(false);
    expect(simpleBlockers(start({ task: 'Go' }, null))).toEqual(['pick a folder']);
    expect(canStartSimple(start({ task: 'Go' }))).toBe(true);
    expect(simpleBlockers(start({ task: 'Go', name: 'x'.repeat(81) }))).toEqual(['the title must be at most 80 characters']);
    expect(canStartSimple(start({ task: 'Go', worktrees: true }, REPO, 'bad..name'))).toBe(false);
    // The same bad branch does not matter without a worktree (or in a workspace).
    expect(canStartSimple(start({ task: 'Go', worktrees: false }, REPO, 'bad..name'))).toBe(true);
    expect(canStartSimple(start({ task: 'Go', worktrees: true }, WORKSPACE, 'bad..name'))).toBe(true);
  });

  it('a workspace folder: simple, the short name, the title, the message as the task, no worktree, no router fields, no solutions', () => {
    const body = toSimpleBody({ form: form({ task: '  Fix the login redirect.\nDetails.  ', worktrees: true }), folder: WORKSPACE, branch: null, takenNames: [] });
    expect(body).toEqual({ simple: true, name: 'fix-the-login-redirect', task: 'Fix the login redirect.\nDetails.', folder: 'ws', worktrees: false, title: 'Fix the login redirect.' });
    expect(Object.keys(body)).not.toContain('workType');
    expect(Object.keys(body)).not.toContain('solutions');
    expect(Object.keys(body)).not.toContain('branching');
  });

  it('a repo folder with its own worktree sends the branch; D42\'s model / effort when chosen', () => {
    const f = form({ folder: 'rp', name: 'Tidy README', task: 'Tidy the README.', worktrees: true, model: { model: 'opus', effort: 'high' } });
    expect(toSimpleBody({ form: f, folder: REPO, branch: null, takenNames: [] })).toEqual({
      simple: true,
      name: 'tidy-readme',
      task: 'Tidy the README.',
      folder: 'rp',
      worktrees: true,
      title: 'Tidy README',
      branch: 'sb/tidy-readme',
      model: 'opus',
      effort: 'high',
    });
    expect(toSimpleBody({ form: f, folder: REPO, branch: ' my/edited ', takenNames: [] })).toMatchObject({ branch: 'my/edited' });
    expect(toSimpleBody({ form: { ...f, worktrees: false }, folder: REPO, branch: null, takenNames: [] })).not.toHaveProperty('branch');
  });

  it('the where line: the folder, or the repo\'s worktree folder; the workspace note says nothing is pre-answered', () => {
    expect(whereLine({ form: form({ task: 'x' }), folder: WORKSPACE, takenNames: [] })).toBe('Runs in /work/acme');
    expect(whereLine({ form: form({ name: 'Tidy', worktrees: true }), folder: REPO, takenNames: [] })).toBe('Runs in /work/solo-wt-tidy');
    expect(whereLine({ form: form({ name: 'Tidy', worktrees: false }), folder: REPO, takenNames: [] })).toBe('Runs in /work/solo');
    expect(WORKSPACE_NOTE).toContain('No session-start answers');
  });

  it('⌘↩ / Ctrl+↩ starts; plain Enter (a new line in the message), Shift and Alt, and composing do not', () => {
    const press = (patch: Partial<Parameters<typeof isStartShortcut>[0]>) => ({ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...patch });
    expect(isStartShortcut(press({ metaKey: true }))).toBe(true);
    expect(isStartShortcut(press({ ctrlKey: true }))).toBe(true);
    expect(isStartShortcut(press({}))).toBe(false);
    expect(isStartShortcut(press({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isStartShortcut(press({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isStartShortcut(press({ metaKey: true, isComposing: true }))).toBe(false);
    expect(isStartShortcut(press({ key: 'a', metaKey: true }))).toBe(false);
    expect(startShortcutLabel('MacIntel')).toBe('⌘↩');
    expect(startShortcutLabel('Win32')).toBe('Ctrl+↩');
  });
});

describe('D56 · carry-over between Simple and Full (one form state)', () => {
  it('folder, message, title, model and worktree typed in Simple are the Full form\'s task, name, folder, model and Worktree', () => {
    // What the simple form wrote into the shared state.
    const typed = form({ folder: 'rp', task: 'Tidy the README.', name: 'PROJ-12 Tidy readme', model: { model: 'sonnet', effort: null }, worktrees: false });
    const full = toStartBody(typed, REPO, []);
    expect(full).toMatchObject({ name: 'proj-12-tidy-readme', title: 'PROJ-12 Tidy readme', task: 'Tidy the README.', folder: 'rp', worktrees: false, model: 'sonnet', effort: null });
    // And back: the Full form's typed values are what the simple form sends.
    const back = toSimpleBody({ form: { ...typed, worktrees: true }, folder: REPO, branch: null, takenNames: [] });
    expect(back).toMatchObject({ name: 'proj-12-tidy-readme', title: 'PROJ-12 Tidy readme', task: 'Tidy the README.', folder: 'rp', worktrees: true, branch: 'PROJ-12-tidy-readme', model: 'sonnet' });
  });

  it('the simple form\'s edited branch is kept apart: the Full form\'s D32 Branch field still follows the title', () => {
    const typed = form({ folder: 'rp', name: 'PROJ-12 Tidy readme', task: 'x', worktrees: true });
    expect(toSimpleBody({ form: typed, folder: REPO, branch: 'sb/other', takenNames: [] })).toMatchObject({ branch: 'sb/other' });
    expect(toStartBody(typed, REPO, [])).toMatchObject({ branch: 'PROJ-12-tidy-readme' });
  });
});

describe('D59 · a plain folder (no AGENTS.md, not a git repository)', () => {
  const PLAIN: FormFolder = { id: 'pl', path: '/Users/dev/notes', name: 'notes', displayName: 'notes', kind: 'plain' };
  const plainCheck: FolderCheck = { path: '/Users/dev/notes', canonicalPath: '/Users/dev/notes', exists: true, kind: 'plain', router: null, solutionCount: 0, repoName: null, problem: null, message: '' };

  it('Simple starts there: no worktree offered (even when the shared form has it on), the message alone, runs in the folder', () => {
    expect(offersWorktree(PLAIN)).toBe(false);
    const f = form({ folder: 'pl', task: 'Sort my notes.', worktrees: true });
    expect(usesWorktree(f, PLAIN)).toBe(false);
    expect(simpleBlockers({ form: f, folder: PLAIN, branch: 'bad..name', takenNames: [] })).toEqual([]);
    expect(canStartSimple({ form: f, folder: PLAIN, branch: null, takenNames: [] })).toBe(true);
    expect(toSimpleBody({ form: f, folder: PLAIN, branch: null, takenNames: [] })).toEqual({ simple: true, name: 'sort-my-notes', task: 'Sort my notes.', folder: 'pl', worktrees: false, title: 'Sort my notes.' });
    expect(whereLine({ form: f, folder: PLAIN, takenNames: [] })).toBe('Runs in /Users/dev/notes');
    expect(PLAIN_NOTE).toBe('A plain folder (no AGENTS.md, not a git repository): Claude runs here with your message alone.');
  });

  it('Full cannot start (or save a schedule) there; its note offers Simple', () => {
    const f = form({ folder: 'pl', task: 'Sort my notes.', name: 'notes' });
    expect(isPlainFolder(PLAIN)).toBe(true);
    expect(isPlainFolder(REPO)).toBe(false);
    expect(formComplete(f, PLAIN)).toBe(false);
    expect(canStart(f, [], PLAIN)).toBe(false);
    expect(canStart({ ...f, worktrees: false }, [], REPO)).toBe(true);
    expect(canSaveSchedule({ ...f, name: 'nightly' }, cronPreview('0 2 * * *', new Date('2026-09-30T10:00:00Z')), [], PLAIN)).toBe(false);
    expect(PLAIN_FOLDER_FULL_NOTE).toContain('Use Simple');
    expect(PLAIN_FOLDER_SCHEDULE_NOTE).not.toContain('Use Simple');
  });

  it('a typed or browsed plain path checks as a folder (the Add button saves it); the kind reads "folder"; its sessions read "folder"', () => {
    expect(folderCheckLine(plainCheck)).toEqual({ ok: true, text: PLAIN_CHECK_LINE });
    expect(PLAIN_CHECK_LINE).toBe('✓ folder · no AGENTS.md, not a git repo · Simple sessions');
    expect(FOLDER_KIND_LABEL.plain).toBe('folder');
    expect(placeLabel({ cwd: '/Users/dev/notes', folderPath: '/Users/dev/notes', folderKind: 'plain' })).toBe('folder');
    expect(rootPath({ folderKind: 'plain', folderPath: '/Users/dev/notes' })).toBe(FOLDER_ROOT);
    expect(needsFolderText(plainCheck)).toBe('No saved folder holds this conversation. It sits in the folder /Users/dev/notes.');
  });
});
