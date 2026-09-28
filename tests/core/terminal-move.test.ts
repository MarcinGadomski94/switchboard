import { describe, expect, it } from 'vitest';
import { MOVED_NAME_FALLBACK, SESSION_NAME_PATTERN, kebabName, movedSessionName, uniqueName } from '../../src/core/terminal-move.ts';
import { SESSION_NAME } from '../../src/server/sessions/validate.ts';

/** D16: the name a terminal conversation gets when it moves into Switchboard (`src/core/terminal-move.ts`). */
describe('moved session names (D16)', () => {
  it('kebab-cases a title or a prompt: words only, accents dropped, whole words up to 40 characters', () => {
    expect(kebabName('sb-tx-probe')).toBe('sb-tx-probe');
    expect(kebabName('Code word check')).toBe('code-word-check');
    expect(kebabName('/loop 1h Watch the build')).toBe('loop-1h-watch-the-build');
    expect(kebabName('Crème brûlée — ÜBER naïve!')).toBe('creme-brulee-uber-naive');
    expect(kebabName('Remember the code word: marigold. Then run exactly this Bash command')).toBe('remember-the-code-word-marigold-then-run');
    expect(kebabName('x'.repeat(50))).toBe('x'.repeat(40));
    expect(kebabName('日本語 ???')).toBe('');
    for (const text of ['A B', '--a--b--', 'Fix it.', '/loop 1h']) expect(SESSION_NAME.test(kebabName(text))).toBe(true);
  });

  it('title (custom, else AI) → first prompt → first command → the fallback, then made unique', () => {
    const none = new Set<string>();
    expect(movedSessionName({ customTitle: 'My Title', aiTitle: 'AI', firstPrompt: 'Prompt' }, none)).toBe('my-title');
    expect(movedSessionName({ customTitle: null, aiTitle: 'AI named', firstPrompt: 'Prompt' }, none)).toBe('ai-named');
    expect(movedSessionName({ customTitle: '???', firstPrompt: 'Fix the login page' }, none)).toBe('fix-the-login-page');
    expect(movedSessionName({ firstPrompt: null, firstCommand: '/loop 1h Watch' }, none)).toBe('loop-1h-watch');
    expect(movedSessionName({}, none)).toBe(MOVED_NAME_FALLBACK);
    expect(movedSessionName({ customTitle: 'sb-handoff' }, new Set(['sb-handoff', 'sb-handoff-2']))).toBe('sb-handoff-3');
    expect(uniqueName('a', new Set())).toBe('a');
    expect(uniqueName('a', new Set(['a']))).toBe('a-2');
  });

  it('the UI pattern is the server rule', () => {
    expect(SESSION_NAME_PATTERN.source).toBe(SESSION_NAME.source);
  });
});
