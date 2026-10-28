import { describe, expect, it } from 'vitest';
import { parseDraftValue } from '../../src/core/drafts.ts';
import { DEFAULT_FORM } from '../../src/web/modals/new-session.ts';
import { NEW_WORDS } from '../../src/web/v2/glossary.ts';
import {
  DEFAULT_AGENT_FORM,
  DEFAULT_ROUTINE_FORM,
  DEFAULT_TASK_FORM,
  NEW_KINDS,
  agentBody,
  agentProblems,
  chatBody,
  conversationProblems,
  emptySheet,
  estimateLabel,
  foldersByRecent,
  opensDialog,
  parseSteps,
  projectProblems,
  routineBody,
  routineProblems,
  sheetDraft,
  sheetFromDraft,
  sheetFromRequest,
  sheetHasText,
  stepIndex,
  taskBody,
  taskProblems,
} from '../../src/web/v2/new/new-model.ts';

const repo = { id: 'f1', path: '/x/acme-checkout', name: 'acme-checkout', displayName: 'acme-checkout', kind: 'repo' as const };
const workspace = { id: 'f2', path: '/x/acme', name: 'acme', displayName: 'acme', kind: 'workspace' as const };
const plain = { id: 'f3', path: '/x/notes', name: 'notes', displayName: 'notes', kind: 'plain' as const };

describe('+ New · kinds', () => {
  it('has the prototype’s seven kinds in order, each with words', () => {
    expect(NEW_KINDS).toEqual(['agent', 'conversation', 'task', 'project', 'routine', 'teammate', 'crew', 'bring-in']);
    for (const kind of NEW_KINDS) expect(NEW_WORDS.kinds[kind].label.length).toBeGreaterThan(0);
  });
});

describe('+ New · agent', () => {
  const withTask = { ...DEFAULT_AGENT_FORM, form: { ...DEFAULT_FORM, task: 'Fix the login timeout', folder: 'f1' } };

  it('needs a folder and a message', () => {
    expect(agentProblems(DEFAULT_AGENT_FORM, null, [], false)).toEqual([NEW_WORDS.errors.folder, NEW_WORDS.errors.message]);
    expect(agentProblems(withTask, repo, [], false)).toEqual([]);
  });

  it('refuses an offline computer and an overlong title', () => {
    expect(agentProblems(withTask, repo, [], true)).toContain(NEW_WORDS.errors.computerOffline);
    expect(agentProblems({ ...withTask, form: { ...withTask.form, name: 'x'.repeat(500) } }, repo, [], false)[0]).toMatch(/At most/);
  });

  it('posts a Simple start by default, the Full one with the workspace questions', () => {
    const simple = agentBody(withTask, repo, [], null, 'claude') as unknown as Record<string, unknown>;
    expect(simple['simple']).toBe(true);
    expect(simple['task']).toBe('Fix the login timeout');
    expect(simple['folder']).toBe('f1');
    const full = agentBody({ ...withTask, askQuestions: true, form: { ...withTask.form, folder: 'f2' } }, workspace, [], null, 'claude') as unknown as Record<string, unknown>;
    expect(full['simple']).toBeUndefined();
    expect(full['workType']).toBe('feature');
  });

  it('never asks for a separate copy in a plain folder', () => {
    const body = agentBody({ ...withTask, form: { ...withTask.form, folder: 'f3' } }, plain, [], null, 'claude') as unknown as Record<string, unknown>;
    expect(body['worktrees']).toBe(false);
  });

  it('starts with the picked model and effort, else the engine’s last choice (D42), fitted to its models', () => {
    const models = { options: [{ value: 'default', label: 'Default (recommended)', efforts: ['low', 'high'] }, { value: 'opus', label: 'Opus 5.5', efforts: ['low', 'high', 'max'] }, { value: 'haiku', label: 'Haiku 4.5' }], last: { model: 'opus', effort: 'max' } };
    const picked = agentBody({ ...withTask, form: { ...withTask.form, model: { model: 'opus', effort: 'high' } } }, repo, [], models, 'claude') as unknown as Record<string, unknown>;
    expect(picked).toMatchObject({ model: 'opus', effort: 'high' });
    const last = agentBody(withTask, repo, [], models, 'claude') as unknown as Record<string, unknown>;
    expect(last).toMatchObject({ model: 'opus', effort: 'max' });
    // A model the engine no longer lists falls back to its default; an effort the model lacks to Default.
    const gone = agentBody({ ...withTask, form: { ...withTask.form, model: { model: 'claude-opus-3', effort: 'high' } } }, repo, [], models, 'claude') as unknown as Record<string, unknown>;
    expect(gone).toMatchObject({ model: null, effort: 'high' });
    const haiku = agentBody({ ...withTask, form: { ...withTask.form, model: { model: 'haiku', effort: 'high' } } }, repo, [], models, 'claude') as unknown as Record<string, unknown>;
    expect(haiku).toMatchObject({ model: 'haiku', effort: null });
    // Models not loaded yet: no model fields (the CLI's defaults).
    const loading = agentBody(withTask, repo, [], null, 'claude') as unknown as Record<string, unknown>;
    expect(loading['model']).toBeUndefined();
  });

  it('a conversation needs only the message', () => {
    expect(conversationProblems(DEFAULT_AGENT_FORM)).toEqual([NEW_WORDS.errors.message]);
    expect(chatBody(withTask, null, 'claude', ['a1'])).toEqual({ message: 'Fix the login timeout', attachments: ['a1'] });
    const codex = { options: [{ value: 'gpt-6', label: 'GPT-6', efforts: ['low', 'medium', 'high'] }], last: null };
    const chat = { ...withTask, form: { ...withTask.form, provider: 'codex' as const, model: { model: 'gpt-6', effort: 'medium' } } };
    expect(chatBody(chat, codex, 'codex', [])).toEqual({ message: 'Fix the login timeout', provider: 'codex', model: 'gpt-6', effort: 'medium' });
  });
});

