import type { Session } from '../../../core/api.ts';
import type { CliAccountChoice } from '../../api/account-choice-rows.ts';
import { ACCOUNT_CHOICE_WORDS as W } from '../glossary.ts';

/** D138 · the account picker's words as data (kept out of the components so the unit tests read them). */

/** The options of one CLI's select: Automatic, then its accounts ("out of usage" marked; it can still be chosen). */
export function choiceOptions(row: CliAccountChoice, automatic: string = W.automatic): Array<{ value: string; label: string }> {
  return [{ value: '', label: automatic }, ...row.options.map((o) => ({ value: o.id, label: o.out ? `${o.name} (${W.out})` : o.name }))];
}

/** D138: "Account: B (from project)" for an agent (its account name and where it comes from). */
export function accountLine(session: Pick<Session, 'profileName' | 'accountChoice'>): string {
  return W.line(session.profileName ?? 'Default', W.sources[session.accountChoice?.source ?? 'automatic']);
}

/** D138: the line's tooltip: which Project the account comes from. */
export function accountLineTitle(session: Pick<Session, 'accountChoice'>): string | undefined {
  const project = session.accountChoice?.project;
  return project ? `The account of the project “${project.title}”` : undefined;
}
