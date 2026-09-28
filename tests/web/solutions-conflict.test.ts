import { describe, expect, it } from 'vitest';
import type { ConflictSession, Solution } from '../../src/core/api.ts';
import { createDemoProviders } from '../../src/server/demo/providers.ts';
import { loadDemoData } from '../../src/server/demo/data.ts';
import { ApiError } from '../../src/web/api/client.ts';
import { conflictCard, isolateErrorText } from '../../src/web/views/solutions-conflict.ts';

function session(name: string, isolated: boolean, attached = true): ConflictSession {
  return { sessionId: `id-${name}`, name, isolated, repo: 'web-front', attached };
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
        { sessionId: 'id-in-place', repo: 'web-front', label: 'Move in-place to worktree', disabled: false, title: '' },
        { sessionId: 'id-away', repo: 'web-front', label: 'Move away to worktree', disabled: true, title: 'away continues in a terminal; attach it here first' },
      ],
    });
  });

  it('the demo mobile row gives the prototype card verbatim', async () => {
    const { solutions } = createDemoProviders(await loadDemoData());
    const mobile = (await solutions.solutions()).flatMap((g) => g.solutions).find((s) => s.name === 'mobile');
    expect(mobile).toBeDefined();
    expect(conflictCard(mobile as Solution)).toEqual({
      text: "free-talk-feature and button-rollout both write to mobile/ in one working tree. Your AGENTS.md requires isolation: 'worktree' for parallel writers in the same repo.",
      actions: [{ sessionId: 'button-rollout', repo: 'mobile', label: 'Move button-rollout to worktree', disabled: false, title: '' }],
    });
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
