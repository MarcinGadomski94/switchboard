import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AnswerBatch, Question } from '../../src/core/api.ts';
import {
  ALL_ANSWERED,
  OTHER_LABEL,
  answerBody,
  answeredLines,
  cancelOwn,
  confirmOwn,
  initialPicks,
  isAnswered,
  ownAnswerKeyAction,
  pick,
  pickOther,
  questionCardView,
  typeOwn,
} from '../../src/web/components/question-card.ts';

/** The component module, imported at run time (the server tsconfig has no JSX; Vitest transforms it). */
const COMPONENT = '../../src/web/components/QuestionCard.tsx';

function question(id: string, text: string, labels: string[], answerIndex: number | null = null): Question {
  return {
    id,
    batchId: 'req-1',
    sessionId: 's1',
    source: 'orchestrator',
    text,
    header: null,
    options: labels.map((label) => ({ label, description: `${label} option` })),
    multiSelect: false,
    state: 'open',
    answerIndex,
    answeredAt: answerIndex === null ? null : '2026-09-28T00:00:00.000Z',
  };
}

const TWO = [question('q1', 'Which color should the button be?', ['Red', 'Green', 'Blue']), question('q2', 'Which size should it be?', ['Small', 'Large'])];

describe('QuestionCard state (src/web/components/question-card.ts, prototype card())', () => {
  it('counts answers, keeps Send at 45% until every question is answered, then gives the contract body in question order', () => {
    let picks = initialPicks(TWO);
    expect(questionCardView(TWO, picks)).toEqual({
      head: '2 questions · relayed verbatim',
      status: '0 of 2 answered',
      label: 'Send all answers',
      answered: 0,
      allAnswered: false,
      sendOpacity: 0.45,
    });
    expect(answerBody(TWO, picks)).toBeNull();
    picks = pick(picks, 'q2', 1);
    expect(questionCardView(TWO, picks)).toMatchObject({ status: '1 of 2 answered', sendOpacity: 0.45, allAnswered: false });
    expect(answerBody(TWO, picks)).toBeNull();
    picks = pick(picks, 'q1', 0);
    picks = pick(picks, 'q1', 1);
    expect(questionCardView(TWO, picks)).toMatchObject({ status: ALL_ANSWERED, sendOpacity: 1, allAnswered: true, answered: 2 });
    const body: AnswerBatch | null = answerBody(TWO, picks);
    expect(body).toEqual({ answers: [{ questionId: 'q1', answerIndex: 1 }, { questionId: 'q2', answerIndex: 1 }] });
  });

  it('one question: singular copy; out-of-range picks do not count; stored answers are the initial picks', () => {
    const one = [question('q1', 'Which environment should I target?', ['Staging', 'Production'])];
    expect(questionCardView(one, {})).toMatchObject({ head: '1 question · relayed verbatim', label: 'Send answer', status: '0 of 1 answered' });
    expect(isAnswered(one[0]!, { q1: 2 })).toBe(false);
    expect(isAnswered(one[0]!, { q1: 1 })).toBe(true);
    expect(initialPicks([question('q1', 'Q?', ['a', 'b'], 1)])).toEqual({ q1: 1 });
    expect(questionCardView([], {})).toMatchObject({ allAnswered: false, head: '0 questions · relayed verbatim' });
  });

  it('answered bubble lines: <source>: <label>', () => {
    expect(answeredLines([question('q1', 'A?', ['x', 'y'], 1), question('q2', 'B?', ['z'])])).toEqual(['orchestrator: y', 'orchestrator: —']);
  });

  it('D39: Other… opens an own answer; empty or blank text does not count, text does (trimmed, ≤ 2000); Send gets { questionId, text }', () => {
    let picks = pick(initialPicks(TWO), 'q1', 2);
    picks = pickOther(picks, 'q2');
    expect(picks['q2']).toEqual({ text: '', editing: true });
    expect(isAnswered(TWO[1]!, picks)).toBe(false);
    expect(questionCardView(TWO, picks)).toMatchObject({ status: '1 of 2 answered', allAnswered: false, sendOpacity: 0.45 });
    expect(answerBody(TWO, picks)).toBeNull();

    picks = typeOwn(picks, 'q2', '   \n ');
    expect(questionCardView(TWO, picks)).toMatchObject({ status: '1 of 2 answered', allAnswered: false });
    picks = typeOwn(picks, 'q2', 'x'.repeat(2001));
    expect(isAnswered(TWO[1]!, picks)).toBe(false);

    picks = typeOwn(picks, 'q2', '  Medium,\nwith rounded corners ');
    expect(picks['q2']).toEqual({ text: '  Medium,\nwith rounded corners ', editing: true });
    expect(questionCardView(TWO, picks)).toMatchObject({ status: ALL_ANSWERED, allAnswered: true, answered: 2, sendOpacity: 1 });
    expect(answerBody(TWO, picks)).toEqual({ answers: [{ questionId: 'q1', answerIndex: 2 }, { questionId: 'q2', text: 'Medium,\nwith rounded corners' }] });

    // Enter confirms (the field closes onto the text); the text still counts.
    picks = confirmOwn(picks, 'q2');
    expect(picks['q2']).toEqual({ text: '  Medium,\nwith rounded corners ', editing: false });
    expect(questionCardView(TWO, picks).allAnswered).toBe(true);
    // Other… again reopens the field with the text kept.
    expect(pickOther(picks, 'q2')['q2']).toEqual({ text: '  Medium,\nwith rounded corners ', editing: true });
    // An option replaces the own answer; Other… afterwards starts empty.
    const option = pick(picks, 'q2', 0);
    expect(option['q2']).toBe(0);
    expect(pickOther(option, 'q2')['q2']).toEqual({ text: '', editing: true });
  });

  it('D39: Enter on an empty field changes nothing; Esc cancels back to no pick', () => {
    const open = pickOther({ q1: 1 }, 'q2');
    expect(confirmOwn(open, 'q2')).toBe(open);
    expect(confirmOwn(typeOwn(open, 'q2', '  '), 'q2')['q2']).toEqual({ text: '  ', editing: true });
    expect(confirmOwn({ q1: 1 }, 'q1')).toEqual({ q1: 1 });
    const typed = typeOwn(open, 'q2', 'mine');
    expect(cancelOwn(typed, 'q2')).toEqual({ q1: 1 });
    expect(questionCardView(TWO, cancelOwn(typed, 'q2'))).toMatchObject({ status: '1 of 2 answered' });
    expect(ownAnswerKeyAction({ key: 'Enter', shiftKey: false, isComposing: false })).toBe('confirm');
    expect(ownAnswerKeyAction({ key: 'Enter', shiftKey: true, isComposing: false })).toBeNull();
    expect(ownAnswerKeyAction({ key: 'Enter', shiftKey: false, isComposing: true })).toBeNull();
    expect(ownAnswerKeyAction({ key: 'Escape', shiftKey: false, isComposing: false })).toBe('cancel');
    expect(ownAnswerKeyAction({ key: 'Escape', shiftKey: false, isComposing: true })).toBeNull();
    expect(ownAnswerKeyAction({ key: 'a', shiftKey: false, isComposing: false })).toBeNull();
  });

  it('D39: a stored own answer is the initial pick (confirmed) and shows verbatim in the answers bubble', () => {
    const own = { ...question('q2', 'B?', ['z']), answerIndex: null, answerText: 'My own\nwords, verbatim', answeredAt: '2026-09-28T00:00:00.000Z' };
    expect(initialPicks([question('q1', 'A?', ['x', 'y'], 1), own])).toEqual({ q1: 1, q2: { text: 'My own\nwords, verbatim', editing: false } });
    expect(answeredLines([question('q1', 'A?', ['x', 'y'], 1), own])).toEqual(['orchestrator: y', 'orchestrator: My own\nwords, verbatim']);
    // answerText null / absent (older payloads) keeps the option rules.
    expect(answeredLines([{ ...question('q3', 'C?', ['a']), answerText: null }])).toEqual(['orchestrator: —']);
  });
});