describe('+ New · task, routine, project, teammate, crew', () => {
  it('a task needs a title and an agent; the body has No plan for an empty plan', () => {
    expect(taskProblems(DEFAULT_TASK_FORM)).toEqual({ title: NEW_WORDS.errors.title, agent: NEW_WORDS.errors.agent });
    const task = { ...DEFAULT_TASK_FORM, title: '  Empty  cart ', agent: 's1' };
    expect(taskProblems(task)).toEqual({});
    expect(taskBody(task)).toEqual({ title: 'Empty cart', description: null, plan: 'No plan', priority: 'medium', estimateMinutes: 30 });
    expect(estimateLabel(null)).toBe(NEW_WORDS.estimateNone);
    expect(estimateLabel(15)).toBe('15 min');
    expect(estimateLabel(120)).toBe('2 hours');
  });

  it('a routine takes a preset or a cron', () => {
    expect(routineProblems(DEFAULT_ROUTINE_FORM)).toEqual({ prompt: NEW_WORDS.errors.message, agent: NEW_WORDS.errors.agent });
    expect(routineBody({ ...DEFAULT_ROUTINE_FORM, prompt: 'Check the page', agent: 's1' })).toEqual({ prompt: 'Check the page', label: 'Check the page', cron: '0 8 * * *' });
    expect(routineBody({ ...DEFAULT_ROUTINE_FORM, prompt: 'p', preset: 'hourly' })).toMatchObject({ everyMinutes: 60 });
    expect(routineProblems({ prompt: 'p', agent: 's1', preset: 'custom', cron: 'nope' })).toEqual({ cron: NEW_WORDS.errors.cron });
    expect(routineBody({ prompt: 'p', agent: 's1', preset: 'custom', cron: ' 0  9 * * 1 ' })).toMatchObject({ cron: '0 9 * * 1' });
  });

  it('parses project steps with their order', () => {
    const steps = parseSteps('Saved cards\n- Card expiry reminders (after Saved cards)\n\n2. Tests for saved cards (after saved)\n');
    expect(steps).toEqual([
      { title: 'Saved cards', after: null },
      { title: 'Card expiry reminders', after: 'Saved cards' },
      { title: 'Tests for saved cards', after: 'saved' },
    ]);
    expect(stepIndex(steps, 1, 'Saved cards')).toBe(0);
    expect(stepIndex(steps, 2, 'saved')).toBe(0);
    expect(stepIndex(steps, 0, 'Saved cards')).toBe(-1);
    expect(projectProblems({ title: '', owner: '', steps: ' ' })).toEqual({ title: NEW_WORDS.errors.title, owner: NEW_WORDS.errors.agent, steps: NEW_WORDS.errors.steps });
  });

  it('Teammate and Crew hand over to the Crews dialogs (lane X: one New teammate / New crew) and From a terminal to the bring-in list (D16); the rest are the sheet’s forms', () => {
    expect(NEW_KINDS.filter(opensDialog)).toEqual(['teammate', 'crew', 'bring-in']);
    expect(NEW_KINDS.filter((kind) => !opensDialog(kind))).toEqual(['agent', 'conversation', 'task', 'project', 'routine']);
  });
});

