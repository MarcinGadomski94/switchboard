import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AnswerBatch, Question } from '../../src/core/api.ts';
import {
  ALL_ANSWERED,
  answerBody,
  answeredLines,
  initialPicks,
  isAnswered,
  pick,
  questionCardView,
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
    expect(html).toContain('0 of 2 answered');
    expect(html).toMatch(/data-testid="question-send" disabled="" style="opacity:0.45">Send all answers</);

    const chat = renderToStaticMarkup(createElement(QuestionCard as never, { questions: TWO.map((q) => ({ ...q, answerIndex: 0, answeredAt: 'x' })), variant: 'chat', onSend: () => undefined }));
    expect(chat).toContain('class="sb-qcard sb-qcard--chat"');
    expect(chat.match(/data-selected="true"/g)).toHaveLength(2);
    expect(chat).toContain(ALL_ANSWERED);
    // An answered batch stays read-only.
    expect(chat).toMatch(/data-testid="question-send" disabled="" style="opacity:1">/);
  });
});