describe('QuestionCard markup (src/web/components/QuestionCard.tsx)', () => {
  it('renders source, the verbatim quote in “…”, option pills and a disabled Send until everything is answered', async () => {
    const { QuestionCard } = (await import(/* @vite-ignore */ COMPONENT)) as { QuestionCard: (props: object) => unknown };
    const html = renderToStaticMarkup(createElement(QuestionCard as never, { questions: TWO, onSend: () => undefined }));
    expect(html).toContain('class="sb-qcard sb-qcard--inbox"');
    expect(html).toContain('data-batch-id="req-1"');
    expect(html).toContain('<div class="sb-qcard__head">2 questions · relayed verbatim</div>');
    expect(html).toContain('<div class="sb-qcard__source">orchestrator</div>');
    expect(html).toContain('<div class="sb-qcard__quote">“Which color should the button be?”</div>');
    expect(html.match(/data-testid="question-option"/g)).toHaveLength(5);
    expect(html).toContain('title="Green option"');
    // D39: each question ends with an Other… pill styled like the options; no field until it is picked.
    expect(html.match(/data-testid="question-other"/g)).toHaveLength(2);
    expect(html).toMatch(new RegExp(`class="sb-button sb-qcard__option sb-qcard__other" data-testid="question-other" data-selected="false" aria-pressed="false" aria-expanded="false" title="Answer in your own words">${OTHER_LABEL}</button></div></div>`));
    expect(html).not.toContain('question-own-input');
    expect(html).not.toContain('question-own-answer');
    expect(html).toContain('0 of 2 answered');
    expect(html).toMatch(/data-testid="question-send" disabled="" style="opacity:0.45">Send all answers</);

    const chat = renderToStaticMarkup(createElement(QuestionCard as never, { questions: TWO.map((q) => ({ ...q, answerIndex: 0, answeredAt: 'x' })), variant: 'chat', onSend: () => undefined }));
    expect(chat).toContain('class="sb-qcard sb-qcard--chat"');
    expect(chat.match(/data-selected="true"/g)).toHaveLength(2);
    expect(chat).toContain(ALL_ANSWERED);
    // An answered batch stays read-only.
    expect(chat).toMatch(/data-testid="question-send" disabled="" style="opacity:1">/);

    // D39: a stored own answer: Other… selected, the text verbatim under the options, no field.
    const own = renderToStaticMarkup(
      createElement(QuestionCard as never, {
        questions: [{ ...TWO[0]!, answerIndex: 2, answeredAt: 'x' }, { ...TWO[1]!, answerIndex: null, answerText: 'Medium & <round>', answeredAt: 'x' }],
        variant: 'chat',
        onSend: () => undefined,
      }),
    );
    expect(own).toContain('data-testid="question-other" data-selected="true" aria-pressed="true" aria-expanded="false"');
    expect(own).toContain('data-testid="question-own-answer" title="Edit your answer">Medium &amp; &lt;round&gt;</button>');
    expect(own).not.toContain('question-own-input');
    expect(own).toContain(ALL_ANSWERED);
  });

  it('D36: with a note (a subagent\'s own chat) the card is read-only: the note in the footer, no Send, the options not pickable', async () => {
    const { QuestionCard } = (await import(/* @vite-ignore */ COMPONENT)) as { QuestionCard: (props: object) => unknown };
    const html = renderToStaticMarkup(createElement(QuestionCard as never, { questions: TWO, variant: 'chat', note: 'Answer in the main chat or the Inbox', onSend: () => undefined }));
    expect(html).toContain('class="sb-qcard sb-qcard--chat sb-qcard--readonly"');
    expect(html).toContain('data-read-only="true"');
    expect(html).toContain('<span class="sb-qcard__status" data-testid="question-note">Answer in the main chat or the Inbox</span>');
    expect(html).not.toContain('data-testid="question-send"');
    expect(html).not.toContain('data-testid="question-status"');
    // The five options and the two Other… pills.
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(7);
    // The questions still read verbatim.
    expect(html).toContain('<div class="sb-qcard__quote">“Which size should it be?”</div>');
  });
});
