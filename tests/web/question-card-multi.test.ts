import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Question } from '../../src/core/api.ts';
import { joinAnswerItems, splitAnswerItems } from '../../src/core/multi-answer.ts';
import { parseDraftValue } from '../../src/core/drafts.ts';
import {
  ALL_ANSWERED,
  MULTI_HINT,
  answerBody,
  answeredLines,
  cancelOwn,
  confirmOwn,
  editOwn,
  initialPicks,
  isAnswered,
  questionCardView,
  toggleOption,
  toggleOther,
  typeOwn,
} from '../../src/web/components/question-card.ts';

/**
 * D128: a multi-select question takes one or more options plus, optionally, own
 * words alongside (docs/questions.md → *Multi-select answers*).
 */

const COMPONENT = '../../src/web/components/QuestionCard.tsx';

function question(id: string, text: string, labels: string[], multiSelect: boolean, answered: Partial<Question> = {}): Question {
  return {
    id,
    batchId: 'req-1',
    sessionId: 's1',
    source: 'web · microfrontends/acme-app-front',
    text,
    header: null,
    options: labels.map((label) => ({ label, description: `${label} option` })),
    multiSelect,
    state: 'open',
    answerIndex: null,
    answeredAt: null,
    ...answered,
  };
}

const PARTS = question('q1', 'Which parts should I update?', ['Code', 'Tests', 'Docs'], true);
const COLOR = question('q2', 'Which color should the button be?', ['Red', 'Green', 'Blue'], false);

describe('D128 · the CLI\'s multi-select answer string (src/core/multi-answer.ts)', () => {
  it('joins the items with ", " and writes an item holding ", " or a quote as a JSON string (the CLI 2.1.303 join)', () => {
    expect(joinAnswerItems(['Tests', 'Docs'])).toBe('Tests, Docs');
    expect(joinAnswerItems(['Tests'])).toBe('Tests');
    expect(joinAnswerItems(['Tests', 'Only the changelog, and the README'])).toBe('Tests, "Only the changelog, and the README"');
    expect(joinAnswerItems(['A "soft" shadow'])).toBe('"A \\"soft\\" shadow"');
    expect(joinAnswerItems(['a,b'])).toBe('a,b');
  });

  it('splits such a string back into its items (quoted items stay whole); anything else splits on ", "', () => {
    for (const items of [['Tests', 'Docs'], ['Tests', 'Only the changelog, and the README'], ['A "soft" shadow', 'Code'], ['x']]) {
      expect(splitAnswerItems(joinAnswerItems(items))).toEqual(items);
    }
    expect(splitAnswerItems('Medium, with rounded corners')).toEqual(['Medium', 'with rounded corners']);
    expect(splitAnswerItems('"unterminated, item')).toEqual(['"unterminated', 'item']);
    expect(splitAnswerItems('"a" b, c')).toEqual(['"a" b', 'c']);
    expect(splitAnswerItems('')).toEqual([]);
  });
});

