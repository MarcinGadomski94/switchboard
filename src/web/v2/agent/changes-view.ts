/**
 * SPIKE · what the side panel's Changes shows: one of the Diff's own views (D90), the
 * changes since the last review (D166), or what one turn changed
 * (`src/core/turn-changes.ts`). Pure.
 */
import type { DiffScope } from '../../../core/api.ts';
import { type TurnChange, turnsLabel } from '../../../core/turn-changes.ts';

export type ChangesView = { readonly kind: 'scope' } | { readonly kind: 'review' } | { readonly kind: 'turn'; readonly change: TurnChange };

/** One choice of the panel's view switch. */
export interface ViewChoice {
  /** `turn`, `review`, or a {@link DiffScope}. */
  readonly value: string;
  readonly label: string;
}

export const REVIEW_VIEW_LABEL = 'Since your review';
export const LAST_TURN_LABEL = 'Last turn';

/** The view shown: "Since your review" needs a pending review with a save point (`reviewFrom`), else the Diff's own view shows. */
export function shownView(view: ChangesView, reviewFrom: number | null): ChangesView {
  return view.kind === 'review' && reviewFrom === null ? { kind: 'scope' } : view;
}

/**
 * The view picker, in order: a picked turn (when it is not the last one), "Last turn"
 * (`last`: what the last turn changed, when it changed something), "Since your review"
 * while a review is pending, then the Diff's own views (`scopes`, named by `words`).
 */
export function viewChoices(view: ChangesView, reviewFrom: number | null, scopes: readonly DiffScope[], words: Readonly<Record<DiffScope, string>>, last: TurnChange | null = null): ViewChoice[] {
  const choices: ViewChoice[] = [];
  if (view.kind === 'turn' && (last === null || view.change.turn !== last.turn)) choices.push({ value: 'turn', label: turnsLabel(view.change.turn, view.change.through) });
  if (last !== null) choices.push({ value: 'last', label: LAST_TURN_LABEL });
  if (reviewFrom !== null) choices.push({ value: 'review', label: REVIEW_VIEW_LABEL });
  for (const scope of scopes) choices.push({ value: scope, label: words[scope] });
  return choices;
}

/** Which of {@link viewChoices} is shown now (`view` as {@link shownView} gives it, `scope` the Diff's own view). */
export function shownChoice(view: ChangesView, scope: DiffScope, last: TurnChange | null): string {
  if (view.kind === 'turn') return last !== null && view.change.turn === last.turn ? 'last' : 'turn';
  return view.kind === 'review' ? 'review' : scope;
}

/** Names what the panel fetches: another key is another diff. */
export function viewKey(view: ChangesView, reviewFrom: number | null, scope: DiffScope): string {
  const shown = shownView(view, reviewFrom);
  if (shown.kind === 'turn') return `turn:${shown.change.turn}`;
  if (shown.kind === 'review') return `review:${reviewFrom}`;
  return `scope:${scope}`;
}
