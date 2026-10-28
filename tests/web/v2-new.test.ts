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
  speedModel,
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
    const simple = agentBody(withTask, repo, [], null) as unknown as Record<string, unknown>;
    expect(simple['simple']).toBe(true);
    expect(simple['task']).toBe('Fix the login timeout');
    expect(simple['folder']).toBe('f1');
    const full = agentBody({ ...withTask, askQuestions: true, form: { ...withTask.form, folder: 'f2' } }, workspace, [], null) as unknown as Record<string, unknown>;
    expect(full['simple']).toBeUndefined();
    expect(full['workType']).toBe('feature');
  });

  it('never asks for a separate copy in a plain folder', () => {
    const body = agentBody({ ...withTask, form: { ...withTask.form, folder: 'f3' } }, plain, [], null) as unknown as Record<string, unknown>;
    expect(body['worktrees']).toBe(false);
  });

  it('maps Smart / Fast and the thinking depth to a model and effort', () => {
    // Lane X: the shared mapping (Smart = Opus, as on Home and in the agent panel).
    expect(speedModel('smart', 'normal', 'claude', null)).toEqual({ model: 'opus', effort: null });
    expect(speedModel('smart', 'deep', 'claude', null)).toEqual({ model: 'opus', effort: 'high' });
    expect(speedModel('smart', 'normal', 'codex', null)).toEqual({ model: null, effort: null });
    expect(speedModel('fast', 'normal', 'claude', null)).toEqual({ model: 'sonnet', effort: null });
    expect(speedModel('fast', 'normal', 'codex', [{ value: 'default' }, { value: 'gpt-5-mini' }])).toEqual({ model: 'gpt-5-mini', effort: null });
    expect(speedModel('fast', 'normal', 'codex', null)).toEqual({ model: null, effort: null });
    expect(speedModel('fast', 'deep', 'claude', null, 'opus')).toEqual({ model: 'opus', effort: 'high' });
    const body = agentBody({ ...withTask, speed: 'fast' }, repo, [], null) as unknown as Record<string, unknown>;
    expect(body['model']).toBe('sonnet');
  });

  it('a conversation needs only the message', () => {
    expect(conversationProblems(DEFAULT_AGENT_FORM)).toEqual([NEW_WORDS.errors.message]);
    expect(chatBody(withTask, null, ['a1'])).toEqual({ message: 'Fix the login timeout', attachments: ['a1'], model: 'opus', effort: null });
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
