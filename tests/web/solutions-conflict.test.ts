import { describe, expect, it } from 'vitest';
import type { ConflictSession, Solution } from '../../src/core/api.ts';
import { createDemoProviders } from '../../src/server/demo/providers.ts';
import { loadDemoData } from '../../src/server/demo/data.ts';
import { ApiError } from '../../src/web/api/client.ts';
import { MOVE_CONFIRM, conflictCard, isolateErrorText, moveConfirmText } from '../../src/web/views/solutions-conflict.ts';

function session(name: string, isolated: boolean, attached = true, title: string | null = null): ConflictSession {
  return { sessionId: `id-${name}`, name, title, isolated, repo: 'web-front', attached };
}

type CardInput = Pick<Solution, 'conflict' | 'conflictSessions' | 'relativePath'>;

describe('conflictCard (M6.3)', () => {
  it('no conflict → no card', () => {
    expect(conflictCard({ conflict: false, conflictSessions: [], relativePath: 'mobile' })).toBeNull();
    expect(conflictCard({ conflict: true, conflictSessions: [], relativePath: 'mobile' })).toBeNull();
  });

  it('one action per session in the main checkout, the isolated ones only named', () => {
    const input: CardInput = {
      conflict: true,
      conflictSessions: [session('with-wt', true), session('in-place', false), session('away', false, false)],
      relativePath: 'microfrontends/web-front',
    };
    expect(conflictCard(input)).toEqual({
      text: "with-wt, in-place and away all write to microfrontends/web-front/ in one working tree. Your AGENTS.md requires isolation: 'worktree' for parallel writers in the same repo.",
      actions: [
        { sessionId: 'id-in-place', repo: 'web-front', label: 'Move in-place to worktree', disabled: false, title: '', sessionTitle: 'in-place', suggestedBranch: '' },
        {
          sessionId: 'id-away',
          repo: 'web-front',
          label: 'Move away to worktree',
          disabled: true,
          title: 'away continues in a terminal; attach it here first',
          sessionTitle: 'away',
          suggestedBranch: '',
        },
      ],
    });
  });

  it('D22: the card and its buttons name a session by its title (else its name); the action still isolates by id', () => {
    const input: CardInput = {
      conflict: true,
      conflictSessions: [session('with-wt', true), session('jira-ticket-handling', false, true, 'JIRA Ticket handling'), session('away', false, false, 'Billing fixes')],
      relativePath: 'mobile',
    };
    expect(conflictCard(input)).toEqual({
      text: "with-wt, JIRA Ticket handling and Billing fixes all write to mobile/ in one working tree. Your AGENTS.md requires isolation: 'worktree' for parallel writers in the same repo.",
      actions: [
        {
          sessionId: 'id-jira-ticket-handling',
          repo: 'web-front',
          label: 'Move JIRA Ticket handling to worktree',
          disabled: false,
          title: '',
          sessionTitle: 'JIRA Ticket handling',
          suggestedBranch: '',
        },
        {
          sessionId: 'id-away',
          repo: 'web-front',
          label: 'Move Billing fixes to worktree',
          disabled: true,
          title: 'Billing fixes continues in a terminal; attach it here first',
          sessionTitle: 'Billing fixes',
          suggestedBranch: '',
        },
      ],
    });
  });

  it('the demo mobile row gives the prototype card verbatim', async () => {
    const { solutions } = createDemoProviders(await loadDemoData());
    const mobile = (await solutions.solutions({ id: 'demo', path: 'D:\\acme', root: 'D:\\acme', kind: 'workspace' })).flatMap((g) => g.solutions).find((s) => s.name === 'mobile');
    expect(mobile).toBeDefined();
    expect(conflictCard(mobile as Solution)).toEqual({
      text: "free-talk-feature and button-rollout both write to mobile/ in one working tree. Your AGENTS.md requires isolation: 'worktree' for parallel writers in the same repo.",
      actions: [{ sessionId: 'button-rollout', repo: 'mobile', label: 'Move button-rollout to worktree', disabled: false, title: '', sessionTitle: 'button-rollout', suggestedBranch: '' }],
    });
  });

  it('D32: the confirm step suggests the branch a ticket title gives, else nothing, and names the session and repo', () => {
    const input: CardInput = {
      conflict: true,
      conflictSessions: [session('proj-1984', false, true, 'PROJ-1984 Purchase complete'), session('plain', false, true, 'Plain work'), session('untitled', false)],
      relativePath: 'mobile',
    };
    const actions = conflictCard(input)?.actions ?? [];
    expect(actions.map((a) => a.suggestedBranch)).toEqual(['PROJ-1984-purchase-complete', '', '']);
    expect(moveConfirmText(actions[0] as (typeof actions)[number])).toBe('PROJ-1984 Purchase complete gets a new worktree of web-front. Name its branch after the ticket:');
    expect(MOVE_CONFIRM).toBe('Move to worktree');
  });
});

describe('isolateErrorText', () => {
  it('the server message, the first validation message, or a fallback', () => {
    expect(isolateErrorText(new ApiError(409, 'x', { error: 'detached', message: 'the session continues in a terminal; attach it first' }))).toBe(
      'the session continues in a terminal; attach it first',
    );
    expect(isolateErrorText(new ApiError(422, 'x', { error: 'invalid', errors: [{ field: 'repo', message: 'no solution nope' }] }))).toBe('no solution nope');
    expect(isolateErrorText(new ApiError(500, 'x', null))).toBe('The worktree could not be created (HTTP 500).');
    expect(isolateErrorText(new ApiError(0, 'x'))).toBe('Switchboard is not reachable.');
    expect(isolateErrorText(new Error('boom'))).toBe('boom');
  });
});