describe('+ New · drafts (the new-session machine draft)', () => {
  it('round-trips every kind through the server’s draft check', () => {
    const cases = [
      { ...emptySheet('task'), task: { ...DEFAULT_TASK_FORM, title: 'Empty cart', description: 'Below 400 px' } },
      { ...emptySheet('routine'), routine: { ...DEFAULT_ROUTINE_FORM, prompt: 'Check the page' } },
      { ...emptySheet('project'), project: { title: 'PROJ-200', owner: 's1', steps: 'One\nTwo' } },
      { ...emptySheet('agent'), agent: { ...DEFAULT_AGENT_FORM, form: { ...DEFAULT_FORM, task: 'Hello' } } },
    ];
    for (const sheet of cases) {
      expect(sheetHasText(sheet)).toBe(true);
      const parsed = parseDraftValue<'new-session'>('new-session', sheetDraft(sheet));
      expect(parsed).not.toBeNull();
      const back = sheetFromDraft(parsed?.form ?? {});
      expect(back.kind).toBe(sheet.kind);
    }
    const task = sheetFromDraft(parseDraftValue<'new-session'>('new-session', sheetDraft(cases[0]!))!.form);
    expect(task.task.title).toBe('Empty cart');
    expect(task.task.description).toBe('Below 400 px');
    const agent = sheetFromDraft(parseDraftValue<'new-session'>('new-session', sheetDraft(cases[3]!))!.form);
    expect(agent.agent.form.task).toBe('Hello');
  });

  it('an empty sheet is not worth a draft; a classic draft opens as an agent', () => {
    expect(sheetHasText(emptySheet('agent'))).toBe(false);
    expect(sheetFromDraft({ task: 'from classic' }).kind).toBe('agent');
    // A crew or teammate draft from before the Crews dialogs took over opens as an agent.
    expect(sheetFromDraft({ newKind: 'crew', name: 'Acme Growth' }).kind).toBe('agent');
  });

  it('opens from a request with its text and computer', () => {
    const sheet = sheetFromRequest('task', 'Fix the banner', null, 'm2');
    expect(sheet.task.title).toBe('Fix the banner');
    expect(sheet.agent.machine).toBe('m2');
    expect(sheetFromRequest('agent', 'Do it', null, null).agent.form.task).toBe('Do it');
  });

  it('lists folders by last use, never-used last', () => {
    const list = foldersByRecent([
      { displayName: 'b', lastUsedAt: null },
      { displayName: 'a', lastUsedAt: '2026-10-01T00:00:00Z' },
      { displayName: 'c', lastUsedAt: '2026-10-20T00:00:00Z' },
      { displayName: 'a2', lastUsedAt: null },
    ]);
    expect(list.map((f) => f.displayName)).toEqual(['c', 'a', 'a2', 'b']);
  });
});
