/**
 * D180 · what the side panel's Changes shows: one of the Diff's own views (D90, with D174's For
 * review), or what one turn changed (`src/core/turn-changes.ts`). Pure.
 */
import type { DiffScope } from '../../../core/api.ts';
import { type TurnChange, turnsLabel } from '../../../core/turn-changes.ts';

export type ChangesView = { readonly kind: 'scope' } | { readonly kind: 'turn'; readonly change: TurnChange };

/** One choice of the panel's view picker. */
export interface ViewChoice {
  /** `turn`, `last`, or a {@link DiffScope}. */
  readonly value: string;
  readonly label: string;
}

export const LAST_TURN_LABEL = 'Last turn';

/**
 * The view picker, in order: a picked turn (when it is not the last one), "Last turn"
 * (`last`: what the last turn changed, when it changed something), then the Diff's own views
 * as `scopeOptions` offers them (For review first while a review is pending, then Since last
 * save point, Whole separate copy, All unsaved), named by `words`.
 */
export function viewChoices(view: ChangesView, scopes: readonly DiffScope[], words: Readonly<Record<DiffScope, string>>, last: TurnChange | null = null): ViewChoice[] {
  const choices: ViewChoice[] = [];
  if (view.kind === 'turn' && (last === null || view.change.turn !== last.turn)) choices.push({ value: 'turn', label: turnsLabel(view.change.turn, view.change.through) });
  if (last !== null) choices.push({ value: 'last', label: LAST_TURN_LABEL });
  for (const scope of scopes) choices.push({ value: scope, label: words[scope] });
  return choices;
}

/** Which of {@link viewChoices} is shown now (`scope`: the Diff's own view). */
export function shownChoice(view: ChangesView, scope: DiffScope, last: TurnChange | null): string {
  if (view.kind === 'turn') return last !== null && view.change.turn === last.turn ? 'last' : 'turn';
  return scope;
}

/** Names what the panel fetches: another key is another diff. */
export function viewKey(view: ChangesView, scope: DiffScope): string {
  return view.kind === 'turn' ? `turn:${view.change.turn}` : `scope:${scope}`;
}
