import { describe, expect, it } from 'vitest';
import { type TurnWait, DETECTED_ASK_MAX, detectWaiting, effectiveSessionStatus, turnEndWait, turnWaits } from '../../src/core/derive/turn-status.ts';

/**
 * D124 oracle (`docs/derivations.md` → *Session status* → *Waiting for you at a turn's end*):
 * the text check of a turn's last assistant text, the precedence of the agent's own
 * `turn_status` over it, and the status a session reads.
 */

/** The developer's own example (2026-10-21), with placeholders for its names. */
const DEVELOPER_EXAMPLE =
  "So today I'd: You: publish workspace 42. Me: build the Acme tag workspace (triggers, variables, the consent mode) and hand you the import file. Two of my questions are still open: who creates the analytics dimension for the plan tier, and whether you run Globex or Initech ads.";

const WAITING: ReadonlyArray<readonly [string, string, string]> = [
  ['the developer example (a "You:" item, "questions are still open")', DEVELOPER_EXAMPLE, 'Two of my questions are still open: who creates the analytics dimension for the plan tier, and whether you run Globex or Initech ads.'],
  ['ends with a question', 'I pushed the branch and opened PR #42.\n\nShould I merge it once the checks are green?', 'Should I merge it once the checks are green?'],
  ['a question with closing emphasis', 'The fix is ready. **Do you want the migration in the same PR?**', 'Do you want the migration in the same PR?'],
  ['"let me know" without a question mark', 'Two options: A keeps the cache, B drops it. Let me know which one you want.', 'Let me know which one you want.'],
  ['"your call"', 'Both approaches work; the second is faster but touches the schema. Your call.', 'Your call.'],
  ['"need you to"', 'Deployment is blocked: I need you to approve the production environment in the portal.', 'Deployment is blocked: I need you to approve the production environment in the portal.'],
  ['"waiting on you"', 'Everything is staged. Waiting on you to rotate the token.', 'Waiting on you to rotate the token.'],
  ['"once you"', 'I prepared the release notes. Once you tag 2.0 I will publish them.', 'Once you tag 2.0 I will publish them.'],
  ['"please confirm"', 'The plan is in the artifact. Please confirm the scope before I start.', 'Please confirm the scope before I start.'],
  ['a "You:" list item', 'Next steps:\n- Me: write the tests\n- You: merge PR #12', 'You: merge PR #12'],
  ['an earlier question wins the ask', 'Which database should the import use? I can start with the staging copy meanwhile; tell me.', 'Which database should the import use?'],
  ['the question after a done guard', 'All done. Want me to also open the PR?', 'Want me to also open the PR?'],
];

const DONE: ReadonlyArray<readonly [string, string]> = [
  ['a plain summary', 'Implemented the retry in the uploader and added two tests. Typecheck and the suite pass. Committed as "Retry uploads on 503".'],
  ['ends with Done.', 'Updated the three call sites and the docs. Done.'],
  ['"no action needed"', 'The flaky test was a race in the fixture; fixed and pushed. No action needed from you.'],
  ['a polite closer', 'Refactored the parser into two functions and kept the behaviour. All 48 tests pass.\n\nLet me know if you need anything else.'],
  ['"nothing left"', 'Merged both PRs and closed the ticket. Nothing left on my side.'],
  ['a question inside a code block', 'Added the helper:\n```ts\nconst x = a ? b : c; // why?\n```\nThe build is green.'],
  ['a question mark in a URL', 'Opened https://example.test/pr?id=42 and it is merged.'],
  ['a guard over an asking phrase', 'Shipped. Should I have waited for review? It was approved already, so nothing is waiting on you.'],
  ['empty', ''],
];

describe('detectWaiting (the text check)', () => {
  for (const [name, text, ask] of WAITING) {
    it(`waiting: ${name}`, () => {
      expect(detectWaiting(text)).toEqual({ ask });
    });
  }
  for (const [name, text] of DONE) {
    it(`done: ${name}`, () => {
      expect(detectWaiting(text)).toBeNull();
    });
  }

  it('reads only the last 600 characters', () => {
    const early = `Should I keep the old API? ${'Then I rewrote the module and the tests pass. '.repeat(20)}`;
    expect(detectWaiting(early)).toBeNull();
  });

  it(`cuts the ask to ${DETECTED_ASK_MAX} characters`, () => {
    const long = `Can you confirm ${'the very long list of things '.repeat(20)}?`;
    const ask = detectWaiting(long)?.ask ?? '';
    expect(ask.length).toBeLessThanOrEqual(DETECTED_ASK_MAX);
    expect(ask.length).toBeGreaterThan(DETECTED_ASK_MAX - 5);
    expect(ask.endsWith('…')).toBe(true);
  });
});

describe('turnEndWait (declaration beats the text check, both ways)', () => {
  const at = '2026-10-21T10:00:00.000Z';
  const declared = (status: TurnWait['status'], ask: string | null): TurnWait => ({ status, ask, source: 'declared', at: '2026-10-21T09:59:00.000Z' });

  it('a declared waiting_for_you wins over a done-looking text', () => {
    expect(turnEndWait({ declared: declared('waiting_for_you', 'Pick A or B'), text: 'All done.', outcome: 'success', at })).toEqual(declared('waiting_for_you', 'Pick A or B'));
  });
  it('a declared done wins over a question-looking text', () => {
    const wait = turnEndWait({ declared: declared('done', null), text: 'Shall I go on?', outcome: 'success', at });
    expect(wait?.status).toBe('done');
    expect(turnWaits(wait)).toBe(false);
  });
  it('without a declaration the text check decides', () => {
    expect(turnEndWait({ declared: null, text: 'Shall I go on?', outcome: 'success', at })).toEqual({ status: 'waiting_for_you', ask: 'Shall I go on?', source: 'detected', at });
    expect(turnEndWait({ declared: null, text: 'Done.', outcome: 'success', at })).toBeNull();
  });
  it('an error or a stopped turn is not text-checked', () => {
    expect(turnEndWait({ declared: null, text: 'Shall I go on?', outcome: 'error', at })).toBeNull();
    expect(turnEndWait({ declared: null, text: 'Shall I go on?', outcome: 'stopped', at })).toBeNull();
  });
});

describe('effectiveSessionStatus (working beats need)', () => {
  const waiting: TurnWait = { status: 'blocked', ask: 'Re-run the CI job', source: 'declared', at: '2026-10-21T10:00:00.000Z' };
  it('a turn over and not working reads need', () => {
    expect(effectiveSessionStatus('done', waiting)).toBe('need');
    expect(effectiveSessionStatus('idle', waiting)).toBe('need');
    expect(effectiveSessionStatus('paused', waiting)).toBe('need');
  });
  it('working (subagents, background waits: run) stays run; fail stays fail; need stays need', () => {
    expect(effectiveSessionStatus('run', waiting)).toBe('run');
    expect(effectiveSessionStatus('fail', waiting)).toBe('fail');
    expect(effectiveSessionStatus('need', waiting)).toBe('need');
  });
  it('done, none or closed changes nothing', () => {
    expect(effectiveSessionStatus('done', { ...waiting, status: 'done', ask: null })).toBe('done');
    expect(effectiveSessionStatus('done', null)).toBe('done');
    expect(effectiveSessionStatus('done', waiting, true)).toBe('done');
  });
});
