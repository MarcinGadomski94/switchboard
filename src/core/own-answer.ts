/**
 * D39 (`docs/decisions.md` → *Own answers*): a question can be answered with the
 * developer's own words ("Other…"), as Claude Code's own "Other" does: the CLI
 * receives the typed text as the answer string. The pure rule shared by the
 * server (`POST /api/questions/batch/{id}/answers`) and the question card (what
 * counts as answered, the field's limit). `docs/questions.md` → *Own answers*.
 */

/** Longest own answer, in characters after trimming. */
export const OWN_ANSWER_MAX = 2000;

/** Why an own answer is refused (the 422 message on field `text`). */
export const OWN_ANSWER_RULE = `an own answer must be text of 1–${OWN_ANSWER_MAX} characters`;

/** Result of {@link checkOwnAnswer}: the trimmed text, or why it is refused. */
export type OwnAnswerCheck = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/** An own answer as the API takes it: text that is 1–{@link OWN_ANSWER_MAX} characters once trimmed. */
export function checkOwnAnswer(value: unknown): OwnAnswerCheck {
  if (typeof value !== 'string') return { ok: false, message: OWN_ANSWER_RULE };
  const text = value.trim();
  if (text.length === 0 || text.length > OWN_ANSWER_MAX) return { ok: false, message: OWN_ANSWER_RULE };
  return { ok: true, text };
}