describe('D128 · the card state for a multi-select question', () => {
  it('ticks and unticks options; Send enables once every question has at least one choice; several picks send answerIndexes', () => {
    const questions = [PARTS, COLOR];
    let picks = initialPicks(questions);
    picks = toggleOption(picks, 'q1', 2);
    picks = toggleOption(picks, 'q1', 1);
    expect(picks['q1']).toEqual({ indexes: [1, 2], own: null });
    expect(questionCardView(questions, picks)).toMatchObject({ status: '1 of 2 answered', allAnswered: false });
    picks = { ...picks, q2: 0 };
    expect(questionCardView(questions, picks)).toMatchObject({ status: ALL_ANSWERED, allAnswered: true });
    expect(answerBody(questions, picks)).toEqual({ answers: [{ questionId: 'q1', answerIndexes: [1, 2] }, { questionId: 'q2', answerIndex: 0 }] });
    // Unticking everything is no answer again.
    picks = toggleOption(toggleOption(picks, 'q1', 1), 'q1', 2);
    expect(picks['q1']).toBeUndefined();
    expect(answerBody(questions, picks)).toBeNull();
  });

  it('Other… is a checkbox alongside the options: its text joins the picks; a ticked Other… needs text; Esc unticks it and keeps the options', () => {
    let picks = toggleOption({}, 'q1', 0);
    picks = toggleOther(picks, 'q1');
    expect(picks['q1']).toEqual({ indexes: [0], own: { text: '', editing: true } });
    // A ticked but empty Other… does not count yet.
    expect(isAnswered(PARTS, picks)).toBe(false);
    picks = typeOwn(picks, 'q1', '  the changelog  ');
    expect(isAnswered(PARTS, picks)).toBe(true);
    picks = confirmOwn(picks, 'q1');
    expect(picks['q1']).toEqual({ indexes: [0], own: { text: '  the changelog  ', editing: false } });
    expect(answerBody([PARTS], picks)).toEqual({ answers: [{ questionId: 'q1', answerIndexes: [0], text: 'the changelog' }] });
    // Editing reopens the field with the text; ticking an option keeps the own answer.
    picks = editOwn(picks, 'q1');
    expect(picks['q1']).toEqual({ indexes: [0], own: { text: '  the changelog  ', editing: true } });
    picks = toggleOption(picks, 'q1', 2);
    expect(picks['q1']).toEqual({ indexes: [0, 2], own: { text: '  the changelog  ', editing: true } });
    // Esc: Other… unticked, the options stay.
    expect(cancelOwn(picks, 'q1')['q1']).toEqual({ indexes: [0, 2], own: null });
    // Unticking Other… drops the text.
    expect(toggleOther(picks, 'q1')['q1']).toEqual({ indexes: [0, 2], own: null });
    // Other… alone: Esc leaves no pick.
    expect(cancelOwn(toggleOther({}, 'q1'), 'q1')).toEqual({});
  });

  it('one option alone, or own words alone, keep the single shapes (an older paired machine takes them)', () => {
    expect(answerBody([PARTS], toggleOption({}, 'q1', 1))).toEqual({ answers: [{ questionId: 'q1', answerIndex: 1 }] });
    const own = typeOwn(toggleOther({}, 'q1'), 'q1', 'Only the changelog');
    expect(answerBody([PARTS], own)).toEqual({ answers: [{ questionId: 'q1', text: 'Only the changelog' }] });
  });

  it('single-select questions are unchanged: toggleOption is not used and picks stay an index', () => {
    const picks = initialPicks([COLOR]);
    expect(picks).toEqual({});
    expect(answerBody([COLOR], { q2: 2 })).toEqual({ answers: [{ questionId: 'q2', answerIndex: 2 }] });
  });

  it('a stored multi-select answer: picks from answerIndexes + answerText; the answered lines list every choice', () => {
    const answered = { ...PARTS, state: 'answered' as const, answerIndex: 1, answerIndexes: [1, 2], answerText: 'the changelog', answeredAt: 'x' };
    expect(initialPicks([answered])).toEqual({ q1: { indexes: [1, 2], own: { text: 'the changelog', editing: false } } });
    expect(answeredLines([answered])).toEqual(['web: Tests, Docs, the changelog']);
    expect(answeredLines([{ ...answered, answerIndexes: [0], answerText: null }])).toEqual(['web: Code']);
    // Before D128 (no answerIndexes): the one stored index or own answer.
    const older: Question = { ...PARTS, answerIndex: 0, answeredAt: 'x' };
    expect(initialPicks([older])).toEqual({ q1: { indexes: [0], own: null } });
    expect(answeredLines([{ ...older, answerIndexes: null }])).toEqual(['web: Code']);
  });

  it('the draft keeps a multi-select pick (ticked options and the own answer)', () => {
    const value = { picks: { q1: { indexes: [0, 2], own: { text: 'mine', editing: true } }, q2: 1 } };
    expect(parseDraftValue('question:req-1', value)).toEqual(value);
    expect(parseDraftValue('question:req-1', { picks: { q1: { indexes: [0, 'x'], own: null } } })).toBeNull();
  });
});

describe('D128 · the card markup', () => {
  it('a multi-select question shows "Choose any" and checkbox options (aria-checked), Other… a checkbox too; a single one stays as it was', async () => {
    const { QuestionCard } = (await import(/* @vite-ignore */ COMPONENT)) as { QuestionCard: (props: object) => unknown };
    const html = renderToStaticMarkup(createElement(QuestionCard as never, { questions: [PARTS, COLOR], variant: 'inbox', onSend: () => undefined }));
    expect(html.match(/data-testid="question-multi-hint"/g)).toHaveLength(1);
    expect(html).toContain(`>${MULTI_HINT}</div>`);
    expect(html.match(/role="checkbox"/g)).toHaveLength(4);
    expect(html).toContain('role="checkbox" class="sb-button sb-qcard__option sb-qcard__check" data-testid="question-option" data-selected="false" aria-checked="false"');
    expect(html).toContain('data-testid="question-other" data-selected="false" aria-checked="false"');
    // The single-select question keeps its pills (aria-pressed).
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(4);
    expect(html).toContain('data-multi="true"');

    const answered = renderToStaticMarkup(
      createElement(QuestionCard as never, {
        questions: [{ ...PARTS, state: 'answered', answerIndex: 1, answerIndexes: [1, 2], answerText: 'the changelog', answeredAt: 'x' }],
        variant: 'chat',
        onSend: () => undefined,
      }),
    );
    expect(answered.match(/aria-checked="true"/g)).toHaveLength(3);
    expect(answered).toContain('data-testid="question-own-answer" title="Edit your answer">the changelog</button>');
    expect(answered).toContain(ALL_ANSWERED);
  });
});
